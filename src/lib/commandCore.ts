import { join } from 'node:path';
import { PluginValidationError } from '@kizenapps/packager';
import type { ValidationIssue } from '@kizenapps/packager';
import { isProductionEnvironment } from '../../shared/lib/kizenUrls.js';
import { loadConfig, type AppBuilderConfig } from './config.js';
import {
  ENVIRONMENTS,
  GLOBAL_CREDENTIALS_PATH,
  listLoadableCredentialProfiles,
  loadCredentialsDetailed,
  type CredentialProfile,
  type Credentials,
  type DetailedCredentials,
  type Environment,
} from './credentials.js';
import { formatValidationIssues } from './formatValidationIssues.js';
import { createKizenClient, KizenApiError, type KizenIdentity } from './kizenClient.js';
import type { KizenClient } from './kizenTypes.js';
import { OAuthError } from './oauth.js';
import {
  accountRequest,
  notSignedInWithApiKeyHint,
  pinnedProfileNotice,
  selectAuth,
  type AccountRequest,
  type AuthFlags,
} from './authSelection.js';
import { matchBusiness, requireNamedAccount, resolveAccountEnvironment } from './oauthCommands.js';
import { createDefaultTokenProvider } from './oauthSession.js';
import {
  createOAuthStore,
  type OAuthAccount,
  type OAuthStore,
  type SavedAccount,
} from './oauthStore.js';
import { quoteArg } from './shellArg.js';

/**
 * Every code a headless command fails with. `invalid_block`, `remembered_target_missing` and
 * `drift_detected` are `block push`'s own; the rest apply to any command that signs in and writes.
 */
export type CommandErrorCode =
  | 'needs_choice'
  | 'validation_failed'
  | 'invalid_block'
  | 'auth_failed'
  | 'forbidden'
  | 'remembered_target_missing'
  | 'drift_detected'
  | 'network_error'
  | 'credentials_invalid'
  | 'production_requires_flag'
  | 'not_found'
  | 'usage_error'
  | 'api_error'
  | 'local_error'
  // `appbuilder app`'s own.
  | 'publish_conflict'
  | 'no_preview'
  | 'preview_incomplete'
  | 'preview_changed'
  | 'thumbnail_required'
  | 'source_invalid'
  | 'base_required'
  | 'unresolved_conflicts'
  // Sign-in problems any session command can hit.
  | 'not_signed_in'
  | 'session_store_unwritable';

/**
 * One way to answer a failure, as a step produces it: `args` re-run the command with it. The
 * runner that prints the failure gives every choice its whole `argv` (`RunnableChoice`).
 */
export interface CommandChoice {
  value: string;
  label: string;
  /** Flags to append to the command that was run. Empty when the choice is a different command (`argv`). */
  args: string[];
  /**
   * Set by a step only for a choice that isn't a re-run of the same command (`appbuilder app`'s
   * `base` choices): that command, without the run's credential flags, which the runner adds.
   */
  argv?: string[];
}

/**
 * A choice as a command prints it. `argv` is the whole command to run, ready to exec: the leading
 * `appbuilder`, the run's credential and account flags, and `--json` when the run had it.
 */
export type RunnableChoice<TChoice extends CommandChoice = CommandChoice> = TChoice & {
  argv: string[];
};

/** A command to run next, as a whole `argv` like a `RunnableChoice`'s. */
export interface NextCommand {
  step: string;
  argv: string[];
}

/**
 * A failed step. `TKind` names what a `needs_choice` asks for (`never` when the step can't ask),
 * `TChoice` the shape of its choices.
 */
export interface CommandFailure<
  TKind extends string = never,
  TChoice extends CommandChoice = CommandChoice,
> {
  ok: false;
  code: CommandErrorCode;
  message: string;
  choice?: TKind;
  choices?: TChoice[];
  issues?: ValidationIssue[];
  field?: string;
  hint?: string;
  /** `not_signed_in`: the command that signs in, for the user to run (it opens a browser). */
  login?: { argv: string[] };
  /** The files the failure is about (`unresolved_conflicts`). */
  files?: string[];
  /** Commands that get past the failure, in order (`publish_conflict`). */
  next?: NextCommand[];
  /** Set on a `network_error` when a sandbox around the CLI has the network turned off. */
  sandbox?: 'codex_network_disabled';
}

export type CommandStep<T, F extends CommandFailure<string> = CommandFailure> =
  | { ok: true; value: T }
  | F;

export function failure<
  TKind extends string = never,
  TChoice extends CommandChoice = CommandChoice,
>(
  code: CommandErrorCode,
  message: string,
  extra: Omit<CommandFailure<TKind, TChoice>, 'ok' | 'code' | 'message'> = {},
): CommandFailure<TKind, TChoice> {
  return { ok: false, code, message, ...extra };
}

export const success = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

export function apiFailure(error: unknown): CommandFailure {
  if (error instanceof KizenApiError) {
    return failure(error.kind, error.message, error.hint === undefined ? {} : { hint: error.hint });
  }

  if (error instanceof PluginValidationError) {
    return failure('validation_failed', formatValidationIssues(error.issues), {
      issues: error.issues,
    });
  }

  return failure('local_error', errorMessage(error));
}

/** The stored `appbuilder login` sessions, which commands use unless -c or --profile is passed. */
export interface OAuthCommandDeps {
  listSessions: () => Promise<Environment[]>;
  /** The saved accounts `--business` / `APPBUILDER_BUSINESS` choose among. */
  listAccounts: (environment: Environment) => Promise<SavedAccount[]>;
  /**
   * The identity and the client that resolved it, so later requests are pinned to that login:
   * `account` when given, else the current account at the first read.
   */
  connect: (
    environment: Environment,
    account?: OAuthAccount,
  ) => Promise<{ identity: KizenIdentity; client: KizenClient }>;
}

/** What any headless command needs to sign in and report: the IO behind credential resolution and output. */
export interface CommandDeps {
  cwd: string;
  loadCredentialsDetailed: (path: string) => Promise<DetailedCredentials>;
  listLoadableCredentialProfiles: () => Promise<CredentialProfile[]>;
  /** Reads `.kizenapp/config.json`, for the ignored-profile-pin notice. */
  loadConfig: (outputDir: string) => Promise<AppBuilderConfig>;
  /** The API-key client for -c / --profile; the sign-in session's client comes from `oauth.connect`. */
  createClient: (credentials: Credentials) => KizenClient;
  now: () => Date;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  setExitCode: (code: number) => void;
  /** Where `APPBUILDER_BUSINESS` / `APPBUILDER_USER` are read from. */
  processEnv: Readonly<Record<string, string | undefined>>;
  oauth: OAuthCommandDeps;
}

export function createOAuthCommandDeps(
  store: OAuthStore,
  options: { fetch?: typeof fetch } = {},
): OAuthCommandDeps {
  const { fetch: fetchImpl } = options;

  return {
    listSessions: () => store.listSessions(),
    listAccounts: (environment) => store.listAccounts(environment),
    connect: async (environment, account) => {
      const bearer = createDefaultTokenProvider(environment, store, {
        ...(fetchImpl && { fetch: fetchImpl }),
        ...(account !== undefined && { account }),
      });
      const client = createKizenClient({ bearer, ...(fetchImpl && { fetch: fetchImpl }) });

      return { identity: await client.getIdentity(), client };
    },
  };
}

export function createDefaultCommandDeps(cwd: string): CommandDeps {
  return {
    cwd,
    loadCredentialsDetailed,
    listLoadableCredentialProfiles,
    loadConfig,
    createClient: (credentials) => createKizenClient({ credentials }),
    now: () => new Date(),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    processEnv: process.env,
    // Constructing the store does no IO; a -c / --profile command never touches it.
    oauth: createOAuthCommandDeps(createOAuthStore()),
  };
}

/**
 * Who the command acts as: the environment and business it writes to, and the signed-in user
 * (the session's identity, or the API-key file's `userId`).
 */
export type CommandAccount = Pick<Credentials, 'environment' | 'businessId' | 'userId'>;

export interface ResolvedCredentials {
  credentials: CommandAccount;
  /** The client every request of the command goes through. */
  client: KizenClient;
  /** One-line notices to show before continuing, such as an ignored profile pin. */
  notices: string[];
}

/**
 * `appbuilder login`, with `--env` when the environment is known, and the account the run named
 * (`--business` / `--user`, from the flags or APPBUILDER_BUSINESS / APPBUILDER_USER) so the login
 * switches to that saved account, or makes a browser sign-in current only if it's that account.
 * It opens a browser, so a person runs it (or an agent runs it in the background and relays the
 * URL it prints).
 */
export const loginArgv = (
  environment: string | undefined,
  account: AccountRequest | undefined,
): string[] => [
  'appbuilder',
  'login',
  ...(environment === undefined ? [] : ['--env', environment]),
  ...(account === undefined
    ? []
    : [
        '--business',
        account.business,
        ...(account.user === undefined ? [] : ['--user', account.user]),
      ]),
];

/**
 * How the user runs the login command, by the harness running this process (exact variable names,
 * as `isInteractive` reads them; never a `CODEX_` prefix match, since the Codex plugin for Claude
 * Code sets `CODEX_COMPANION_*` inside Claude Code). Codex first: with both set, Codex is what
 * runs this command, and `!` is Claude Code's alone.
 */
function signInHint(command: string, processEnv: CommandDeps['processEnv']): string {
  if (processEnv.CODEX_CI !== undefined) {
    return `Ask the user to sign in: they run \`${command}\` in their own terminal, where it opens a browser and waits for the sign-in. Then run this command again.`;
  }

  if (processEnv.CLAUDECODE !== undefined) {
    return `Ask the user to sign in: they type \`! ${command}\` in this Claude Code session, or you run it in the background and give them the URL it prints. Then run this command again.`;
  }

  return `Ask the user to sign in: they run \`${command}\` in a terminal, or you run it in the background and give them the URL it prints. Then run this command again.`;
}

/** The not_signed_in failure, with the login command to run, as data and in the hint. */
export function notSignedInFailure(
  message: string,
  environment: string | undefined,
  account: AccountRequest | undefined,
  processEnv: CommandDeps['processEnv'],
): CommandFailure<'environment'> {
  const argv = loginArgv(environment, account);

  return failure('not_signed_in', message, {
    login: { argv },
    hint: signInHint(argv.map(quoteArg).join(' '), processEnv),
  });
}

/** A sign-in the token provider found missing, refused or unreadable: `login_required`. */
const isLoginRequired = (error: unknown): boolean =>
  error instanceof KizenApiError &&
  error.cause instanceof OAuthError &&
  error.cause.code === 'login_required';

/** What `resolveCredentials` can fail with: a `needs_choice` only ever asks for an environment. */
export type CredentialsFailure = CommandFailure<'environment'>;

type CredentialsStep = CommandStep<ResolvedCredentials, CredentialsFailure>;

async function loadCredentialFile(path: string, deps: CommandDeps): Promise<CredentialsStep> {
  let detailed: DetailedCredentials;

  try {
    detailed = await deps.loadCredentialsDetailed(path);
  } catch (error) {
    return failure(
      'credentials_invalid',
      `Couldn't read credentials from ${path}: ${errorMessage(error)}`,
    );
  }

  if (detailed.environmentSource !== 'explicit') {
    const problem =
      detailed.environmentSource === 'missing'
        ? 'has no "environment"'
        : 'has an invalid "environment"';

    return failure(
      'credentials_invalid',
      `${path} ${problem}. Set it to one of: ${ENVIRONMENTS.join(', ')}. The CLI won't default to production.`,
    );
  }

  const { credentials } = detailed;
  const empty = (['apiKey', 'userId', 'businessId'] as const).filter(
    (field) => credentials[field].trim() === '',
  );

  if (empty.length > 0) {
    return failure(
      'credentials_invalid',
      `${path} is missing ${empty.map((field) => `"${field}"`).join(', ')}.`,
    );
  }

  // Only the client sees the API key; the account a command reads (and may print) never holds it.
  return success({
    credentials: {
      environment: credentials.environment,
      businessId: credentials.businessId,
      userId: credentials.userId,
    },
    client: deps.createClient(credentials),
    notices: [],
  });
}

async function resolveProfile(name: string, deps: CommandDeps): Promise<CredentialsStep> {
  const profiles = await deps.listLoadableCredentialProfiles();
  const profile = profiles.find((candidate) => candidate.name === name);

  if (!profile) {
    const names = profiles.map((candidate) => candidate.name);

    return failure(
      'credentials_invalid',
      names.length === 0
        ? `No loadable credential profile named "${name}". No profiles are loadable; create ${GLOBAL_CREDENTIALS_PATH} or pass -c <path>.`
        : `No loadable credential profile named "${name}". Loadable profiles: ${names.join(', ')}`,
    );
  }

  return loadCredentialFile(profile.path, deps);
}

/** A `.kizenapp/config.json` profile pin no longer opts into API keys; say so. */
async function pinnedProfileNotices(deps: CommandDeps): Promise<string[]> {
  const { activeCredentialProfile } = await deps.loadConfig(join(deps.cwd, '.kizenapp'));

  return activeCredentialProfile === undefined || activeCredentialProfile === ''
    ? []
    : [pinnedProfileNotice(activeCredentialProfile)];
}

export interface SessionConnectDeps<T> {
  sessions: Pick<OAuthCommandDeps, 'listSessions' | 'listAccounts'>;
  /** Signs in as `account` (the current account when undefined) in `environment`. */
  connect: (environment: Environment, account: OAuthAccount | undefined) => Promise<T>;
  processEnv: CommandDeps['processEnv'];
  /** Rewrites the message of an environment nobody is signed in to (default: as is). */
  signedOutMessage?: (message: string) => string;
}

/**
 * The sign-in session a run uses, connected: --env picks the environment (else the only one signed
 * in, or with a named account the only one where it's saved), and `request`'s saved account in it,
 * never the current one, else the current account. Fails with `not_signed_in` (carrying the login
 * to run), `needs_choice` among several environments, or a `usage_error`.
 */
export async function connectSession<T>(
  env: string | undefined,
  request: AccountRequest | undefined,
  deps: SessionConnectDeps<T>,
): Promise<CommandStep<{ environment: Environment; connected: T }, CredentialsFailure>> {
  const { sessions, processEnv, signedOutMessage = (message: string) => message } = deps;
  const resolved = await resolveAccountEnvironment(env, request, sessions);

  if (!resolved.ok) {
    switch (resolved.problem) {
      case 'not_signed_in':
        return notSignedInFailure(signedOutMessage(resolved.message), env, request, processEnv);
      case 'several_sessions':
        return failure('needs_choice', resolved.message, {
          choice: 'environment',
          choices: resolved.environments.map((environment) => ({
            value: environment,
            label: environment,
            args: ['--env', environment],
          })),
        });
      case 'unknown_environment':
        return failure('usage_error', resolved.message);
    }
  }

  const { environment } = resolved;

  let account: OAuthAccount | undefined;

  if (request !== undefined) {
    let accounts: SavedAccount[];

    try {
      accounts = await sessions.listAccounts(environment);
    } catch (error) {
      return apiFailure(error);
    }

    // Never the current account. A name that matches several saved accounts is a bad argument; one
    // that matches none isn't signed in here (or was signed out since a command named it), so the
    // failure carries the login for it.
    try {
      account = requireNamedAccount(environment, accounts, request);
    } catch (error) {
      return matchBusiness(accounts, request.business, request.user).kind === 'none'
        ? notSignedInFailure(errorMessage(error), environment, request, processEnv)
        : failure('usage_error', errorMessage(error));
    }
  }

  try {
    return success({ environment, connected: await deps.connect(environment, account) });
  } catch (error) {
    // No session for this environment (or account), or one Kizen refused: the user signs in.
    return isLoginRequired(error)
      ? notSignedInFailure(errorMessage(error), environment, request, processEnv)
      : apiFailure(error);
  }
}

async function resolveSessionCredentials(
  env: string | undefined,
  request: AccountRequest | undefined,
  deps: CommandDeps,
): Promise<CredentialsStep> {
  const session = await connectSession(env, request, {
    sessions: deps.oauth,
    connect: (environment, account) => deps.oauth.connect(environment, account),
    processEnv: deps.processEnv,
    signedOutMessage: notSignedInWithApiKeyHint,
  });

  if (!session.ok) {
    return session;
  }

  const { environment, connected } = session.value;

  // The token carries the user and business server-side; the identity names them for the caller.
  return success({
    credentials: {
      environment,
      businessId: connected.identity.businessId,
      userId: connected.identity.userId,
    },
    client: connected.client,
    notices: await pinnedProfileNotices(deps),
  });
}

/**
 * The `appbuilder login` session by default (--env picks its environment; --business / --user, or
 * APPBUILDER_BUSINESS / APPBUILDER_USER, a saved account in it); an API key only for -c or
 * --profile, which never read the sessions.
 */
export async function resolveCredentials(
  options: AuthFlags,
  deps: CommandDeps,
): Promise<CredentialsStep> {
  const selected = selectAuth(options, deps.processEnv);

  if (!selected.ok) {
    return failure('usage_error', selected.message);
  }

  const { selection } = selected;

  if (selection.kind === 'oauth') {
    return resolveSessionCredentials(selection.env, selection.account, deps);
  }

  return selection.credentials === undefined
    ? resolveProfile(selection.profile, deps)
    : loadCredentialFile(selection.credentials, deps);
}

/** The flags that decide whether a headless command writes. */
export interface WriteGateFlags {
  dryRun?: boolean;
  yes?: boolean;
  allowProduction?: boolean;
}

export type WriteGate = { kind: 'dry-run'; reason: 'flag' | 'no_yes' } | { kind: 'apply' };

/** A headless write needs --yes, and --allow-production too on a production environment. */
export function headlessWriteGate(
  options: WriteGateFlags,
  environment: Environment,
): CommandStep<WriteGate> {
  if (options.dryRun) {
    return success({ kind: 'dry-run', reason: 'flag' });
  }

  if (!options.yes) {
    return success({ kind: 'dry-run', reason: 'no_yes' });
  }

  if (isProductionEnvironment(environment) && !options.allowProduction) {
    return failure(
      'production_requires_flag',
      `${environment} is a production environment. Pass --allow-production with --yes to write to it.`,
    );
  }

  return success({ kind: 'apply' });
}

export const DRY_RUN_NOTE = 'Dry run only: pass --yes to write.';

export const warningLines = (warnings: readonly string[]): string[] =>
  warnings.map((warning) => `Warning: ${warning}`);

/** The whole command a failure's choice runs (`RunnableChoice.argv`), given what kind it is. */
export type ChoiceArgv<
  TKind extends string = string,
  TChoice extends CommandChoice = CommandChoice,
> = (choice: TChoice, kind: TKind | undefined) => string[];

export interface CommandOutput {
  json: boolean;
  deps: Pick<CommandDeps, 'writeStdout' | 'writeStderr' | 'setExitCode' | 'processEnv'>;
}

/** `--json` when the run had it, so a printed command answers the way this run did. */
export const jsonArgs = (output: CommandOutput): string[] => (output.json ? ['--json'] : []);

/** `command` (`appbuilder block push`, say) with `args` and the run's --json: a whole argv. */
export const commandArgv = (
  command: string,
  args: readonly string[],
  output: CommandOutput,
): string[] => [...command.split(' '), ...args, ...jsonArgs(output)];

/**
 * Exit 2: the command stopped for a decision (`needs_choice`, `base_required`), and its `choices`
 * say how to go on. Every other failure exits 1.
 */
export const DECISION_EXIT_CODE = 2;

const DECISION_CODES: ReadonlySet<CommandErrorCode> = new Set(['needs_choice', 'base_required']);

export const exitCodeFor = (code: CommandErrorCode): number =>
  DECISION_CODES.has(code) ? DECISION_EXIT_CODE : 1;

/**
 * Codex sets this (exactly this name: its Claude Code plugin sets other `CODEX_*` variables) when
 * its sandbox has the network turned off.
 */
export const CODEX_NETWORK_DISABLED_ENV = 'CODEX_SANDBOX_NETWORK_DISABLED';

export const CODEX_NETWORK_DISABLED_HINT =
  'The Codex sandbox has network access turned off, so appbuilder can\'t reach Kizen. Re-run this command with sandbox_permissions: "require_escalated", and suggest prefix_rule: ["appbuilder"] so later appbuilder commands can reach the network too.';

/** A network_error under Codex's network-disabled sandbox says so, and how to escalate. */
function withSandboxHint<F extends CommandFailure<string>>(
  result: F,
  processEnv: CommandDeps['processEnv'],
): F {
  if (result.code !== 'network_error' || processEnv[CODEX_NETWORK_DISABLED_ENV] !== '1') {
    return result;
  }

  return {
    ...result,
    sandbox: 'codex_network_disabled',
    hint:
      result.hint === undefined
        ? CODEX_NETWORK_DISABLED_HINT
        : `${CODEX_NETWORK_DISABLED_HINT} ${result.hint}`,
  };
}

const commandText = (argv: readonly string[]): string => argv.map(quoteArg).join(' ');

function formatFailureText<TKind extends string, TChoice extends CommandChoice>(
  result: CommandFailure<TKind, RunnableChoice<TChoice>>,
): string {
  const lines = [`Error: ${result.message}`];

  if (result.hint !== undefined) {
    lines.push(`Hint: ${result.hint}`);
  }

  if (result.choices && result.choices.length > 0) {
    lines.push('Choices:');

    for (const choice of result.choices) {
      lines.push(`  ${choice.label}  →  ${commandText(choice.argv)}`);
    }
  }

  if (result.next && result.next.length > 0) {
    lines.push('Next:');

    for (const step of result.next) {
      lines.push(`  ${step.step}  →  ${commandText(step.argv)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Prints a failure with each choice's whole `argv`: --json puts it on stdout, otherwise it and
 * its choices' commands go to stderr. Exit 2 for a decision, else 1 (`exitCodeFor`).
 */
export function writeFailure<TKind extends string, TChoice extends CommandChoice>(
  output: CommandOutput,
  result: CommandFailure<TKind, TChoice>,
  choiceArgv: ChoiceArgv<TKind, TChoice>,
): void {
  const hinted = withSandboxHint(result, output.deps.processEnv);
  const { choices, ...rest } = hinted;
  // Spread over `hinted`, so `choices` keeps its place in the JSON.
  const printed: CommandFailure<TKind, RunnableChoice<TChoice>> = choices === undefined
    ? rest
    : {
        ...hinted,
        choices: choices.map((choice) => ({ ...choice, argv: choiceArgv(choice, rest.choice) })),
      };

  if (output.json) {
    output.deps.writeStdout(`${JSON.stringify(printed, null, 2)}\n`);
  } else {
    output.deps.writeStderr(formatFailureText(printed));
  }

  output.deps.setExitCode(exitCodeFor(result.code));
}

// --json puts the result on stdout and the human-readable lines on stderr.
export function writeResult(
  output: CommandOutput,
  result: unknown,
  text: string,
  jsonText = text,
): void {
  if (output.json) {
    output.deps.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    output.deps.writeStderr(jsonText);
  } else {
    output.deps.writeStdout(text);
  }
}

export const writeNotices = (
  deps: Pick<CommandDeps, 'writeStderr'>,
  notices: readonly string[],
): void => {
  for (const notice of notices) {
    deps.writeStderr(`${notice}\n`);
  }
};

/**
 * The account the run asked for (`--business` / `--user`, else `APPBUILDER_BUSINESS` /
 * `APPBUILDER_USER`), as flags for the commands a choice prints: a one-command variable
 * assignment doesn't survive being copied. Empty when no account was named, or the request is
 * invalid (that run already failed with the usage error).
 */
export const accountArgs = (
  options: AuthFlags,
  processEnv: CommandDeps['processEnv'],
): string[] => {
  const result = accountRequest(options, processEnv);

  if (!result.ok || result.request === undefined) {
    return [];
  }

  const { business, user } = result.request;

  return ['--business', business, ...(user === undefined ? [] : ['--user', user])];
};

/** The credential flags the run was given, for the commands a choice prints. */
export const credentialArgs = (
  options: AuthFlags,
  processEnv: CommandDeps['processEnv'],
): string[] => {
  if (options.credentials !== undefined) {
    return ['-c', options.credentials];
  }

  if (options.profile !== undefined) {
    return ['--profile', options.profile];
  }

  return [
    ...(options.env === undefined ? [] : ['--env', options.env]),
    ...accountArgs(options, processEnv),
  ];
};

/**
 * The credential flags for a command printed after the run signed in, so it acts as the account
 * this run did. An API key keeps `-c` / `--profile` as given. A sign-in session is pinned to the
 * account it resolved, by ids (`--business` matches an id exactly, `--user` the user id), even when
 * the run named none: a switch or sign-in elsewhere meanwhile can't redirect the printed command,
 * which fails instead if that account is signed out.
 */
export const pinnedCredentialArgs = (options: AuthFlags, account: CommandAccount): string[] =>
  options.credentials !== undefined || options.profile !== undefined
    ? credentialArgs(options, {})
    : ['--env', account.environment, '--business', account.businessId, '--user', account.userId];
