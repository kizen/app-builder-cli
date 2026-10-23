/**
 * `appbuilder admin`: runs the Python `kizen` CLI (from the venv `kizenVenv.ts` provisions) with
 * app-builder's OAuth session. kizen's side of the contract is kizen-admin-cli's
 * `docs/operating.md` §1: `KIZEN_AUTH_HELPER` is a command kizen runs (split with `shlex.split`,
 * no shell) whenever it needs `{"Authorization":"Bearer …"}`, so the token itself never reaches
 * kizen's environment or argv.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { constants } from 'node:os';
import { apiOriginFor } from '../../shared/lib/kizenUrls.js';
import type { AccountFlags } from './authSelection.js';
import type { Environment } from './credentials.js';
import { errorMessage } from './guards.js';
import type { KizenInstall } from './kizenVenv.js';
import { loginRequired } from './oauth.js';
import {
  resolveAccountEnvironment,
  requireAccountRequest,
  requireNamedAccount,
} from './oauthCommands.js';
import type { OAuthAccount, OAuthSession, OAuthStore } from './oauthStore.js';
import { quoteArg } from './shellArg.js';

export const ADMIN_PREFIX = 'appbuilder admin';

/** What `admin`'s raw arguments ask for. */
export type AdminInvocation =
  | { kind: 'help' }
  | { kind: 'init'; force: boolean }
  | { kind: 'init-help' }
  | ({ kind: 'run'; env: string | undefined; args: string[] } & AccountFlags)
  | { kind: 'error'; message: string };

/** The wrapper's options that take a value: the flag, and its usage for a missing argument. */
const VALUE_FLAGS = {
  env: ['--env', '<env>'],
  business: ['--business', '<id-or-name>'],
  user: ['--user', '<userId>'],
} as const;
const HELP_FLAGS: readonly string[] = ['-h', '--help'];
const FORCE_FLAG = '--force';

/**
 * Wrapper options (`--env <env>`, `--business <id-or-name>`, `--user <userId>`, each also as
 * `--flag=<value>`, and `-h`/`--help`) come first and end at the first other token or at `--`;
 * everything after goes to kizen verbatim. `init` is the wrapper's own subcommand only as the
 * first token after the wrapper options, never after `--`.
 */
export function parseAdminArgs(args: readonly string[]): AdminInvocation {
  const values: { env?: string } & AccountFlags = {};
  let index = 0;
  const run = (rest: string[]): AdminInvocation => ({
    kind: 'run',
    env: values.env,
    ...(values.business !== undefined && { business: values.business }),
    ...(values.user !== undefined && { user: values.user }),
    args: rest,
  });

  options: while (index < args.length) {
    const arg = args[index] ?? '';

    if (arg === '--') {
      return run(args.slice(index + 1));
    }

    if (HELP_FLAGS.includes(arg)) {
      return { kind: 'help' };
    }

    for (const [key, [flag, usage]] of Object.entries(VALUE_FLAGS)) {
      if (arg === flag || arg.startsWith(`${flag}=`)) {
        const value = arg === flag ? args[index + 1] : arg.slice(flag.length + 1);

        if (value === undefined || value === '') {
          return { kind: 'error', message: `option '${flag} ${usage}' argument missing` };
        }

        values[key as keyof typeof VALUE_FLAGS] = value;
        index += arg === flag ? 2 : 1;

        continue options;
      }
    }

    break;
  }

  const rest = args.slice(index);

  if (rest[0] === 'init') {
    const extra = rest.slice(1);

    if (extra.length === 0) {
      return { kind: 'init', force: false };
    }

    if (extra.length === 1 && extra[0] === FORCE_FLAG) {
      return { kind: 'init', force: true };
    }

    if (extra.length === 1 && HELP_FLAGS.includes(extra[0] ?? '')) {
      return { kind: 'init-help' };
    }

    return {
      kind: 'error',
      message: `admin init takes only --force, but got: ${extra.map(quoteArg).join(' ')}`,
    };
  }

  return run(rest);
}

/**
 * The `KIZEN_AUTH_HELPER` command: this CLI's `auth-header --env <env> --business <id> --user <id>`,
 * bound to the account kizen was given its ids for. It serves that account from its own file
 * whether or not it's current, so a switch to another account meanwhile neither stops kizen nor
 * hands it the other account's token; a logout of that account makes the next token fetch fail.
 * kizen caches the header for the life of its process and runs the helper again only after a 401
 * (`kizen_builder/auth_helper.py`). Run by the same node and script, with each word POSIX-quoted
 * so kizen's `shlex.split` gets them back exactly.
 */
export const kizenAuthHelper = (
  execPath: string,
  scriptPath: string,
  environment: Environment,
  account: OAuthAccount,
): string =>
  [
    execPath,
    scriptPath,
    'auth-header',
    '--env',
    environment,
    '--business',
    account.businessId,
    '--user',
    account.userId,
  ]
    .map(quoteArg)
    .join(' ');

/** Set by the caller's shell, but they'd steer kizen or `auth-header` away from this session. */
const STRIPPED_ENV = ['KIZEN_PROFILE', 'CLAUDE_CODE_MCP_SERVER_URL'] as const;

export interface KizenSessionEnv {
  KIZEN_AUTH_HELPER: string;
  KIZEN_BASE_URL: string;
  KIZEN_BUSINESS_ID: string;
  KIZEN_USER_ID: string;
}

/** `base` minus `KIZEN_PROFILE` and `CLAUDE_CODE_MCP_SERVER_URL`, plus kizen's session variables. */
export function kizenChildEnv(
  base: Readonly<Record<string, string | undefined>>,
  session: KizenSessionEnv,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !(STRIPPED_ENV as readonly string[]).includes(name)) {
      env[name] = value;
    }
  }

  return { ...env, ...session };
}

export type SpawnKizen = (
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: 'inherit'; env: Record<string, string> },
) => ChildProcess;

export interface SignalTarget {
  on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  off: (signal: NodeJS.Signals, listener: () => void) => unknown;
}

/** Sent to this process alone (`kill`, a closed terminal), so kizen only hears them if passed on. */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];

/**
 * Runs `<venv>/bin/python <venv>/bin/kizen <args…>` with inherited stdio, forwarding SIGTERM and
 * SIGHUP to it. SIGINT depends on `interactive` (stdin is a TTY), decided once at start:
 * - interactive: swallowed, not forwarded. A terminal's Ctrl-C already reaches kizen through the
 *   foreground process group, and a second one would interrupt Python's KeyboardInterrupt
 *   cleanup. The listener keeps this process alive to wait for kizen's exit.
 * - non-interactive: forwarded like SIGTERM, since a caller's `kill -INT` or
 *   `child.kill('SIGINT')` reaches only this process. The accepted tradeoff: with stdin
 *   redirected in a foreground terminal, a Ctrl-C reaches kizen twice.
 *
 * Resolves with kizen's exit code, or 128 + the signal number when a signal ended it; rejects
 * when it can't start. Every listener is removed once it settles.
 *
 * The interpreter runs the console script rather than the script running itself: its shebang was
 * written while the venv was still at its temporary build path, which the publish rename leaves
 * dangling.
 */
export function runKizen(
  install: Pick<KizenInstall, 'python' | 'kizen'>,
  args: readonly string[],
  env: Record<string, string>,
  spawnKizen: SpawnKizen,
  signals: SignalTarget,
  interactive: boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;

    try {
      child = spawnKizen(install.python, [install.kizen, ...args], { stdio: 'inherit', env });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));

      return;
    }

    const forwarded: readonly NodeJS.Signals[] = interactive
      ? FORWARDED_SIGNALS
      : [...FORWARDED_SIGNALS, 'SIGINT'];
    const listeners = [
      ...forwarded.map((signal) => {
        const forward = (): void => {
          child.kill(signal);
        };

        return [signal, forward] as const;
      }),
      ...(interactive ? [['SIGINT', (): void => undefined] as const] : []),
    ];

    for (const [signal, listener] of listeners) {
      signals.on(signal, listener);
    }

    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;

      for (const [signal, listener] of listeners) {
        signals.off(signal, listener);
      }

      finish();
    };

    child.on('error', (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.on('close', (code, signal) => {
      settle(() => {
        resolve(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
      });
    });
  });
}

export interface AdminDeps {
  store: Pick<OAuthStore, 'listSessions' | 'readSession' | 'readAccount' | 'listAccounts'>;
  /**
   * The provisioner `admin init` and every `admin` run share (`ensureKizen`). `force` (only from
   * `admin init --force`) removes the install first.
   */
  ensureKizen: (options?: { force?: boolean }) => Promise<KizenInstall>;
  spawn: SpawnKizen;
  signals: SignalTarget;
  /** Whether stdin is a TTY, so a Ctrl-C already reaches kizen and SIGINT isn't forwarded. */
  interactive: boolean;
  processEnv: Readonly<Record<string, string | undefined>>;
  /** `process.execPath` and `process.argv[1]`: how kizen runs `appbuilder auth-header`. */
  execPath: string;
  scriptPath: string | undefined;
  outputHelp: () => void;
  outputInitHelp: () => void;
  writeStderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

const fail = (deps: AdminDeps, message: string): void => {
  deps.writeStderr(`${ADMIN_PREFIX}: ${message}\n`);
  deps.setExitCode(1);
};

/** `admin init`: provisions (or confirms) the kizen venv. Needs no session. */
export async function runAdminInit(deps: AdminDeps, force = false): Promise<void> {
  let install: KizenInstall;

  try {
    install = await deps.ensureKizen(force ? { force } : undefined);
  } catch (error) {
    fail(deps, errorMessage(error));

    return;
  }

  deps.writeStderr(`${ADMIN_PREFIX}: kizen ${install.version} is ready in ${install.dir}.\n`);
}

/**
 * The kizen variables of the account `--business` / `--user` (or `APPBUILDER_BUSINESS` /
 * `APPBUILDER_USER`) name, else of the current account, or why there's none. Never reads a token.
 * A name that matches no saved account, or several, throws.
 */
async function sessionEnv(
  invocation: { env: string | undefined } & AccountFlags,
  deps: AdminDeps,
): Promise<{ ok: true; session: KizenSessionEnv } | { ok: false; message: string }> {
  const request = requireAccountRequest(invocation, deps.processEnv);
  const resolved = await resolveAccountEnvironment(invocation.env, request, deps.store);

  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }

  const { environment } = resolved;
  let session: OAuthSession | null;

  if (request === undefined) {
    session = await deps.store.readSession(environment);
  } else {
    const account = requireNamedAccount(
      environment,
      await deps.store.listAccounts(environment),
      request,
    );

    session = await deps.store.readAccount(environment, account);
  }

  if (session === null) {
    return {
      ok: false,
      message: loginRequired(environment, `You're not signed in to ${environment}.`).message,
    };
  }

  if (deps.scriptPath === undefined) {
    return { ok: false, message: "can't tell which script is running, so kizen can't call back." };
  }

  return {
    ok: true,
    session: {
      KIZEN_AUTH_HELPER: kizenAuthHelper(deps.execPath, deps.scriptPath, environment, session),
      KIZEN_BASE_URL: apiOriginFor(environment),
      KIZEN_BUSINESS_ID: session.businessId,
      KIZEN_USER_ID: session.userId,
    },
  };
}

/**
 * `appbuilder admin [--env <env>] [--business <id-or-name> [--user <userId>]] [--] <kizen args…>`
 * and `appbuilder admin init`.
 */
export async function runAdmin(args: readonly string[], deps: AdminDeps): Promise<void> {
  const invocation = parseAdminArgs(args);

  switch (invocation.kind) {
    case 'help':
      deps.outputHelp();

      return;
    case 'init-help':
      deps.outputInitHelp();

      return;
    case 'init':
      await runAdminInit(deps, invocation.force);

      return;
    case 'error':
      fail(deps, invocation.message);

      return;
    case 'run':
      break;
  }

  // The session comes first, so a signed-out user never triggers a download.
  let resolved: Awaited<ReturnType<typeof sessionEnv>>;

  try {
    resolved = await sessionEnv(invocation, deps);
  } catch (error) {
    fail(deps, errorMessage(error));

    return;
  }

  if (!resolved.ok) {
    fail(deps, resolved.message);

    return;
  }

  let install: KizenInstall;

  try {
    install = await deps.ensureKizen();
  } catch (error) {
    fail(deps, errorMessage(error));

    return;
  }

  const childEnv = kizenChildEnv(deps.processEnv, resolved.session);

  try {
    deps.setExitCode(
      await runKizen(
        install,
        invocation.args,
        childEnv,
        deps.spawn,
        deps.signals,
        deps.interactive,
      ),
    );
  } catch (error) {
    fail(deps, `couldn't start kizen: ${errorMessage(error)}`);
  }
}
