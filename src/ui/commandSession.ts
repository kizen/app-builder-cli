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

/**
 * The steps every interactive command that signs in shares, free of ink: resolving the account
 * (asking for the environment when several are signed in), the header it shows (`Session`,
 * rendered by `SessionFrame`), failing into an error phase, and whether a write asks first.
 */

export type Setter<T> = Dispatch<SetStateAction<T>>;

/** What the header above every step shows. */
export interface Session {
  /** Where the command writes; never the user id or an API key. */
  credentials: Pick<Credentials, 'environment' | 'businessId'> | null;
  /** Notices about how the command signed in, such as an ignored profile pin. */
  credentialNotices: string[];
  /** Validation warnings from packaging (errors fail instead). */
  warnings: ValidationIssue[];
  notices: string[];
}

export const EMPTY_SESSION: Session = {
  credentials: null,
  credentialNotices: [],
  warnings: [],
  notices: [],
};

/** Appends `notices` to the session's; a no-op update for none. */
export const addNotices =
  (notices: readonly string[]) =>
  (session: Session): Session =>
    notices.length === 0 ? session : { ...session, notices: [...session.notices, ...notices] };

export interface EnvironmentSelectPhase<TOptions> {
  type: 'environment-select';
  options: TOptions;
  choices: CommandChoice[];
}

/** The phases the session step moves through; every command's phase union includes them. */
export type SessionPhase<TOptions> =
  | { type: 'loading'; label: string }
  | EnvironmentSelectPhase<TOptions>
  | { type: 'error'; view: ErrorView };

export const LOADING_CREDENTIALS = 'Loading credentials…';

/** The headline of a `--dry-run` at a terminal. */
export const DRY_RUN_TITLE = 'Dry run: nothing was written.';

/** What a step fails with: an `ErrorView`, and for `not_signed_in` the login command. */
export type FailureView = ErrorView & Pick<CommandFailure, 'login'>;

/**
 * A failure for the person at the terminal: `not_signed_in`'s hint, written for an agent relaying
 * the login, becomes the login command to run.
 */
export function forPerson(view: FailureView): ErrorView {
  if (view.login === undefined) {
    return view;
  }

  const { login, ...rest } = view;

  return { ...rest, hint: `Sign in with: ${login.argv.map(quoteArg).join(' ')}` };
}

export interface SessionStep<TOptions> {
  /** Signs in for `options`, then hands the account to the command's next step. */
  load: (options: TOptions) => Promise<void>;
  /** Signs in again with the environment the person picked. */
  pickEnvironment: (
    phase: EnvironmentSelectPhase<TOptions>,
    choice: CommandChoice,
  ) => Promise<void>;
  /** Exit code 1 and the error phase. */
  fail: (view: FailureView) => void;
  /** Runs a step, failing with `toView(error)` if it throws. */
  guard: (task: () => Promise<void>) => void;
  /**
   * Ctrl+C: from now on the flow shows nothing, starts no write (each write step checks
   * `isAborted` first) and never sets an exit code, so the 130 `interrupt` sets stays. A request
   * already sent can't be taken back: one in flight when Ctrl+C lands still completes on the server.
   */
  abort: () => void;
  isAborted: () => boolean;
  /** `set`, ignored once aborted: the flow's own phase setter goes through this. */
  whileRunning: <T>(set: (value: T) => void) => (value: T) => void;
}

export interface SessionStepArgs<TOptions> {
  deps: CommandDeps;
  setPhase: (phase: SessionPhase<TOptions>) => void;
  setSession: Setter<Session>;
  /** The command's step after signing in. */
  next: (options: TOptions, resolved: ResolvedCredentials) => Promise<void>;
  /** Maps a thrown error to what the error phase shows; `apiFailure` by default. */
  toView?: (error: unknown) => FailureView;
  /** How every failure is shown, the session step's own included; as is by default. */
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

    // The header shows only where the command writes; it never holds the user id or an API key.
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

/** Ctrl+C before a command finished: stop the flow first, then exit 130. */
export function interrupt(abort: () => void, setExitCode: (code: number) => void): void {
  abort();
  setExitCode(130);
}

/**
 * What a write does at a terminal: `--dry-run` only shows it; `--yes` writes without asking when
 * the headless gate would (so production still needs --allow-production); otherwise it asks, with
 * the strict production prompt on go/fmo (`ProductionConfirm`).
 */
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
