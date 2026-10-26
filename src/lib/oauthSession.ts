/**
 * The OAuth login flow and the Bearer access-token provider. Nothing here prints or logs a
 * token or the PKCE verifier; tokens only go to the Kizen client.
 */
import { apiOriginFor } from '../../shared/lib/kizenUrls.js';
import { parseEnvironment, type Environment } from './credentials.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  DEFAULT_LOGIN_ENVIRONMENT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  discover,
  loginCommandFor,
  loginRequired,
  OAuthError,
  openBrowser,
  random256,
  registerClient,
  requestToken,
  startLoopbackServer,
  type AuthServerMetadata,
  type TokenResponse,
} from './oauth.js';
import type { KizenIdentity } from './kizenClient.js';
import type { OAuthAccount, OAuthSession, OAuthStore } from './oauthStore.js';

const REFRESH_LEEWAY_MS = 60_000;

/** `/auth/bootstrap` through `bearer`: who its tokens act as. */
export type Identify = (bearer: BearerTokenProvider) => Promise<KizenIdentity>;

export interface LoginDeps {
  store: OAuthStore;
  fetch: typeof fetch;
  now: () => number;
  /** Prints a progress line for the user. Never receives a token. */
  print: (line: string) => void;
  openBrowser: typeof openBrowser;
  startLoopbackServer: typeof startLoopbackServer;
  /** Looks up the account the new tokens belong to, before anything is saved. */
  identify: Identify;
  timeoutMs?: number;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);
const defaultNow = (): number => Date.now();

export const createDefaultLoginDeps = (
  store: OAuthStore,
  print: LoginDeps['print'],
  identify: Identify,
): LoginDeps => ({
  store,
  fetch: defaultFetch,
  now: defaultNow,
  print,
  openBrowser,
  startLoopbackServer,
  identify,
});

/** A provider for tokens that aren't saved yet: it hands out `accessToken` and never refreshes. */
const issuedTokenProvider = (
  environment: Environment,
  accessToken: string,
): BearerTokenProvider => ({
  environment,
  getAccessToken: () => Promise.resolve(accessToken),
  refreshAccessToken: () =>
    Promise.reject(loginRequired(environment, `Kizen rejected the new ${environment} sign-in.`)),
});

const notSignedIn = (environment: Environment): OAuthError =>
  loginRequired(environment, `You're not signed in to ${environment}.`);

const labelsOf = (
  identity: KizenIdentity,
): Pick<OAuthSession, 'businessName' | 'fullName' | 'email'> => ({
  businessName: identity.businessName,
  fullName: identity.fullName,
  email: identity.email,
});

/** `base` with newly issued `tokens`. */
const withTokens = (
  base: Omit<OAuthSession, 'accessToken' | 'refreshToken' | 'expiresAt'>,
  tokens: TokenResponse,
  now: number,
): OAuthSession => ({
  ...base,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  expiresAt: now + tokens.expiresIn * 1000,
});

/**
 * The line before the authorize URL. At a terminal it speaks to the person; otherwise to the
 * agent or script reading stderr, which relays the URL to the person who signs in.
 */
const urlIntro = (environment: Environment, interactive: boolean): string =>
  interactive
    ? 'Opening your browser to sign in to Kizen. If it does not open, visit:'
    : `A browser window should open for the user to sign in to Kizen ${environment}. If it doesn't, give them this URL:`;

async function authorizeOnce(
  metadata: AuthServerMetadata,
  clientId: string,
  deps: LoginDeps,
  intro: string,
): Promise<TokenResponse> {
  const { verifier, challenge } = createPkcePair();
  const state = random256();
  const server = await deps.startLoopbackServer({
    state,
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });

  try {
    const url = buildAuthorizeUrl(metadata, {
      clientId,
      redirectUri: server.redirectUri,
      state,
      codeChallenge: challenge,
    });

    deps.print(intro);
    deps.print(url);
    deps.openBrowser(url);

    const { code } = await server.result;

    return await requestToken(
      metadata.tokenEndpoint,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: server.redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      },
      deps.fetch,
    );
  } finally {
    await server.close();
  }
}

/**
 * A stale cached client_id never blocks more than one attempt. The server must not redirect for
 * an unknown client_id (RFC 6749 §4.1.2.1), so the CLI only sees a timeout: a timeout with a
 * cached client drops the cache without retrying (it may be a user who walked away).
 */
export interface LoginOptions {
  /**
   * Whether the signed-in account becomes current. When it says no, the session is saved as a
   * saved account and the pointer stays where it was. Default: always.
   */
  makeCurrent?: (identity: KizenIdentity) => boolean;
  /**
   * Whether a person is at a terminal, which decides who the line before the authorize URL
   * speaks to. Default: true.
   */
  interactive?: boolean;
}

export async function login(
  environment: Environment,
  deps: LoginDeps,
  options: LoginOptions = {},
): Promise<OAuthSession> {
  const intro = urlIntro(environment, options.interactive ?? true);
  const metadata = await discover(apiOriginFor(environment), deps.fetch);
  const cached = await deps.store.readClientId(metadata.issuer);
  const clientId = cached ?? (await registerClient(metadata, deps.fetch));

  if (cached === undefined) {
    await deps.store.writeClientId(metadata.issuer, clientId);
  }

  let tokens: TokenResponse;

  try {
    tokens = await authorizeOnce(metadata, clientId, deps, intro);
  } catch (err) {
    if (!(err instanceof OAuthError && err.code === 'timeout' && cached !== undefined)) {
      throw err;
    }

    await deps.store.forgetClientId(metadata.issuer);

    throw new OAuthError(
      'timeout',
      `${err.message}. If the browser showed an error instead of a consent page, the saved app registration was stale; it has been cleared. Run \`${loginCommandFor(environment)}\` again.`,
    );
  }

  // The account keys the session file, so nothing is saved until Kizen says whose tokens these
  // are. A failure here leaves the previous sign-in, if any, as it was.
  const identity = await deps.identify(issuedTokenProvider(environment, tokens.accessToken));
  const account = { businessId: identity.businessId, userId: identity.userId };

  const session = withTokens(
    {
      environment,
      ...account,
      ...labelsOf(identity),
      issuer: metadata.issuer,
      clientId,
      tokenEndpoint: metadata.tokenEndpoint,
    },
    tokens,
    deps.now(),
  );

  // Written (in place, for an account signed in before), then pointed to: a crash in between
  // leaves the previous account current.
  await deps.store.writeSession(session);

  if (options.makeCurrent !== undefined && !options.makeCurrent(identity)) {
    // Saved only. Read back like the pointer case, so a removal meanwhile isn't reported as saved.
    if ((await deps.store.readAccount(environment, account)) === null) {
      throw notSignedIn(environment);
    }

    return session;
  }

  await deps.store.setCurrent(environment, account);

  // Read back through the pointer, so a session file removed in between (a logout of this
  // account in another terminal) fails here instead of reporting a sign-in that isn't there.
  if ((await deps.store.readSession(environment)) === null) {
    throw notSignedIn(environment);
  }

  return session;
}

export interface SwitchDeps {
  store: OAuthStore;
  /** A provider pinned to the saved account being switched to (`account` option). */
  provider: BearerTokenProvider;
  identify: Identify;
}

/**
 * Makes a saved account current, after proving its tokens still work: `/auth/bootstrap` through
 * a provider for that account, so an expiring token is refreshed under the usual rules first.
 * Resolves to the now-current session, or undefined when the saved sign-in is no longer valid
 * (its refresh token was refused, so the provider deleted its file) and a browser sign-in is
 * needed. Any other failure, a transient one included, rejects and leaves the pointer alone.
 */
export async function switchAccount(
  environment: Environment,
  account: OAuthAccount,
  deps: SwitchDeps,
): Promise<OAuthSession | undefined> {
  try {
    await deps.identify(deps.provider);
  } catch (err) {
    // Transient failures never delete, so a missing file means the sign-in was refused (or
    // removed by a logout --all meanwhile): either way only the browser can sign it in again.
    const gone = await deps.store.readAccount(environment, account).then(
      (session) => session === null,
      () => false,
    );

    if (gone) {
      return undefined;
    }

    throw err;
  }

  await deps.store.setCurrent(environment, account);

  const current = await deps.store.readSession(environment);

  if (current === null) {
    throw notSignedIn(environment);
  }

  return current;
}

export interface BearerTokenProvider {
  environment: Environment;
  getAccessToken: () => Promise<string>;
  /** Refreshes after `rejected` was refused, unless the session already moved past it. */
  refreshAccessToken: (rejected: string) => Promise<string>;
}

export interface TokenProviderOptions {
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Serve this saved account, current or not, reading its own file instead of the pointer. Used
   * to verify an account before switching to it, and for a command that names a saved account;
   * never moves the pointer.
   */
  account?: OAuthAccount;
}

export interface TokenProviderDeps extends TokenProviderOptions {
  store: OAuthStore;
  fetch: typeof fetch;
  now: () => number;
}

/**
 * Refreshes with under a minute left or after a 401. In-process refreshes share one promise.
 * Across processes the token request isn't locked: Kizen hands a refresh token presented again
 * within its grace window the same pair, and refuses it with invalid_grant after that without
 * revoking anything. So each refresh re-reads the session before acting on a failure, and writes
 * through `commitRefresh`, which re-reads under the account's lock (the one logout's delete takes)
 * and keeps a peer's rotation, or a logout, rather than overwriting it or signing out.
 *
 * Pinned to one account (business and user): `account`, else the current account at the first
 * read, which is the only read through the store's pointer. Every later read is of the pinned
 * account's own file, so a switch to another account meanwhile doesn't change who the command acts
 * as, and a logout of the pinned account makes the next read throw not-signed-in. Signing in again
 * to the same account replaces its file, and its new tokens are kept like a peer's rotation.
 * Writes and deletes touch only the pinned account's file, never the pointer.
 */
export function createTokenProvider(
  environment: Environment,
  deps: TokenProviderDeps,
): BearerTokenProvider {
  let inflight: Promise<string> | undefined;
  let pinned: OAuthAccount | undefined = deps.account;
  /** The read through the pointer that pins, shared by reads that start before it settles. */
  let pinning: Promise<OAuthSession> | undefined;

  const fresh = (session: OAuthSession): boolean =>
    session.expiresAt - deps.now() > REFRESH_LEEWAY_MS;

  const orThrow = (session: OAuthSession | null): OAuthSession => {
    if (session === null) {
      throw notSignedIn(environment);
    }

    return session;
  };

  const readOrThrow = async (): Promise<OAuthSession> => {
    if (pinned !== undefined) {
      return orThrow(await deps.store.readAccount(environment, pinned));
    }

    // A failed first read pins nothing, so the next read goes through the pointer again.
    pinning ??= deps.store
      .readSession(environment)
      .then((session) => {
        const current = orThrow(session);

        pinned = { businessId: current.businessId, userId: current.userId };

        return current;
      })
      .finally(() => {
        pinning = undefined;
      });

    return pinning;
  };

  /**
   * `deadline` (on `deps.now`) is set only on the retry after a peer's rotation, which runs at most
   * once and shares the first request's timeout, so a refresh never waits longer than one timeout.
   */
  const doRefresh = async (rejected: string, deadline?: number): Promise<string> => {
    const current = await readOrThrow();

    if (current.accessToken !== rejected && fresh(current)) {
      return current.accessToken;
    }

    const until = deadline ?? deps.now() + (deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    /** Re-reads through the pin: the stored session, and whether a peer rotated it since. */
    const reread = async (): Promise<{ stored: OAuthSession; rotated: boolean }> => {
      const stored = await readOrThrow();

      return { stored, rotated: stored.refreshToken !== current.refreshToken };
    };

    const remainingMs = until - deps.now();

    // Out of time for the retry: the peer's token as it is.
    if (remainingMs <= 0) {
      return current.accessToken;
    }

    let tokens: TokenResponse;

    try {
      tokens = await requestToken(
        current.tokenEndpoint,
        {
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: current.clientId,
        },
        deps.fetch,
        remainingMs,
      );
    } catch (err) {
      if (
        err instanceof OAuthError &&
        (err.code === 'invalid_grant' || err.code === 'invalid_client')
      ) {
        const { stored, rotated } = await reread();

        // A peer spent this refresh token first: use what it stored.
        if (rotated) {
          return fresh(stored) || deadline !== undefined
            ? stored.accessToken
            : doRefresh(stored.accessToken, until);
        }

        // Only this account's file, so a logout or a switch to another account meanwhile is
        // untouched. The delete takes the account's lock, so it never lands inside a peer's
        // commit, but doesn't re-check: a same-account peer write (a refresh, or a sign-in again)
        // landing between the re-read above and this unlink is lost; the cost is a re-login.
        const deleted = await deps.store.deleteSession(environment, current);

        // Best effort, and only this session's client: a login meanwhile may have registered a
        // new one. Whatever fails here, the error to report is the sign-in one below.
        if (deleted && err.code === 'invalid_client') {
          try {
            if ((await deps.store.readClientId(current.issuer)) === current.clientId) {
              await deps.store.forgetClientId(current.issuer);
            }
          } catch {
            // The next login copes with a stale or unreadable cache.
          }
        }

        throw loginRequired(environment, `The ${environment} session is no longer valid.`);
      }

      throw err;
    }

    const next = withTokens(current, tokens, deps.now());

    // Writes only this account's own file, never the pointer, so a switch to another account
    // can't be undone or replaced by it, whenever it lands. The commit re-reads that file under
    // the account's lock, which every logout's delete of it takes too (not across the request
    // above): a logout of this account, before the commit or waiting on it, leaves the file gone,
    // and this command signed out from its next read on. A peer's rotation or a sign-in again to
    // this account is kept (this command still uses the token it was issued). What's left is a
    // peer that writes without the lock, a sign-in again, landing between the commit's read and
    // its rename, which this write overwrites: its tokens are replaced by this grant's, which
    // Kizen still accepts. And when the lock isn't acquired in time, the commit goes ahead
    // without it, racing as it would unlocked. The deletes above are likewise scoped to this
    // account's file. Vault entry:
    // cli-oauth-via-kizen-dcr-what-webapp-supports-the-app-builder-poc-design-and-its-gotchas
    if ((await deps.store.commitRefresh(next, current.refreshToken)) === 'gone') {
      throw notSignedIn(environment);
    }

    return next.accessToken;
  };

  const refreshAccessToken = (rejected: string): Promise<string> => {
    inflight ??= doRefresh(rejected).finally(() => {
      inflight = undefined;
    });

    return inflight;
  };

  return {
    environment,
    async getAccessToken() {
      if (inflight) {
        return inflight;
      }

      const session = await readOrThrow();

      return fresh(session) ? session.accessToken : refreshAccessToken(session.accessToken);
    },
    refreshAccessToken,
  };
}

export const createDefaultTokenProvider = (
  environment: Environment,
  store: OAuthStore,
  options: TokenProviderOptions = {},
): BearerTokenProvider =>
  createTokenProvider(environment, {
    store,
    now: defaultNow,
    ...options,
    fetch: options.fetch ?? defaultFetch,
  });

const NOT_SIGNED_IN_MESSAGE = `You're not signed in. Run \`${loginCommandFor(DEFAULT_LOGIN_ENVIRONMENT)}\` (add \`--env <env>\` to sign in to an environment other than ${DEFAULT_LOGIN_ENVIRONMENT}).`;

export type SessionEnvironment =
  | { ok: true; environment: Environment }
  | {
      ok: false;
      problem: 'unknown_environment' | 'not_signed_in' | 'several_sessions';
      message: string;
    };

/** --env if given (and valid), else the only environment with a stored session. */
export async function resolveSessionEnvironment(
  env: string | undefined,
  listSessions: () => Promise<Environment[]>,
): Promise<SessionEnvironment> {
  if (env !== undefined) {
    const { environment, message } = parseEnvironment(env);

    return environment === undefined
      ? { ok: false, problem: 'unknown_environment', message }
      : { ok: true, environment };
  }

  const sessions = await listSessions();
  const [only] = sessions;

  if (sessions.length > 1) {
    return {
      ok: false,
      problem: 'several_sessions',
      message: `You're signed in to several environments; pass --env <env>: ${sessions.join(', ')}`,
    };
  }

  return only === undefined
    ? { ok: false, problem: 'not_signed_in', message: NOT_SIGNED_IN_MESSAGE }
    : { ok: true, environment: only };
}
