/**
 * The OAuth login flow and the Bearer access-token provider. Nothing here prints or logs a
 * token or the PKCE verifier; tokens only go to the Kizen client.
 */
import { randomUUID } from 'node:crypto';
import { apiOriginFor } from '../../shared/lib/kizenUrls.js';
import { parseEnvironment, type Environment } from './credentials.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  DEFAULT_LOGIN_ENVIRONMENT,
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
import {
  mutateSession,
  whenConfirmed,
  withSessionLock,
  type LockOptions,
  type OAuthSession,
  type OAuthStore,
} from './oauthStore.js';

const REFRESH_LEEWAY_MS = 60_000;

/**
 * After `invalid_client`, the best-effort wait for the clients.json lock to forget the client.
 * Short because it sits inside auth-header's 10s budget; a miss costs the next login one attempt.
 */
export const FORGET_CLIENT_WAIT_MS = 500;

export interface LoginDeps {
  store: OAuthStore;
  fetch: typeof fetch;
  now: () => number;
  /** Prints a progress line for the user. Never receives a token. */
  print: (line: string) => void;
  openBrowser: typeof openBrowser;
  startLoopbackServer: typeof startLoopbackServer;
  timeoutMs?: number;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);
const defaultNow = (): number => Date.now();

export const createDefaultLoginDeps = (
  store: OAuthStore,
  print: LoginDeps['print'],
): LoginDeps => ({
  store,
  fetch: defaultFetch,
  now: defaultNow,
  print,
  openBrowser,
  startLoopbackServer,
});

/** `base` with newly issued `tokens`; a token or scope the response leaves out keeps `base`'s. */
const withTokens = (
  base: Omit<OAuthSession, 'accessToken' | 'expiresAt'>,
  tokens: TokenResponse,
  now: number,
): OAuthSession => ({
  ...base,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken ?? base.refreshToken,
  expiresAt: now + tokens.expiresIn * 1000,
  scope: tokens.scope ?? base.scope,
});

async function authorizeOnce(
  metadata: AuthServerMetadata,
  clientId: string,
  deps: LoginDeps,
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
    );
  } finally {
    await server.close();
  }
}

/**
 * A stale cached client_id never blocks more than one attempt. The server must not redirect for
 * an unknown client_id (RFC 6749 §4.1.2.1), so the CLI only sees a timeout: a timeout with a
 * cached client drops the cache without retrying (it may be a user who walked away). An
 * `invalid_client` that reaches the CLI re-registers once and runs the browser flow again.
 */
export async function login(environment: Environment, deps: LoginDeps): Promise<OAuthSession> {
  const metadata = await discover(apiOriginFor(environment), deps.fetch);
  const register = async (): Promise<string> => {
    const clientId = await registerClient(metadata, deps.fetch);

    await deps.store.writeClientId(metadata.issuer, clientId);

    return clientId;
  };

  const cached = await deps.store.readClientId(metadata.issuer);
  let clientId = cached ?? (await register());
  let tokens: TokenResponse;

  try {
    tokens = await authorizeOnce(metadata, clientId, deps);
  } catch (err) {
    if (
      !(
        err instanceof OAuthError &&
        (err.code === 'timeout' || err.code === 'invalid_client') &&
        cached !== undefined
      )
    ) {
      throw err;
    }

    await deps.store.forgetClientId(metadata.issuer);

    if (err.code === 'timeout') {
      throw new OAuthError(
        'timeout',
        `${err.message}. If the browser showed an error instead of a consent page, the saved app registration was stale; it has been cleared. Run \`${loginCommandFor(environment)}\` again.`,
      );
    }

    deps.print('The saved app registration was rejected; registering again.');
    clientId = await register();
    tokens = await authorizeOnce(metadata, clientId, deps);
  }

  const session = withTokens(
    {
      environment,
      loginId: randomUUID(),
      issuer: metadata.issuer,
      clientId,
      tokenEndpoint: metadata.tokenEndpoint,
      refreshToken: undefined,
      scope: undefined,
    },
    tokens,
    deps.now(),
  );

  // Locked only around the write, never the browser wait.
  await mutateSession(deps.store, environment, () => deps.store.writeSession(session));

  return session;
}

export interface BearerTokenProvider {
  environment: Environment;
  getAccessToken: () => Promise<string>;
  /** Refreshes after `rejected` was refused, unless the session already moved past it. */
  refreshAccessToken: (rejected: string) => Promise<string>;
}

export interface TokenProviderOptions {
  lock?: LockOptions;
  /** Keep it under the lock's stale window. */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export interface TokenProviderDeps extends TokenProviderOptions {
  store: OAuthStore;
  fetch: typeof fetch;
  now: () => number;
}

/**
 * Refreshes with under a minute left or after a 401. In-process refreshes share one promise;
 * across processes the lock serializes them and the session is re-read under it, so a token
 * another process already rotated is used rather than spending the refresh token again.
 *
 * Pinned to the first session's `loginId`: a command resolves who it acts as once, so after
 * another login (maybe another business) every read throws rather than hand out its tokens.
 */
export function createTokenProvider(
  environment: Environment,
  deps: TokenProviderDeps,
): BearerTokenProvider {
  let inflight: Promise<string> | undefined;
  let pinnedLoginId: string | undefined;

  const fresh = (session: OAuthSession): boolean =>
    session.expiresAt - deps.now() > REFRESH_LEEWAY_MS;

  const readOrThrow = async (): Promise<OAuthSession> => {
    const session = await deps.store.readSession(environment);

    if (session === null) {
      throw loginRequired(environment, `You're not signed in to ${environment}.`);
    }

    pinnedLoginId ??= session.loginId;

    if (session.loginId !== pinnedLoginId) {
      throw new OAuthError(
        'login_required',
        `The ${environment} sign-in changed while this command was running. Run it again.`,
      );
    }

    return session;
  };

  const doRefresh = async (rejected: string): Promise<string> => {
    const lease = await deps.store.acquireLock(environment, deps.lock);

    try {
      const current = await readOrThrow();

      if (current.accessToken !== rejected && fresh(current)) {
        return current.accessToken;
      }

      // Each attempt re-reads through the pin and mutates only if the session still holds the
      // refresh token this refresh spent; resolves false if someone else rotated it.
      const commit = (mutate: () => Promise<unknown>): Promise<boolean> =>
        withSessionLock(
          deps.store,
          environment,
          async (lock) =>
            (await readOrThrow()).refreshToken === current.refreshToken &&
            whenConfirmed(lock, () => mutate().then(() => true)),
          { lock: deps.lock, held: lease },
        );

      if (current.refreshToken === undefined) {
        await commit(() => deps.store.deleteSession(environment));
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
          // Only the session this refresh was refused for; a newer login stays.
          const deleted = await commit(() => deps.store.deleteSession(environment));

          if (deleted && err.code === 'invalid_client') {
            await deps.store
              .forgetClientId(current.issuer, { waitMs: FORGET_CLIENT_WAIT_MS, retryMs: 50 })
              .catch(() => undefined);
          }

          throw loginRequired(environment, `The ${environment} session is no longer valid.`);
        }

        throw err;
      }

      const next = withTokens(current, tokens, deps.now());

      // Newer tokens another refresh stored stay; this command uses the one it was just issued.
      await commit(() => deps.store.writeSession(next));

      return next.accessToken;
    } finally {
      await lease();
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
