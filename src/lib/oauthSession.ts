/**
 * The OAuth login flow and the access-token provider the Kizen client uses for
 * Bearer auth. Tokens are only ever handed to the client; nothing here prints
 * or logs a token or the PKCE verifier.
 */
import { BASE_URLS } from '../../shared/lib/kizenUrls.js';
import { isEnvironment, unknownEnvironmentMessage, type Environment } from './credentials.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  DEFAULT_LOGIN_ENVIRONMENT,
  discover,
  issuerFor,
  loginCommandFor,
  OAuthError,
  openBrowser,
  randomState,
  registerClient,
  requestToken,
  startLoopbackServer,
  type AuthServerMetadata,
  type LoopbackServer,
  type TokenResponse,
} from './oauth.js';
import type { LockOptions, OAuthSession, OAuthStore } from './oauthStore.js';

/** Refresh proactively when the access token has less than this left. */
export const REFRESH_LEEWAY_MS = 60_000;

/**
 * How long a refresh that hit `invalid_client` waits for the clients.json lock
 * to forget the client. That lock is only held for a file rewrite, and the wait
 * sits inside auth-header's 10s budget, so it is short and best-effort: a
 * missed forget only costs the next login one failed attempt.
 */
export const FORGET_CLIENT_WAIT_MS = 500;

const loginRequired = (environment: Environment, reason: string): OAuthError =>
  new OAuthError('login_required', `${reason} Run \`${loginCommandFor(environment)}\` to sign in.`);

export interface LoginDeps {
  store: OAuthStore;
  fetch: typeof fetch;
  now: () => number;
  /** Prints a progress line for the user. Never receives a token. */
  print: (line: string) => void;
  openBrowser: (url: string) => void;
  startLoopbackServer: (options: { state: string; timeoutMs?: number }) => Promise<LoopbackServer>;
  /** How long to wait for the browser callback. */
  timeoutMs?: number;
  /** Bound on each request to the authorization server. */
  requestTimeoutMs?: number;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);
const defaultNow = (): number => Date.now();

export function createDefaultLoginDeps(store: OAuthStore): LoginDeps {
  return {
    store,
    fetch: defaultFetch,
    now: defaultNow,
    print: (line) => {
      process.stderr.write(`${line}\n`);
    },
    openBrowser,
    startLoopbackServer,
  };
}

const toSession = (
  environment: Environment,
  metadata: AuthServerMetadata,
  clientId: string,
  tokens: TokenResponse,
  now: number,
): OAuthSession => ({
  environment,
  issuer: metadata.issuer,
  clientId,
  tokenEndpoint: metadata.tokenEndpoint,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  expiresAt: now + tokens.expiresIn * 1000,
  scope: tokens.scope,
});

async function authorizeOnce(
  metadata: AuthServerMetadata,
  clientId: string,
  deps: LoginDeps,
): Promise<TokenResponse> {
  const { verifier, challenge } = createPkcePair();
  const state = randomState();
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

    deps.print('Opening your browser to sign in to Kizen. If it does not open, visit:');
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
      deps.requestTimeoutMs,
    );
  } finally {
    await server.close();
  }
}

/**
 * Discovers the environment's authorization server, registers (or reuses the
 * cached) public client, runs the browser login and stores the session.
 *
 * A stale cached client_id never blocks more than one attempt:
 * - Kizen (django-oauth-toolkit) must not redirect for an unknown client_id
 *   (RFC 6749 §4.1.2.1), so the browser shows an error page and the CLI only
 *   sees a timeout. A timeout with a cached client therefore drops the cache,
 *   and the next login registers afresh. A timeout can't be told apart from a
 *   user who walked away, so this doesn't retry on its own; the cost of a
 *   wrong guess is one extra registration.
 * - An `invalid_client` that does reach the CLI (token endpoint, or a callback
 *   error) re-registers exactly once and runs the browser flow again.
 */
export async function login(environment: Environment, deps: LoginDeps): Promise<OAuthSession> {
  const metadata = await discover(
    issuerFor(BASE_URLS[environment]),
    deps.fetch,
    deps.requestTimeoutMs,
  );
  const register = async (): Promise<string> => {
    const clientId = await registerClient(metadata, deps.fetch, deps.requestTimeoutMs);

    await deps.store.writeClientId(metadata.issuer, clientId);

    return clientId;
  };

  const cached = await deps.store.readClientId(metadata.issuer);
  let clientId = cached ?? (await register());
  let tokens: TokenResponse;

  try {
    tokens = await authorizeOnce(metadata, clientId, deps);
  } catch (err) {
    if (err instanceof OAuthError && err.code === 'timeout' && cached !== undefined) {
      await deps.store.forgetClientId(metadata.issuer);
      throw new OAuthError(
        'timeout',
        `${err.message}. If the browser showed an error instead of a consent page, the saved app registration was stale; it has been cleared. Run \`${loginCommandFor(environment)}\` again.`,
      );
    }

    if (!(err instanceof OAuthError && err.code === 'invalid_client' && cached !== undefined)) {
      throw err;
    }

    await deps.store.forgetClientId(metadata.issuer);
    deps.print('The saved app registration was rejected; registering again.');
    clientId = await register();
    tokens = await authorizeOnce(metadata, clientId, deps);
  }

  const session = toSession(environment, metadata, clientId, tokens, deps.now());
  // Only around the write, never the browser wait. Under the lock, an in-flight
  // refresh either finishes first (and this overwrites it) or re-reads this
  // session afterwards, so it never writes the old login back over it.
  const release = await deps.store.acquireLock(environment);

  try {
    await deps.store.writeSession(session);
  } finally {
    await release();
  }

  return session;
}

/** What the Kizen client needs for Bearer auth. */
export interface BearerTokenProvider {
  environment: Environment;
  getAccessToken: () => Promise<string>;
  /** Refreshes after `rejected` was refused, unless the session already moved past it. */
  refreshAccessToken: (rejected: string) => Promise<string>;
}

export interface TokenProviderOptions {
  lock?: LockOptions;
  /** Bound on each token request; keep it under the lock's stale window. */
  requestTimeoutMs?: number;
}

export interface TokenProviderDeps extends TokenProviderOptions {
  store: OAuthStore;
  fetch: typeof fetch;
  now: () => number;
}

/**
 * Hands out the environment's access token, refreshing it when it has under a
 * minute left or after a 401. Concurrent refreshes in this process share one
 * promise; across processes the store's lock file serializes them, and the
 * session is re-read under the lock so a token another process already rotated
 * is used rather than spending the (rotating) refresh token again. Login and
 * logout take the same lock to write or delete the session, so the re-read
 * also sees a newer login or a logout, and a refresh never writes the session
 * it started from back over either.
 */
export function createTokenProvider(
  environment: Environment,
  deps: TokenProviderDeps,
): BearerTokenProvider {
  let inflight: Promise<string> | undefined;

  const fresh = (session: OAuthSession): boolean =>
    session.expiresAt - deps.now() > REFRESH_LEEWAY_MS;

  const readOrThrow = async (): Promise<OAuthSession> => {
    const session = await deps.store.readSession(environment);

    if (session === null) {
      throw loginRequired(environment, `You're not signed in to ${environment}.`);
    }

    return session;
  };

  const doRefresh = async (rejected: string): Promise<string> => {
    const release = await deps.store.acquireLock(environment, deps.lock);

    try {
      const current = await readOrThrow();

      if (current.accessToken !== rejected && fresh(current)) {
        return current.accessToken;
      }

      if (current.refreshToken === undefined) {
        await deps.store.deleteSession(environment);
        throw loginRequired(environment, `The ${environment} session has expired.`);
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
          deps.requestTimeoutMs,
        );
      } catch (err) {
        if (
          err instanceof OAuthError &&
          (err.code === 'invalid_grant' || err.code === 'invalid_client')
        ) {
          await deps.store.deleteSession(environment);

          if (err.code === 'invalid_client') {
            await deps.store
              .forgetClientId(current.issuer, { waitMs: FORGET_CLIENT_WAIT_MS, retryMs: 50 })
              .catch(() => undefined);
          }

          throw loginRequired(environment, `The ${environment} session is no longer valid.`);
        }

        throw err;
      }

      const next: OAuthSession = {
        ...current,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? current.refreshToken,
        expiresAt: deps.now() + tokens.expiresIn * 1000,
        scope: tokens.scope ?? current.scope,
      };

      // Under the lock, so nothing else changed the session since the re-read. A
      // holder paused past staleMs could still write late; that's the lease trade-off.
      await deps.store.writeSession(next);

      return next.accessToken;
    } finally {
      await release();
    }
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

/** `createTokenProvider` with the real `fetch` and clock. */
export const createDefaultTokenProvider = (
  environment: Environment,
  store: OAuthStore,
  options: TokenProviderOptions = {},
): BearerTokenProvider =>
  createTokenProvider(environment, { store, fetch: defaultFetch, now: defaultNow, ...options });

const NOT_SIGNED_IN_MESSAGE = `You're not signed in. Run \`${loginCommandFor(DEFAULT_LOGIN_ENVIRONMENT)}\` (or another --env).`;

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
    return isEnvironment(env)
      ? { ok: true, environment: env }
      : { ok: false, problem: 'unknown_environment', message: unknownEnvironmentMessage(env) };
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
