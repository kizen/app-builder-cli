import type { Dispatch, SetStateAction } from 'react';
import type { ValidationIssue } from '@kizenapps/packager';
import type { AuthFlags } from '../lib/authSelection.js';
import {
  apiFailure,
  headlessWriteGate,
  resolveCredentials,
  type CommandChoice,
  type CommandDeps,
  type CommandFailure,
  type ResolvedCredentials,
  type WriteGateFlags,
} from '../lib/commandCore.js';
import type { Credentials, Environment } from '../lib/credentials.js';
import { quoteArg } from '../lib/shellArg.js';
import type { ErrorView } from './ErrorFrame.js';

export type Setter<T> = Dispatch<SetStateAction<T>>;

export interface Session {
  credentials: Pick<Credentials, 'environment' | 'businessId'> | null;
  credentialNotices: string[];
  warnings: ValidationIssue[];
  notices: string[];
}

export const EMPTY_SESSION: Session = {
  credentials: null,
  credentialNotices: [],
  warnings: [],
  notices: [],
};

export const addNotices =
  (notices: readonly string[]) =>
  (session: Session): Session =>
    notices.length === 0 ? session : { ...session, notices: [...session.notices, ...notices] };

export interface EnvironmentSelectPhase<TOptions> {
  type: 'environment-select';
  options: TOptions;
  choices: CommandChoice[];
}

export type SessionPhase<TOptions> =
  | { type: 'loading'; label: string }
  | EnvironmentSelectPhase<TOptions>
  | { type: 'error'; view: ErrorView };

export const LOADING_CREDENTIALS = 'Loading credentials…';

export const DRY_RUN_TITLE = 'Dry run: nothing was written.';

export type FailureView = ErrorView & Pick<CommandFailure, 'login'>;

export function forPerson(view: FailureView): ErrorView {
  if (view.login === undefined) {
    return view;
  }

  const { login, ...rest } = view;

  return { ...rest, hint: `Sign in with: ${login.argv.map(quoteArg).join(' ')}` };
}

export interface SessionStep<TOptions> {
  load: (options: TOptions) => Promise<void>;
  pickEnvironment: (
    phase: EnvironmentSelectPhase<TOptions>,
    choice: CommandChoice,
  ) => Promise<void>;
  fail: (view: FailureView) => void;
  guard: (task: () => Promise<void>) => void;
  abort: () => void;
  isAborted: () => boolean;
  whileRunning: <T>(set: (value: T) => void) => (value: T) => void;
}

export interface SessionStepArgs<TOptions> {
  deps: CommandDeps;
  setPhase: (phase: SessionPhase<TOptions>) => void;
  setSession: Setter<Session>;
  next: (options: TOptions, resolved: ResolvedCredentials) => Promise<void>;
  toView?: (error: unknown) => FailureView;
  present?: (view: FailureView) => ErrorView;
}

export function createSessionStep<TOptions extends AuthFlags>({
  deps,
  setPhase,
  setSession,
  next,
  toView = apiFailure,
  present = (view) => view,
}: SessionStepArgs<TOptions>): SessionStep<TOptions> {
  let aborted = false;
  const whileRunning =
    <T>(set: (value: T) => void) =>
    (value: T): void => {
      if (!aborted) {
        set(value);
      }
    };

  const showPhase = whileRunning(setPhase);
  const showSession = whileRunning(setSession);

  const fail = (view: FailureView): void => {
    if (aborted) {
      return;
    }

    deps.setExitCode(1);
    showPhase({ type: 'error', view: present(view) });
  };

  const load = async (options: TOptions): Promise<void> => {
    showPhase({ type: 'loading', label: LOADING_CREDENTIALS });

    const step = await resolveCredentials(options, deps);

    if (aborted) {
      return;
    }

    if (!step.ok) {
      if (step.choice === 'environment' && step.choices) {
        showPhase({ type: 'environment-select', options, choices: step.choices });

        return;
      }

      fail(step);

      return;
    }

    const { environment, businessId } = step.value.credentials;

    showSession((session: Session) => ({
      ...session,
      credentials: { environment, businessId },
      credentialNotices: step.value.notices,
    }));
    await next(options, step.value);
  };

  return {
    load,
    pickEnvironment: (phase, choice) => load({ ...phase.options, env: choice.value }),
    fail,
    guard: (task) => {
      task().catch((error: unknown) => {
        fail(toView(error));
      });
    },
    abort: () => {
      aborted = true;
    },
    isAborted: () => aborted,
    whileRunning,
  };
}

export function interrupt(abort: () => void, setExitCode: (code: number) => void): void {
  abort();
  setExitCode(130);
}

export function writeDecision(
  options: WriteGateFlags,
  environment: Environment,
): 'dry-run' | 'apply' | 'confirm' {
  if (options.dryRun) {
    return 'dry-run';
  }

  if (options.yes) {
    const gate = headlessWriteGate(options, environment);

    if (gate.ok && gate.value.kind === 'apply') {
      return 'apply';
    }
  }

  return 'confirm';
}
