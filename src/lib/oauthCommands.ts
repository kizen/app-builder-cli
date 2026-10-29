/**
 * `appbuilder login`, `logout`, `whoami` and `auth-header`. Only `auth-header` ever writes a
 * token, and only the access token, to stdout.
 *
 * `login` is headless unless a person is at a terminal: `--list` and `--business` never prompt,
 * and without them the account picker appears only when `isInteractive` says a person is there
 * (both streams TTYs, no `--no-interactive`, no agent or CI environment) and the environment has
 * saved accounts. Otherwise it runs the browser sign-in.
 */
import { apiOriginFor } from '../../shared/lib/kizenUrls.js';
import {
  accountRequest,
  BUSINESS_ENV,
  USER_ENV,
  type AccountFlags,
  type AccountRequest,
} from './authSelection.js';
import { ENVIRONMENTS, parseEnvironment, type Environment } from './credentials.js';
import { errorMessage } from './guards.js';
import { isProcessInteractive } from './interactive.js';
import { createKizenClient, KizenApiError, type KizenIdentity } from './kizenClient.js';
import {
  DEFAULT_LOGIN_ENVIRONMENT,
  loginCommandFor,
  SessionStoreUnwritableError,
} from './oauth.js';
import {
  createDefaultLoginDeps,
  createDefaultTokenProvider,
  login,
  resolveSessionEnvironment,
  switchAccount,
  type BearerTokenProvider,
  type Identify,
  type LoginDeps,
  type SessionEnvironment,
  type TokenProviderOptions,
} from './oauthSession.js';
import {
  accountKey,
  createOAuthStore,
  sameAccount,
  type OAuthAccount,
  type OAuthSession,
  type OAuthStore,
  type SavedAccount,
} from './oauthStore.js';
import { quoteArg } from './shellArg.js';

/**
 * Claude Code kills a `headersHelper` after 10s. auth-header's worst case is one
 * `requestTimeoutMs` of token requests in total (a retry after a peer's rotation gets only what's
 * left of it) plus local file I/O, and must stay under the limit with room for start-up.
 */
export const AUTH_HEADER_REQUEST_TIMEOUT_MS = 5_000;

/** One row of the account picker; the same shape as the ink `SelectList`'s items. */
export interface PickerItem {
  key: string;
  label: string;
  description?: string;
}

/** Shows `items` and resolves to the chosen key, or undefined if the person cancelled. */
export type PickAccount = (title: string, items: PickerItem[]) => Promise<string | undefined>;

export interface AuthCommandDeps {
  store: OAuthStore;
  loginDeps: LoginDeps;
  /** `/auth/bootstrap` through `bearer`. */
  identify: Identify;
  tokenProvider: (environment: Environment, options?: TokenProviderOptions) => BearerTokenProvider;
  isInteractive: () => boolean;
  /** The terminal account picker; without one, `login` never prompts. */
  pickAccount?: PickAccount;
  authHeaderTimeouts: { requestTimeoutMs: number };
  processEnv: Readonly<Record<string, string | undefined>>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

export function createDefaultAuthCommandDeps(
  store: OAuthStore = createOAuthStore(),
  pickAccount?: PickAccount,
  noInteractive = false,
): AuthCommandDeps {
  const tokenProvider = (
    environment: Environment,
    options?: TokenProviderOptions,
  ): BearerTokenProvider => createDefaultTokenProvider(environment, store, options);
  const writeStderr = (text: string): void => {
    process.stderr.write(text);
  };

  const identify: Identify = (bearer) => createKizenClient({ bearer }).getIdentity();

  return {
    store,
    loginDeps: createDefaultLoginDeps(
      store,
      (line) => {
        writeStderr(`${line}\n`);
      },
      identify,
    ),
    identify,
    tokenProvider,
    isInteractive: () => isProcessInteractive({ noInteractive }),
    ...(pickAccount !== undefined && { pickAccount }),
    authHeaderTimeouts: { requestTimeoutMs: AUTH_HEADER_REQUEST_TIMEOUT_MS },
    processEnv: process.env,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

function requireEnvironment(env: string): Environment {
  const { environment, message } = parseEnvironment(env);

  if (environment === undefined) {
    throw new Error(message);
  }

  return environment;
}

/** `resolveAccountEnvironment`, with any problem an error. */
async function sessionEnvironment(
  env: string | undefined,
  store: OAuthStore,
  request?: AccountRequest,
): Promise<Environment> {
  const resolved = await resolveAccountEnvironment(env, request, store);

  if (!resolved.ok) {
    throw new Error(resolved.message);
  }

  return resolved.environment;
}

/** `<name> (<id>)`, or just the id when the business has no name. */
const businessLabel = (name: string | undefined, id: string): string =>
  name ? `${name} (${id})` : id;

export const identityLines = (environment: Environment, identity: KizenIdentity): string => {
  const who = [identity.fullName, identity.email && `<${identity.email}>`]
    .filter(Boolean)
    .join(' ');

  return `Environment: ${environment}
User: ${who === '' ? identity.userId : `${who} (${identity.userId})`}
Business: ${businessLabel(identity.businessName, identity.businessId)}
`;
};

/** `<prefix>: <message>` to stderr, exit 1. `oneLine` collapses it and drops any API hint. */
function report(
  deps: AuthCommandDeps,
  error: unknown,
  { prefix = 'Error', oneLine = false } = {},
): void {
  const message = errorMessage(error);
  const hint =
    (error instanceof KizenApiError || error instanceof SessionStoreUnwritableError) &&
    error.hint !== undefined
      ? `\n${error.hint}`
      : '';

  deps.writeStderr(
    `${prefix}: ${oneLine ? message.replace(/\s+/g, ' ').trim() : `${message}${hint}`}\n`,
  );
  deps.setExitCode(1);
}

export interface AuthCommandOptions {
  env?: string;
}

export interface LoginCommandOptions extends AuthCommandOptions {
  business?: string;
  user?: string;
  list?: boolean;
  json?: boolean;
}

export interface LogoutCommandOptions extends AuthCommandOptions {
  all?: boolean;
  business?: string;
  user?: string;
}

export type AuthCommand<O extends AuthCommandOptions = AuthCommandOptions> = (
  options: O,
  deps: AuthCommandDeps,
) => Promise<void>;

const guarded =
  <O extends AuthCommandOptions>(run: AuthCommand<O>): AuthCommand<O> =>
  async (options, deps) => {
    try {
      await run(options, deps);
    } catch (error) {
      report(deps, error);
    }
  };

const signedInOutput = (deps: AuthCommandDeps, session: OAuthSession): void => {
  deps.writeStdout(`Signed in to ${session.environment}.\n`);
  deps.writeStdout(identityLines(session.environment, session));
};

/** The picker row for the browser sign-in; its key can't be an account key (those have a dot). */
export const BROWSER_PICK = 'browser';

/** A saved account as one short line: business name and id, then email or user id. */
const accountSummary = ({ account, session }: SavedAccount): string =>
  `${businessLabel(session?.businessName, account.businessId)} ${session?.email ?? `user ${account.userId}`}${session === undefined ? " (can't be read)" : ''}`;

/**
 * The picker's rows: each saved account, labeled by business name and id and described by email
 * (or user id), then the browser.
 */
export const accountPickerItems = (accounts: readonly SavedAccount[]): PickerItem[] => [
  ...accounts.map(({ account, session, current }) => ({
    key: accountKey(account),
    label: businessLabel(session?.businessName, account.businessId),
    description: [
      session?.email ?? account.userId,
      session === undefined ? "(can't be read)" : '',
      current ? '(current)' : '',
    ]
      .filter(Boolean)
      .join(' '),
  })),
  { key: BROWSER_PICK, label: 'Sign in with the browser' },
];

/** What a picked key means: a saved account, the browser sign-in, or undefined (cancelled). */
export const pickedAccount = (
  key: string | undefined,
  accounts: readonly SavedAccount[],
): SavedAccount | typeof BROWSER_PICK | undefined =>
  key === BROWSER_PICK ? BROWSER_PICK : accounts.find(({ account }) => accountKey(account) === key);

type BusinessMatch =
  | { kind: 'one'; account: SavedAccount }
  | { kind: 'none' | 'several'; candidates: SavedAccount[] };

/** What `--business` (and `--user`), or `APPBUILDER_BUSINESS` (and `APPBUILDER_USER`), ask for. */
type BusinessRequest = AccountRequest;

/**
 * Whether a browser sign-in's `identity` is the account `--business` (and `--user`) asked for, by
 * the same rule `matchBusiness` uses for saved accounts: its businessId is exactly the value, or
 * its businessName matches it ignoring case; and its userId is exactly `--user`, when given. The
 * retry printed after an expired account pins its business id and user id.
 */
const matchesRequest = (
  identity: Pick<KizenIdentity, 'businessId' | 'userId' | 'businessName'>,
  { business, user }: BusinessRequest,
): boolean =>
  (identity.businessId === business ||
    identity.businessName?.toLowerCase() === business.toLowerCase()) &&
  (user === undefined || identity.userId === user);

/**
 * `--business`: a saved account whose businessId is exactly `query`, else whose businessName is
 * `query` ignoring case, narrowed to userId `user` when given. `candidates` are the accounts to
 * list in the error: the matches when several match, every saved account when none does.
 */
export function matchBusiness(
  accounts: readonly SavedAccount[],
  query: string,
  user?: string,
): BusinessMatch {
  const byId = accounts.filter(({ account }) => account.businessId === query);
  const byBusiness =
    byId.length > 0
      ? byId
      : accounts.filter(
          ({ session }) => session?.businessName?.toLowerCase() === query.toLowerCase(),
        );
  const matches =
    user === undefined ? byBusiness : byBusiness.filter(({ account }) => account.userId === user);
  const [only] = matches;

  if (matches.length === 1 && only !== undefined) {
    return { kind: 'one', account: only };
  }

  return matches.length === 0
    ? { kind: 'none', candidates: [...accounts] }
    : { kind: 'several', candidates: matches };
}

const candidateLines = (candidates: readonly SavedAccount[]): string =>
  candidates.map((candidate) => `\n  ${accountSummary(candidate)}`).join('');

/** How a request names its user id: `--user <id>`, or `APPBUILDER_USER=<id>`. */
const userArg = (source: BusinessRequest['source'], user: string): string =>
  source === 'env' ? `${USER_ENV}=${quoteArg(user)}` : `--user ${quoteArg(user)}`;

/**
 * `--business <q>`, plus ` --user <id>` when given, shell-quoted, as the flags to repeat; or the
 * `APPBUILDER_BUSINESS=<q>` (and `APPBUILDER_USER=<id>`) assignments the request came from.
 */
const requestFlags = ({ business, user, source }: BusinessRequest): string =>
  `${source === 'env' ? `${BUSINESS_ENV}=${quoteArg(business)}` : `--business ${quoteArg(business)}`}${user === undefined ? '' : ` ${userArg(source, user)}`}`;

/**
 * The one saved account `--business` names; several or none is a usage error listing them. Pass
 * `match` when the caller already ran `matchBusiness`.
 */
function requireBusiness(
  environment: Environment,
  accounts: readonly SavedAccount[],
  request: BusinessRequest,
  match = matchBusiness(accounts, request.business, request.user),
): SavedAccount {
  if (match.kind === 'one') {
    return match.account;
  }

  const flags = requestFlags(request);

  if (match.kind === 'none') {
    throw new Error(
      `No saved ${environment} account matches ${flags}. Saved accounts:${candidateLines(match.candidates)}`,
    );
  }

  const [first] = match.candidates;
  const sameBusiness =
    first !== undefined &&
    match.candidates.every(({ account }) => account.businessId === first.account.businessId);

  // Several users of one business: only --user (or APPBUILDER_USER) can tell them apart.
  if (sameBusiness) {
    const { source } = request;

    throw new Error(
      `${flags} matches several saved ${environment} users of the same business. ${source === 'env' ? `Set ${USER_ENV}` : 'Pass --user'} too, for example \`${requestFlags({ business: first.account.businessId, user: first.account.userId, source })}\`:${match.candidates
        .map(
          (candidate) =>
            `\n  ${userArg(source, candidate.account.userId)}: ${accountSummary(candidate)}`,
        )
        .join('')}`,
    );
  }

  throw new Error(
    `${flags} matches several saved ${environment} accounts. ${request.source === 'env' ? `Set ${BUSINESS_ENV} to` : 'Pass'} one of these business ids instead:${candidateLines(match.candidates)}`,
  );
}

export type AccountEnvironment =
  | { ok: true; environment: Environment }
  | {
      ok: false;
      problem: Extract<SessionEnvironment, { ok: false }>['problem'];
      message: string;
      /** The environments to choose among, for `several_sessions`. */
      environments: Environment[];
    };

/**
 * The environment a command uses: --env if given; else, without a named account, the only
 * signed-in one. With one, the only environment where the name matches a saved account, current
 * or not; several are a choice. A name that matches nowhere resolves to the only environment with
 * saved accounts, current or not, so the no-match error lists them.
 */
export async function resolveAccountEnvironment(
  env: string | undefined,
  request: AccountRequest | undefined,
  store: Pick<OAuthStore, 'listSessions' | 'listAccounts'>,
): Promise<AccountEnvironment> {
  const resolveSignedIn = async (
    list: () => Promise<Environment[]>,
  ): Promise<AccountEnvironment> => {
    let environments: Environment[] = [];
    const resolved = await resolveSessionEnvironment(env, async () => {
      environments = await list();

      return environments;
    });

    return resolved.ok ? resolved : { ...resolved, environments };
  };

  if (request === undefined || env !== undefined) {
    return resolveSignedIn(() => store.listSessions());
  }

  const saved = await Promise.all(
    ENVIRONMENTS.map(async (environment) => ({
      environment,
      accounts: await store.listAccounts(environment),
    })),
  );
  const matching = saved
    .filter(
      ({ accounts }) => matchBusiness(accounts, request.business, request.user).kind !== 'none',
    )
    .map(({ environment }) => environment);
  const [only] = matching;

  if (matching.length === 1 && only !== undefined) {
    return { ok: true, environment: only };
  }

  if (matching.length > 1) {
    return {
      ok: false,
      problem: 'several_sessions',
      message: `${requestFlags(request)} matches saved accounts in several environments; pass --env <env>: ${matching.join(', ')}`,
      environments: matching,
    };
  }

  // Matches nowhere: the only environment with saved accounts, current or not, so the no-match
  // error lists them.
  return resolveSignedIn(() =>
    Promise.resolve(
      saved.filter(({ accounts }) => accounts.length > 0).map(({ environment }) => environment),
    ),
  );
}

/**
 * The saved account `request` names among `accounts`, current or not; none or several is a usage
 * error that lists them. Never falls back to the current account.
 */
export const requireNamedAccount = (
  environment: Environment,
  accounts: readonly SavedAccount[],
  request: AccountRequest,
): OAuthAccount => requireBusiness(environment, accounts, request).account;

/** `accountRequest` for a command that throws its usage errors. */
export function requireAccountRequest(
  flags: AccountFlags,
  processEnv: Readonly<Record<string, string | undefined>>,
): AccountRequest | undefined {
  const resolved = accountRequest(flags, processEnv);

  if (!resolved.ok) {
    throw new Error(resolved.message);
  }

  return resolved.request;
}

function listAccounts(
  environment: Environment,
  accounts: readonly SavedAccount[],
  json: boolean,
  deps: AuthCommandDeps,
): void {
  if (json) {
    deps.writeStdout(
      `${JSON.stringify(
        accounts.map(({ account, session, current }) => ({
          businessId: account.businessId,
          userId: account.userId,
          businessName: session?.businessName ?? null,
          fullName: session?.fullName ?? null,
          email: session?.email ?? null,
          current,
          readable: session !== undefined,
        })),
      )}\n`,
    );

    return;
  }

  if (accounts.length === 0) {
    deps.writeStdout(`No saved accounts for ${environment}.\n`);

    return;
  }

  for (const entry of accounts) {
    deps.writeStdout(`${accountSummary(entry)}${entry.current ? ' (current)' : ''}\n`);
  }
}

/** Why `--business` needs the browser, for the guidance printed before it opens. */
type BrowserReason =
  | { kind: 'expired'; account: SavedAccount }
  | { kind: 'not_saved'; request: BusinessRequest };

/**
 * Which account `login` signs in as: a saved one (from `--business` or the picker), the browser
 * sign-in (with the reason when `--business` asked for an account that isn't saved), or
 * undefined when the person cancelled the picker.
 */
async function chooseAccount(
  environment: Environment,
  options: LoginCommandOptions,
  accounts: readonly SavedAccount[],
  deps: AuthCommandDeps,
): Promise<SavedAccount | BrowserReason | typeof BROWSER_PICK | undefined> {
  if (options.business !== undefined) {
    const request = { business: options.business, user: options.user };

    const match = matchBusiness(accounts, request.business, request.user);

    // No saved account matches: the browser, with guidance an agent can relay, whatever else is
    // saved. That's also how a printed retry after a mismatched sign-in gets back here. Several
    // matches stay a usage error that lists them.
    return match.kind === 'none'
      ? { kind: 'not_saved', request }
      : requireBusiness(environment, accounts, request, match);
  }

  if (accounts.length === 0) {
    return BROWSER_PICK;
  }

  if (deps.pickAccount === undefined || !deps.isInteractive()) {
    deps.writeStderr(
      `Saved accounts for ${environment} exist; pass --business <id> to switch without the browser, or --list to see them.\n`,
    );

    return BROWSER_PICK;
  }

  return pickedAccount(
    await deps.pickAccount(`Sign in to ${environment}`, accountPickerItems(accounts)),
    accounts,
  );
}

/**
 * The block printed to stderr before a `--business` browser sign-in: why, that a sign-in window
 * is opening, and which business to choose. `login` prints the URL, and what to do with it,
 * right after it. At a terminal it speaks to the person; otherwise to the agent or script running the
 * command, which relays it: the person signs in, never the reader.
 */
function browserGuidance(
  environment: Environment,
  reason: BrowserReason,
  interactive: boolean,
): string {
  const why =
    reason.kind === 'expired'
      ? `The saved sign-in for ${accountSummary(reason.account)} has expired and was removed.`
      : `There's no saved ${environment} account for ${JSON.stringify(reason.request.business)}${reason.request.user === undefined ? '' : ` with user ${JSON.stringify(reason.request.user)}`}.`;
  const business =
    reason.kind === 'expired'
      ? businessLabel(
          reason.account.session?.businessName &&
            JSON.stringify(reason.account.session.businessName),
          reason.account.account.businessId,
        )
      : JSON.stringify(reason.request.business);
  const user =
    reason.kind === 'expired'
      ? (reason.account.session?.email ?? reason.account.account.userId)
      : reason.request.user;
  const choice = `the business ${business}${user === undefined ? '' : `, signed in as ${user}`}`;

  // No URL sentence here: `login` prints the URL right after, with a line that says what to do.
  return interactive
    ? `${why}
A browser window is opening to sign in to Kizen ${environment}. On the consent page, choose ${choice}.
`
    : `${why}
Waiting for the user to sign in to Kizen ${environment} in a browser window. Ask them to choose ${choice}.
`;
}

/**
 * What a `--business` browser sign-in must be to become current. After an expired saved account,
 * exactly that account: `--business` already resolved to it. With no saved match, the request.
 */
function browserTarget(
  environment: Environment,
  reason: BrowserReason,
): { accepts: (identity: KizenIdentity) => boolean; requested: string; retry: string } {
  if (reason.kind === 'expired') {
    const { account } = reason.account;

    return {
      accepts: (identity) => sameAccount(identity, account),
      requested: accountSummary(reason.account),
      retry: `${loginCommandFor(environment)} ${requestFlags({ business: account.businessId, user: account.userId })}`,
    };
  }

  return {
    accepts: (identity) => matchesRequest(identity, reason.request),
    requested: requestFlags(reason.request),
    retry: `${loginCommandFor(environment)} ${requestFlags(reason.request)}`,
  };
}

export const runLogin = guarded<LoginCommandOptions>(async (options, deps) => {
  const environment = requireEnvironment(options.env ?? DEFAULT_LOGIN_ENVIRONMENT);

  if (options.json === true && options.list !== true) {
    throw new Error('--json only applies with --list.');
  }

  if (options.user !== undefined && options.business === undefined) {
    throw new Error('--user only applies with --business.');
  }

  if (options.list === true && options.business !== undefined) {
    throw new Error("--list can't be combined with --business.");
  }

  const accounts = await deps.store.listAccounts(environment);

  if (options.list === true) {
    listAccounts(environment, accounts, options.json === true, deps);

    return;
  }

  let chosen = await chooseAccount(environment, options, accounts, deps);

  if (chosen === undefined) {
    deps.writeStderr('Cancelled.\n');
    deps.setExitCode(1);

    return;
  }

  if (chosen !== BROWSER_PICK && !('kind' in chosen)) {
    const saved = chosen;
    const { account } = saved;

    deps.writeStderr(`Switching to ${accountSummary(saved)} on ${environment}.\n`);

    const session = await switchAccount(environment, account, {
      store: deps.store,
      provider: deps.tokenProvider(environment, { account }),
      identify: deps.identify,
    });

    if (session !== undefined) {
      signedInOutput(deps, session);

      return;
    }

    chosen = { kind: 'expired', account: saved };
  }

  if (chosen === BROWSER_PICK) {
    deps.writeStderr(`Signing in to ${environment}.\n`);
    signedInOutput(
      deps,
      await login(environment, deps.loginDeps, { interactive: deps.isInteractive() }),
    );

    return;
  }

  // A --business (or picked) account through the browser: explain first, and only make the
  // result current if it's the account that was asked for.
  const interactive = deps.isInteractive();
  const target = browserTarget(environment, chosen);

  deps.writeStderr(browserGuidance(environment, chosen, interactive));

  const session = await login(environment, deps.loginDeps, {
    makeCurrent: target.accepts,
    interactive,
  });

  if (target.accepts(session)) {
    signedInOutput(deps, session);

    return;
  }

  // Not the account asked for: saved, never made current. It may be the one that already is.
  const current = await deps.store.readSession(environment).catch(() => null);
  const alreadyCurrent = current !== null && sameAccount(current, session);
  const summary = accountSummary({ account: session, session, current: false });
  const who = interactive ? 'You' : 'The user';
  const saved = alreadyCurrent
    ? `That's already the current ${environment} account; its saved session was updated.`
    : `It was saved, but it isn't the current ${environment} account.`;
  const use = alreadyCurrent
    ? ''
    : `To use it, run \`${loginCommandFor(environment)} ${requestFlags({ business: session.businessId, user: session.userId })}\`. `;
  const retry = interactive ? 'To try again' : 'To have them try again';

  deps.writeStderr(
    `${who} signed in as ${summary}, not ${target.requested}. ${saved}
${use}${retry}, run \`${target.retry}\`.
`,
  );
  deps.setExitCode(1);
});

export const runLogout = guarded<LogoutCommandOptions>(async (options, deps) => {
  if (options.all === true && options.business !== undefined) {
    throw new Error("--all can't be combined with --business.");
  }

  if (options.user !== undefined && options.business === undefined) {
    throw new Error('--user only applies with --business.');
  }

  const resolved = await resolveSessionEnvironment(options.env, () => deps.store.listSessions());

  if (!resolved.ok) {
    if (resolved.problem !== 'not_signed_in') {
      throw new Error(resolved.message);
    }

    // Saved accounts that aren't current don't make an environment "signed in", so only --env
    // can name the one whose saved accounts to remove.
    if (options.business !== undefined) {
      throw new Error('Pass --env <env> with --business to remove a saved account.');
    }

    if (options.all === true) {
      throw new Error('Pass --env <env> with --all to remove every saved account.');
    }

    deps.writeStdout('Not signed in.\n');

    return;
  }

  const { environment } = resolved;

  if (options.business !== undefined) {
    const accounts = await deps.store.listAccounts(environment);

    if (accounts.length === 0) {
      deps.writeStdout(`No saved accounts for ${environment}.\n`);

      return;
    }

    const chosen = requireBusiness(environment, accounts, {
      business: options.business,
      user: options.user,
    });
    const { removed, current } = await deps.store.removeAccount(environment, chosen.account);

    deps.writeStdout(
      removed || current
        ? `Removed the saved ${environment} account ${accountSummary(chosen)} from this machine.${current ? ` You're no longer signed in to ${environment}.` : ''}\n`
        : `No saved ${environment} account ${accountSummary(chosen)}.\n`,
    );

    return;
  }

  if (options.all === true) {
    const { signedIn, removed } = await deps.store.signOutAll(environment);

    deps.writeStdout(
      signedIn || removed > 0
        ? `Signed out of ${environment}. Removed ${String(removed)} saved ${removed === 1 ? 'account' : 'accounts'} from this machine.\n`
        : `No saved accounts for ${environment}.\n`,
    );

    return;
  }

  // Never reads the session file, so an unreadable session is removed too. Other saved accounts
  // stay.
  const deleted = await deps.store.signOut(environment);

  deps.writeStdout(
    deleted
      ? `Signed out of ${environment}. The session was removed from this machine.\n`
      : `Not signed in to ${environment}.\n`,
  );
});

export interface WhoamiCommandOptions extends AuthCommandOptions, AccountFlags {}

export const runWhoami = guarded<WhoamiCommandOptions>(async (options, deps) => {
  const request = requireAccountRequest(options, deps.processEnv);
  const environment = await sessionEnvironment(options.env, deps.store, request);
  const account =
    request === undefined
      ? undefined
      : requireNamedAccount(environment, await deps.store.listAccounts(environment), request);

  deps.writeStdout(
    identityLines(
      environment,
      await deps.identify(
        deps.tokenProvider(environment, account === undefined ? undefined : { account }),
      ),
    ),
  );
});

function serverEnvironment(serverUrl: string): { environment: Environment; origin: string } {
  let origin: string;

  try {
    origin = new URL(serverUrl).origin;
  } catch {
    throw new Error(
      "CLAUDE_CODE_MCP_SERVER_URL is not a valid URL, so auth-header won't send a token.",
    );
  }

  const environment = ENVIRONMENTS.find((candidate) => apiOriginFor(candidate) === origin);

  if (environment === undefined) {
    throw new Error(
      `No Kizen environment matches the MCP server ${origin}, so auth-header won't send it a token.`,
    );
  }

  return { environment, origin };
}

/**
 * Origin guard: with CLAUDE_CODE_MCP_SERVER_URL set, its origin must match a Kizen environment
 * and --env must agree, so a token only goes to the environment it belongs to. Without it,
 * --env, else the only signed-in environment.
 */
async function headerEnvironment(
  env: string | undefined,
  deps: AuthCommandDeps,
): Promise<Environment> {
  const explicit = env === undefined ? undefined : requireEnvironment(env);
  const serverUrl = deps.processEnv.CLAUDE_CODE_MCP_SERVER_URL;

  if (serverUrl !== undefined && serverUrl !== '') {
    const server = serverEnvironment(serverUrl);

    if (explicit !== undefined && explicit !== server.environment) {
      throw new Error(
        `--env ${explicit} doesn't match the MCP server ${server.origin} (${server.environment}), so auth-header won't send it a token.`,
      );
    }

    return server.environment;
  }

  return explicit ?? sessionEnvironment(undefined, deps.store);
}

export interface AuthHeaderCommandOptions extends AuthCommandOptions {
  business?: string;
  user?: string;
}

/** The account `--business` and `--user` bind `auth-header` to, if given (both or neither). */
function boundAccount(options: AuthHeaderCommandOptions): OAuthAccount | undefined {
  const { business, user } = options;

  if (business === undefined && user === undefined) {
    return undefined;
  }

  if (business === undefined || user === undefined) {
    throw new Error('auth-header takes --business and --user together.');
  }

  return { businessId: business, userId: user };
}

/**
 * Claude Code `headersHelper`, and kizen's `KIZEN_AUTH_HELPER` (bound with `--business` and
 * `--user`). Bound, it serves that saved account from its own file, current or not, so it's never
 * another account's token; unbound, the current account. It never reads `APPBUILDER_BUSINESS`, so
 * a headersHelper always follows the current account. Failures print one stderr line and nothing
 * to stdout.
 */
export const runAuthHeader: AuthCommand<AuthHeaderCommandOptions> = async (options, deps) => {
  let line: string;

  try {
    const account = boundAccount(options);
    const environment = await headerEnvironment(options.env, deps);
    const { requestTimeoutMs } = deps.authHeaderTimeouts;
    const token = await deps
      .tokenProvider(environment, {
        requestTimeoutMs,
        ...(account !== undefined && { account }),
      })
      .getAccessToken();

    line = `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`;
  } catch (error) {
    report(deps, error, { prefix: 'appbuilder auth-header', oneLine: true });

    return;
  }

  deps.writeStdout(line);
};
