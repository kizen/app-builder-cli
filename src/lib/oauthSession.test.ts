import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from './credentials.js';
import { startLoopbackServer } from './oauth.js';
import {
  createDefaultTokenProvider,
  createTokenProvider,
  login,
  resolveSessionEnvironment,
  type BearerTokenProvider,
  type LoginDeps,
  type TokenProviderDeps,
} from './oauthSession.js';
import { createOAuthStore, type OAuthSession, type OAuthStore } from './oauthStore.js';
import {
  deferred,
  hangUntilAbort,
  httpGet,
  ISSUER,
  jsonResponse,
  lockIsFree,
  NOW,
  oauthSession,
  pausingStore,
  rejectionOf,
  TOKEN_ENDPOINT as TOKEN,
  type Deferred,
} from '../test/oauth.js';

// Deliberately not the conventional /oauth2/* paths, so passing tests prove the
// flow uses the discovered endpoints rather than hard-coded ones.
const AUTHORIZE = `${ISSUER}/discovered/authorize`;
const REGISTER = `${ISSUER}/discovered/register`;

let dir: string;
let store: OAuthStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'appbuilder-oauth-session-'));
  store = createOAuthStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tokenBody = (n: number): Record<string, unknown> => ({
  access_token: `access-${String(n)}`,
  refresh_token: `refresh-${String(n)}`,
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'read write offline_access',
});

interface FakeAuthServer {
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  registrations: () => number;
  tokenRequests: () => URLSearchParams[];
}

/** A fake Kizen authorization server behind `fetch`. `token` decides each token response. */
function fakeAuthServer(
  token: (
    params: URLSearchParams,
    index: number,
    init: RequestInit,
  ) => Response | Promise<Response> = (_, i) => jsonResponse(tokenBody(i + 1)),
): FakeAuthServer {
  let registered = 0;
  const tokenParams: URLSearchParams[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = input as string;

    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Promise.resolve(
        jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: AUTHORIZE,
          token_endpoint: TOKEN,
          registration_endpoint: REGISTER,
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      );
    }

    if (url === REGISTER && init?.method === 'POST') {
      registered += 1;

      return Promise.resolve(jsonResponse({ client_id: `registered-${String(registered)}` }, 201));
    }

    if (url === TOKEN && init?.method === 'POST') {
      const params = new URLSearchParams(init.body as string);

      tokenParams.push(params);

      return Promise.resolve(token(params, tokenParams.length - 1, init));
    }

    return Promise.resolve(new Response('not found', { status: 404 }));
  });

  return {
    fetch: fetchMock,
    registrations: () => registered,
    tokenRequests: () => tokenParams,
  };
}

interface FakeBrowser {
  open: (url: string) => void;
  authorizeUrls: URL[];
}

/** Plays the user + Kizen consent screen: calls back to redirect_uri with `reply`'s params. */
function fakeBrowser(
  reply: (authorize: URL, index: number) => Record<string, string> | null,
): FakeBrowser {
  const authorizeUrls: URL[] = [];

  return {
    authorizeUrls,
    open: (raw) => {
      const url = new URL(raw);
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '');

      authorizeUrls.push(url);

      const params = reply(url, authorizeUrls.length - 1);

      // null: the browser never comes back (e.g. Kizen showed its own error page).
      if (params === null) {
        return;
      }

      for (const [key, value] of Object.entries(params)) {
        callback.searchParams.set(key, value);
      }

      void httpGet(callback.toString());
    },
  };
}

const approve = (authorize: URL): Record<string, string> => ({
  code: 'auth-code',
  state: authorize.searchParams.get('state') ?? '',
});

const loginDeps = (
  server: FakeAuthServer,
  browser: FakeBrowser,
  printed: string[] = [],
): LoginDeps => ({
  store,
  fetch: server.fetch,
  now: () => NOW,
  print: (line) => {
    printed.push(line);
  },
  openBrowser: browser.open,
  startLoopbackServer,
  timeoutMs: 5000,
});

/** `store`, but signals the first time something asks for the session lock. */
const signallingStore = (atLock: Deferred<void>): OAuthStore => ({
  ...store,
  acquireLock: (environment, options) => {
    atLock.resolve();

    return store.acquireLock(environment, options);
  },
});

/** A staging token provider on `store` and `server`'s fetch with a short lock; override what a test needs. */
const provider = (
  server: FakeAuthServer,
  overrides: Partial<TokenProviderDeps> = {},
): BearerTokenProvider =>
  createTokenProvider('staging', {
    store,
    fetch: server.fetch,
    now: () => NOW,
    lock: { retryMs: 5, waitMs: 2000 },
    ...overrides,
  });

const SIGN_IN_CHANGED = 'The staging sign-in changed while this command was running. Run it again.';
const NOT_SIGNED_IN =
  "You're not signed in to staging. Run `appbuilder login --env staging` to sign in.";

describe('login', () => {
  it('redirect_uri in authorize URL and token exchange are identical and include the bound port', async () => {
    const server = fakeAuthServer();
    const browser = fakeBrowser(approve);
    const printed: string[] = [];
    const session = await login('staging', loginDeps(server, browser, printed));

    const [authorize] = browser.authorizeUrls;
    const [exchange] = server.tokenRequests();
    const redirectUri = authorize?.searchParams.get('redirect_uri');

    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/callback$/);
    expect(exchange?.get('redirect_uri')).toBe(redirectUri);
    expect(`${authorize?.origin ?? ''}${authorize?.pathname ?? ''}`).toBe(AUTHORIZE);
    expect(exchange?.get('grant_type')).toBe('authorization_code');
    expect(exchange?.get('code')).toBe('auth-code');
    expect(exchange?.get('client_id')).toBe('registered-1');
    // The verifier sent to the token endpoint is the one the challenge was made from.
    expect(
      createHash('sha256')
        .update(exchange?.get('code_verifier') ?? '')
        .digest('base64url'),
    ).toBe(authorize?.searchParams.get('code_challenge'));
    expect(session).toMatchObject({
      environment: 'staging',
      clientId: 'registered-1',
      tokenEndpoint: TOKEN,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3600 * 1000,
    });
    expect(await store.readSession('staging')).toStrictEqual(session);
    // The URL is printed for when the browser can't open; no secret is.
    expect(printed).toContain(authorize?.toString());
    expect(printed.join('\n')).not.toContain(exchange?.get('code_verifier') ?? '<none>');
    expect(printed.join('\n')).not.toContain('access-1');
  });

  it('each login writes a new loginId', async () => {
    const server = fakeAuthServer();
    const first = await login('staging', loginDeps(server, fakeBrowser(approve)));
    const firstStored = await store.readSession('staging');
    const second = await login('staging', loginDeps(server, fakeBrowser(approve)));
    const secondStored = await store.readSession('staging');

    expect(firstStored?.loginId).toBe(first.loginId);
    expect(secondStored?.loginId).toBe(second.loginId);
    expect(first.loginId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.loginId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.loginId).not.toBe(first.loginId);
  });

  it('a forged callback does not end the login, and its code is never exchanged', async () => {
    const server = fakeAuthServer();
    const statuses: number[] = [];
    const deps: LoginDeps = {
      ...loginDeps(server, fakeBrowser(approve)),
      openBrowser: (raw) => {
        const authorize = new URL(raw);
        const callback = authorize.searchParams.get('redirect_uri') ?? '';

        // Another local process gets there first with a guessed state.
        void httpGet(`${callback}?code=forged-code&state=forged`).then(async ({ status }) => {
          statuses.push(status);
          statuses.push(
            (await httpGet(`${callback}?${new URLSearchParams(approve(authorize)).toString()}`))
              .status,
          );
        });
      },
    };
    const session = await login('staging', deps);

    expect(statuses).toStrictEqual([400, 200]);
    expect(server.tokenRequests().map((params) => params.get('code'))).toStrictEqual(['auth-code']);
    expect(await store.readSession('staging')).toStrictEqual(session);
  });

  it("callback with error param rejects with the server's error", async () => {
    const server = fakeAuthServer();
    const browser = fakeBrowser((authorize) => ({
      error: 'access_denied',
      error_description: 'The user denied access',
      state: authorize.searchParams.get('state') ?? '',
    }));
    const error = await rejectionOf(login('staging', loginDeps(server, browser)));

    expect(error.code).toBe('access_denied');
    expect(error.message).toContain('The user denied access');
    expect(server.tokenRequests()).toHaveLength(0);
  });

  it('login reuses cached client_id for the same issuer', async () => {
    const server = fakeAuthServer();
    const browser = fakeBrowser(approve);

    // First login registers and caches; the second reuses the cache.
    await login('staging', loginDeps(server, browser));
    await login('staging', loginDeps(server, browser));

    expect(server.registrations()).toBe(1);
    expect(browser.authorizeUrls.map((url) => url.searchParams.get('client_id'))).toStrictEqual([
      'registered-1',
      'registered-1',
    ]);
    expect(await store.readClientId(ISSUER)).toBe('registered-1');
    // A different issuer has its own cache entry.
    expect(await store.readClientId('https://app.go.kizen.com')).toBeUndefined();
  });

  it('timeout with a cached client forgets it, and the next login re-registers', async () => {
    // What Kizen really does with an unknown client_id: an error page in the
    // browser and no redirect (RFC 6749 §4.1.2.1), so the CLI just times out.
    await store.writeClientId(ISSUER, 'stale-client');

    const server = fakeAuthServer();
    const browser = fakeBrowser((authorize) =>
      authorize.searchParams.get('client_id') === 'stale-client' ? null : approve(authorize),
    );
    const deps = { ...loginDeps(server, browser), timeoutMs: 100 };
    const error = await rejectionOf(login('staging', deps));

    expect(error.code).toBe('timeout');
    expect(error.message).toContain('appbuilder login --env staging');
    expect(await store.readClientId(ISSUER)).toBeUndefined();
    expect(server.registrations()).toBe(0);
    expect(server.tokenRequests()).toHaveLength(0);
    expect(await store.readSession('staging')).toBeNull();

    const session = await login('staging', deps);

    expect(server.registrations()).toBe(1);
    expect(browser.authorizeUrls.map((url) => url.searchParams.get('client_id'))).toStrictEqual([
      'stale-client',
      'registered-1',
    ]);
    expect(session.clientId).toBe('registered-1');
    expect(await store.readClientId(ISSUER)).toBe('registered-1');
  });

  it('timeout with a freshly registered client keeps the registration', async () => {
    const server = fakeAuthServer();
    const browser = fakeBrowser(() => null);
    const error = await rejectionOf(
      login('staging', { ...loginDeps(server, browser), timeoutMs: 100 }),
    );

    expect(error.code).toBe('timeout');
    expect(await store.readClientId(ISSUER)).toBe('registered-1');
  });

  it('invalid_client triggers exactly one re-registration', async () => {
    await store.writeClientId(ISSUER, 'stale-client');

    const server = fakeAuthServer((params, index) =>
      params.get('client_id') === 'stale-client'
        ? jsonResponse({ error: 'invalid_client' }, 401)
        : jsonResponse(tokenBody(index + 1)),
    );
    const browser = fakeBrowser(approve);
    const session = await login('staging', loginDeps(server, browser));

    expect(server.registrations()).toBe(1);
    expect(server.tokenRequests().map((params) => params.get('client_id'))).toStrictEqual([
      'stale-client',
      'registered-1',
    ]);
    expect(session.clientId).toBe('registered-1');
    expect(await store.readClientId(ISSUER)).toBe('registered-1');
  });

  it.each([
    [
      'on the re-registered client is not retried again',
      'stale-client',
      ['stale-client', 'registered-1'],
    ],
    ['on a freshly registered client is not re-registered', undefined, ['registered-1']],
  ] as const)('invalid_client %s', async (_name, cached, authorizedClients) => {
    if (cached !== undefined) {
      await store.writeClientId(ISSUER, cached);
    }

    const server = fakeAuthServer(() => jsonResponse({ error: 'invalid_client' }, 401));
    const browser = fakeBrowser(approve);
    const error = await rejectionOf(login('staging', loginDeps(server, browser)));

    expect(error.code).toBe('invalid_client');
    expect(server.registrations()).toBe(1);
    expect(browser.authorizeUrls.map((url) => url.searchParams.get('client_id'))).toStrictEqual(
      authorizedClients,
    );
    expect(await store.readSession('staging')).toBeNull();
  });

  it('invalid_client from the authorize callback also re-registers once', async () => {
    await store.writeClientId(ISSUER, 'stale-client');

    const server = fakeAuthServer();
    const browser = fakeBrowser((authorize) =>
      authorize.searchParams.get('client_id') === 'stale-client'
        ? { error: 'invalid_client', state: authorize.searchParams.get('state') ?? '' }
        : approve(authorize),
    );
    const session = await login('staging', loginDeps(server, browser));

    expect(server.registrations()).toBe(1);
    expect(server.tokenRequests()).toHaveLength(1);
    expect(session.clientId).toBe('registered-1');
  });

  it('a login paused past staleMs before writing waits for the process that took the lock over', async () => {
    const oldLogin = oauthSession({ loginId: 'login-a', refreshToken: 'refresh-old' });

    await store.writeSession(oldLogin);

    // Paused between taking the lock and writing.
    const paused = pausingStore(store, 'writeSession');
    const loggingIn = login('staging', {
      ...loginDeps(fakeAuthServer(), fakeBrowser(approve)),
      store: paused.store,
    });

    await paused.holding;

    // Another process refreshing login-a takes the stale lock over, reads it,
    // and writes its rotated tokens once login has acted.
    const other = createOAuthStore(dir);
    const lock = await other.acquireLock('staging', { staleMs: 20, retryMs: 5, waitMs: 2000 });

    expect(await other.readSession('staging')).toStrictEqual(oldLogin);
    paused.resume();
    await paused.acted;
    expect(await lock.confirm()).toBe(true);
    await other.writeSession({ ...oldLogin, refreshToken: 'refresh-old-rotated' });
    await lock();

    const session = await loggingIn;

    // The new login, not the other process's write of login-a, is what's stored.
    expect(session.loginId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.readSession('staging')).toStrictEqual(session);
    expect(paused.lockCalls()).toBe(2);
  });
});

const EXPIRING = NOW + 30_000; // inside the 60s leeway

describe('createTokenProvider', () => {
  /** login-a with the tokens another refresh (or process) of it stored. */
  const ROTATED = oauthSession({ accessToken: 'access-rotated', refreshToken: 'refresh-rotated' });
  /** A newer login, with its own tokens and app registration. */
  const LOGIN_B = oauthSession({
    loginId: 'login-b',
    clientId: 'client-2',
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
  });

  it('returns a fresh token without refreshing', async () => {
    await store.writeSession(oauthSession({ expiresAt: NOW + 61_000 }));

    const server = fakeAuthServer();

    await expect(provider(server).getAccessToken()).resolves.toBe('access-0');
    expect(server.tokenRequests()).toHaveLength(0);
  });

  it('concurrent token requests in one process trigger a single refresh', async () => {
    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));

    let respond: (() => void) | undefined;
    const server = fakeAuthServer(
      (_, index) =>
        new Promise((resolve) => {
          respond = () => {
            resolve(jsonResponse(tokenBody(index + 1)));
          };
        }),
    );
    // The lock + re-read would also stop a second network refresh, so count lock
    // acquisitions: only the in-process shared promise keeps this at one.
    const acquireLock = vi.spyOn(store, 'acquireLock');
    const tokens = provider(server);
    const all = Promise.all([
      tokens.getAccessToken(),
      tokens.getAccessToken(),
      tokens.refreshAccessToken('access-0'),
    ]);

    await vi.waitFor(() => {
      expect(respond).toBeDefined();
    });
    respond?.();

    expect(await all).toStrictEqual(['access-1', 'access-1', 'access-1']);
    expect(server.tokenRequests()).toHaveLength(1);
    expect(acquireLock).toHaveBeenCalledTimes(1);
    expect(server.tokenRequests()[0]?.get('grant_type')).toBe('refresh_token');
    expect(server.tokenRequests()[0]?.get('refresh_token')).toBe('refresh-0');
    expect(await store.readSession('staging')).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3600 * 1000,
    });
    expect((await stat(store.sessionPath('staging'))).mode & 0o777).toBe(0o600);
  });

  it('getAccessToken during a 401-triggered refresh of a still-fresh token returns the refreshed token', async () => {
    // Fresh by expiry, so only the in-flight refresh says its token is rejected.
    await store.writeSession(oauthSession());

    const respond = deferred();
    const server = fakeAuthServer(async (_, index) => {
      await respond.promise;

      return jsonResponse(tokenBody(index + 1));
    });
    const tokens = provider(server);
    const refreshing = tokens.refreshAccessToken('access-0');

    await vi.waitFor(() => {
      expect(server.tokenRequests()).toHaveLength(1);
    });

    const reading = tokens.getAccessToken();

    respond.resolve();

    expect(await Promise.all([refreshing, reading])).toStrictEqual(['access-1', 'access-1']);
    expect(server.tokenRequests()).toHaveLength(1);
  });

  it('refresh after lock uses session already rotated by another process', async () => {
    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));

    // "Another process": a second store on the same directory holding the lock.
    const other = createOAuthStore(dir);
    const release = await other.acquireLock('staging');
    const server = fakeAuthServer();
    const pending = provider(server).getAccessToken();

    await new Promise((resolve) => setTimeout(resolve, 40));
    await other.writeSession(ROTATED);
    await release();

    await expect(pending).resolves.toBe('access-rotated');
    expect(server.tokenRequests()).toHaveLength(0);
    expect(await store.readSession('staging')).toMatchObject({ refreshToken: 'refresh-rotated' });
  });

  it('a 401 refresh after another process rotated past the rejected token uses the new one', async () => {
    // Fresh by expiry but rejected by the server: refresh even though it isn't expiring.
    await store.writeSession(oauthSession());

    const server = fakeAuthServer();

    await expect(provider(server).refreshAccessToken('access-0')).resolves.toBe('access-1');
    expect(server.tokenRequests()).toHaveLength(1);

    // Rejected token is now stale: no second refresh, the current token is returned.
    await expect(provider(server).refreshAccessToken('access-0')).resolves.toBe('access-1');
    expect(server.tokenRequests()).toHaveLength(1);
  });

  it('invalid_grant on refresh deletes the session and asks to log in again', async () => {
    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer(() =>
      jsonResponse({ error: 'invalid_grant', error_description: 'Token expired' }, 400),
    );
    const tokens = provider(server);
    const error = await rejectionOf(tokens.getAccessToken());

    expect(error.code).toBe('login_required');
    expect(error.message).toContain('appbuilder login --env staging');
    expect(await store.readSession('staging')).toBeNull();
    await expect(stat(store.sessionPath('staging'))).rejects.toMatchObject({ code: 'ENOENT' });

    // No loop: the next call fails fast without another token request.
    expect((await rejectionOf(tokens.getAccessToken())).code).toBe('login_required');
    expect(server.tokenRequests()).toHaveLength(1);
    // The lock was released.
    expect(await lockIsFree(store, 'staging')).toBe(true);
  });

  it('invalid_client on refresh with the clients lock held fails fast and still asks to log in', async () => {
    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));
    await store.writeClientId(ISSUER, 'client-1');

    // Another live process holds the clients.json lock and never lets go.
    await writeFile(join(store.dir, 'clients.lock.9'), `${String(process.pid)} ${'a'.repeat(32)}`);

    const server = fakeAuthServer(() => jsonResponse({ error: 'invalid_client' }, 401));
    // The short lock budget auth-header uses.
    const tokens = provider(server, { lock: { retryMs: 5, waitMs: 3000 } });
    const started = Date.now();
    const error = await rejectionOf(tokens.getAccessToken());

    expect(error.code).toBe('login_required');
    expect(error.message).toContain('appbuilder login --env staging');
    // Bounded by the short forget wait, nowhere near the clients lock's 35s default.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await store.readSession('staging')).toBeNull();
    // The forget was skipped, not half-done: the cache is intact for the next login to handle.
    expect(await store.readClientId(ISSUER)).toBe('client-1');
  });

  it.each([
    ['HTTP 502', 'server_error', () => new Response('bad gateway', { status: 502 })],
    [
      '503 temporarily_unavailable',
      'temporarily_unavailable',
      () => jsonResponse({ error: 'temporarily_unavailable' }, 503),
    ],
    [
      'a fetch that throws ECONNRESET',
      'network_error',
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      },
      'ECONNRESET',
    ],
    [
      'a fetch that throws ECONNREFUSED',
      'network_error',
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      },
      'ECONNREFUSED',
    ],
    [
      'a token request that exceeds the timeout',
      'network_error',
      (_params, _index, init) => hangUntilAbort(init),
      'timed out',
    ],
  ] satisfies [string, string, Parameters<typeof fakeAuthServer>[0], string?][])(
    'transient refresh failure keeps the session and releases the lock: %s',
    async (_name, code, respond, messagePart?: string) => {
      const before = oauthSession({ expiresAt: EXPIRING });

      await store.writeSession(before);

      const error = await rejectionOf(
        provider(fakeAuthServer(respond), { requestTimeoutMs: 50 }).getAccessToken(),
      );

      expect(error.code).toBe(code);

      if (messagePart !== undefined) {
        expect(error.message).toContain(messagePart);
      }

      expect(await store.readSession('staging')).toStrictEqual(before);
      expect(await lockIsFree(store, 'staging')).toBe(true);
    },
  );

  it("invalid_grant deletes only that environment's session", async () => {
    const other = oauthSession({
      environment: 'go',
      issuer: 'https://app.go.kizen.com',
      accessToken: 'go-access',
      refreshToken: 'go-refresh',
    });

    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));
    await store.writeSession(other);

    const server = fakeAuthServer(() => jsonResponse({ error: 'invalid_grant' }, 400));

    expect((await rejectionOf(provider(server).getAccessToken())).code).toBe('login_required');
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.readSession('go')).toStrictEqual(other);
    expect(await store.listSessions()).toStrictEqual(['go']);
  });

  it("login during an in-flight refresh keeps the new login's tokens", async () => {
    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));

    const loginAtLock = deferred();
    let loginDone = new Promise<unknown>(() => undefined);
    const server = fakeAuthServer(async (params) => {
      if (params.get('grant_type') === 'refresh_token') {
        // The refresh holds the lock until login is ready to write (or, if login
        // didn't take the lock, has already written).
        await Promise.race([loginAtLock.promise, loginDone]);

        return jsonResponse({ ...tokenBody(1), access_token: 'refreshed-old-login' });
      }

      return jsonResponse({
        ...tokenBody(2),
        access_token: 'new-login-access',
        refresh_token: 'new-login-refresh',
      });
    });
    const tokens = provider(server);
    const refreshing = tokens.getAccessToken();

    await vi.waitFor(() => {
      expect(server.tokenRequests()).toHaveLength(1);
    });

    const loggingIn = login('staging', {
      ...loginDeps(server, fakeBrowser(approve)),
      store: signallingStore(loginAtLock),
    });

    loginDone = loggingIn.catch(() => undefined);

    const [refreshed, session] = await Promise.all([refreshing, loggingIn]);

    expect(refreshed).toBe('refreshed-old-login');
    expect(session).toMatchObject({ accessToken: 'new-login-access', clientId: 'registered-1' });
    expect(await store.readSession('staging')).toStrictEqual(session);
    // The provider still serves the old login, so the new login's token never comes out of it.
    expect((await rejectionOf(tokens.getAccessToken())).code).toBe('login_required');
  });

  describe('a refresh paused past staleMs after the token response', () => {
    /** A taker's staleMs, far below the token request's (unbounded) pause. */
    const TAKER = { staleMs: 20, retryMs: 5, waitMs: 2000 };
    const INVALID_GRANT = (): Response => jsonResponse({ error: 'invalid_grant' }, 400);

    /**
     * Starts a refresh of an expiring login-a session whose token response is
     * held until `resume()`; resolves once the response is held (the lock is
     * then held by the paused refresh). `respond` is the held response.
     */
    const pausedRefresh = async (
      respond: () => Response = () => jsonResponse(tokenBody(1)),
    ): Promise<{
      pending: Promise<string>;
      resume: () => void;
      server: FakeAuthServer;
      lockCalls: () => number;
    }> => {
      await store.writeSession(oauthSession({ expiresAt: EXPIRING }));

      const gate = deferred();
      const server = fakeAuthServer(async () => {
        await gate.promise;

        return respond();
      });
      let lockCalls = 0;
      const counting: OAuthStore = {
        ...store,
        acquireLock: (environment, options) => {
          lockCalls += 1;

          return store.acquireLock(environment, options);
        },
      };
      const pending = provider(server, { store: counting }).getAccessToken();

      // Observe the outcome even if a test asserts on it late.
      pending.catch(() => undefined);
      await vi.waitFor(() => {
        expect(server.tokenRequests()).toHaveLength(1);
      });

      return {
        pending,
        resume: () => {
          gate.resolve();
        },
        server,
        lockCalls: () => lockCalls,
      };
    };

    /** "Another process" takes the (now stale) lock over, runs `during`, releases. */
    const takeOver = async (during: (other: OAuthStore) => Promise<void>): Promise<void> => {
      const other = createOAuthStore(dir);
      const lock = await other.acquireLock('staging', TAKER);

      try {
        await during(other);
      } finally {
        await lock();
      }
    };

    it('a refresh paused past staleMs does not restore a logged-out session', async () => {
      const { pending, resume } = await pausedRefresh();

      await takeOver(async (other) => {
        expect(await other.deleteSession('staging')).toBe(true);
      });
      resume();

      const error = await rejectionOf(pending);

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(NOT_SIGNED_IN);
      await expect(stat(store.sessionPath('staging'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await lockIsFree(store, 'staging')).toBe(true);
    });

    it.each([
      ['does not overwrite a newer login', () => jsonResponse(tokenBody(1))],
      ['that gets invalid_grant does not delete a newer login', INVALID_GRANT],
    ])('a refresh paused past staleMs %s', async (_name, respond) => {
      const { pending, resume, server } = await pausedRefresh(respond);

      await takeOver(async (other) => {
        await other.writeSession(LOGIN_B);
      });
      resume();

      const error = await rejectionOf(pending);

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(SIGN_IN_CHANGED);
      expect(await store.readSession('staging')).toStrictEqual(LOGIN_B);
      expect(server.tokenRequests()).toHaveLength(1);
      expect(await lockIsFree(store, 'staging')).toBe(true);
    });

    it('a refresh paused past staleMs with no refresh token does not delete a newer login', async () => {
      await store.writeSession(oauthSession({ expiresAt: EXPIRING, refreshToken: undefined }));

      const paused = deferred();
      const resume = deferred();
      let reads = 0;
      const server = fakeAuthServer();
      const pending = provider(server, {
        store: {
          ...store,
          readSession: async (environment) => {
            reads += 1;

            const read = await store.readSession(environment);

            // The second read is the one under the lock: pause right after it.
            if (reads === 2) {
              paused.resolve();
              await resume.promise;
            }

            return read;
          },
        },
      }).getAccessToken();

      pending.catch(() => undefined);
      await paused.promise;
      await takeOver(async (other) => {
        await other.writeSession(LOGIN_B);
      });
      resume.resolve();

      const error = await rejectionOf(pending);

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(SIGN_IN_CHANGED);
      expect(await store.readSession('staging')).toStrictEqual(LOGIN_B);
      expect(server.fetch).not.toHaveBeenCalled();
      expect(await lockIsFree(store, 'staging')).toBe(true);
    });

    it.each([
      ['keeps tokens another refresh of the same login stored', () => jsonResponse(tokenBody(1))],
      [
        'that gets invalid_client keeps the same login rotated by another refresh and its app registration',
        () => jsonResponse({ error: 'invalid_client' }, 401),
        'login_required',
      ],
      [
        'that gets invalid_grant keeps the same login rotated by another refresh',
        INVALID_GRANT,
        'login_required',
      ],
    ] satisfies [string, () => Response, string?][])(
      'a refresh paused past staleMs %s',
      async (_name, respond, code?: string) => {
        await store.writeClientId(ISSUER, 'client-1');

        const { pending, resume } = await pausedRefresh(respond);

        await takeOver(async (other) => {
          await other.writeSession(ROTATED);
        });
        resume();

        if (code === undefined) {
          // This command still gets the access token it was issued, but doesn't store it.
          await expect(pending).resolves.toBe('access-1');
        } else {
          expect((await rejectionOf(pending)).code).toBe(code);
        }

        expect(await store.readSession('staging')).toStrictEqual(ROTATED);
        // The client wasn't forgotten: the session that uses it is still there.
        expect(await store.readClientId(ISSUER)).toBe('client-1');
        expect(await lockIsFree(store, 'staging')).toBe(true);
      },
    );

    it('a refresh that lost its lease with the session unchanged waits for the lock and then writes the rotated tokens', async () => {
      const { pending, resume, server, lockCalls } = await pausedRefresh();
      const taken = deferred();
      const finish = deferred();
      const other = takeOver(async () => {
        taken.resolve();
        await finish.promise;
      });

      await taken.promise;
      resume();

      // The refresh found its lease gone and is waiting to take the lock again,
      // without having written while the other process holds it.
      await vi.waitFor(() => {
        expect(lockCalls()).toBe(2);
      });
      expect(await store.readSession('staging')).toStrictEqual(
        oauthSession({ expiresAt: EXPIRING }),
      );

      finish.resolve();
      await other;

      await expect(pending).resolves.toBe('access-1');
      expect(await store.readSession('staging')).toStrictEqual(
        oauthSession({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: NOW + 3600 * 1000,
        }),
      );
      // The refresh token was spent once.
      expect(server.tokenRequests()).toHaveLength(1);
      expect(await lockIsFree(store, 'staging')).toBe(true);
    });
  });

  it('a refresh that keeps its lease writes the rotated tokens', async () => {
    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer();

    await expect(provider(server).getAccessToken()).resolves.toBe('access-1');
    expect(await store.readSession('staging')).toStrictEqual(
      oauthSession({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: NOW + 3600 * 1000,
      }),
    );
    expect(await lockIsFree(store, 'staging')).toBe(true);
  });

  it.each([
    ['an expiring session with a refresh token', { expiresAt: EXPIRING }],
    [
      'an expiring session without a refresh token',
      { expiresAt: EXPIRING, refreshToken: undefined },
    ],
    ['a fresh session', {}],
  ] as const)(
    'refresh does not request or write when a different login replaced the session (%s)',
    async (_, replacement) => {
      await store.writeSession(oauthSession({ expiresAt: EXPIRING }));

      // "Login" in another process holds the lock and writes another login's session.
      const release = await createOAuthStore(dir).acquireLock('staging');
      const server = fakeAuthServer();
      const refreshAtLock = deferred();
      const pending = provider(server, { store: signallingStore(refreshAtLock) }).getAccessToken();

      // The provider has read (and pinned) login-a and is waiting to refresh it.
      await refreshAtLock.promise;

      const newLogin = { ...LOGIN_B, ...replacement };

      await store.writeSession(newLogin);
      await release();

      const error = await rejectionOf(pending);

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(SIGN_IN_CHANGED);
      // Neither refresh token was spent, and the new login's session is untouched.
      expect(server.fetch).not.toHaveBeenCalled();
      expect(await store.readSession('staging')).toStrictEqual(newLogin);
      expect(await lockIsFree(store, 'staging')).toBe(true);
    },
  );

  it('rejects the token after another login replaces the session', async () => {
    await store.writeSession(oauthSession());

    const server = fakeAuthServer();
    const tokens = provider(server);

    await expect(tokens.getAccessToken()).resolves.toBe('access-0');

    const newLogin = oauthSession({ loginId: 'login-b', accessToken: 'access-b' });

    await store.writeSession(newLogin);

    const error = await rejectionOf(tokens.getAccessToken());

    expect(error.code).toBe('login_required');
    expect(error.message).toBe(SIGN_IN_CHANGED);
    expect(error.message).not.toContain('access-b');
    // A 401 retry is refused the same way, without touching the new login.
    expect((await rejectionOf(tokens.refreshAccessToken('access-0'))).code).toBe('login_required');
    expect(server.fetch).not.toHaveBeenCalled();
    expect(await store.readSession('staging')).toStrictEqual(newLogin);
    // A provider created after the new login serves it.
    await expect(provider(server).getAccessToken()).resolves.toBe('access-b');
  });

  it('keeps working across refresh-token rotation within one login', async () => {
    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer();
    const tokens = provider(server);

    // This process rotates the refresh token.
    await expect(tokens.getAccessToken()).resolves.toBe('access-1');
    expect(await store.readSession('staging')).toMatchObject({
      loginId: 'login-a',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });

    // Another process rotates it again within the same login.
    await store.writeSession(ROTATED);
    await expect(tokens.getAccessToken()).resolves.toBe('access-rotated');

    // And a 401 makes this process rotate once more.
    await expect(tokens.refreshAccessToken('access-rotated')).resolves.toBe('access-2');
    expect(server.tokenRequests().map((params) => params.get('refresh_token'))).toStrictEqual([
      'refresh-0',
      'refresh-rotated',
    ]);
    expect(await store.readSession('staging')).toMatchObject({
      loginId: 'login-a',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
  });

  it('session without loginId reads as unreadable and asks to log in', async () => {
    const withoutLoginId: Partial<OAuthSession> = oauthSession();

    delete withoutLoginId.loginId;

    await mkdir(store.dir, { recursive: true });
    await writeFile(store.sessionPath('staging'), JSON.stringify(withoutLoginId));

    const server = fakeAuthServer();
    const error = await rejectionOf(provider(server).getAccessToken());

    expect(error.code).toBe('login_required');
    expect(error.message).toContain("can't be read");
    expect(error.message).toContain('appbuilder login --env staging');
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it('concurrent first reads pin one login', async () => {
    const reads = [deferred<OAuthSession>(), deferred<OAuthSession>()];
    let index = 0;
    const readSession = vi.fn(() => {
      const read = reads[index];

      index += 1;

      return read ? read.promise : store.readSession('staging');
    });
    const server = fakeAuthServer();
    // Fresh sessions only, so the lock is never taken.
    const tokens = provider(server, { store: { ...store, readSession } });
    const first = tokens.getAccessToken();
    const second = tokens.getAccessToken();

    expect(readSession).toHaveBeenCalledTimes(2);

    // The second call's read lands first, with login-a; the first call's read
    // then sees login-b. Whichever lands first is the pin; the other must fail.
    reads[1]?.resolve(oauthSession({ loginId: 'login-a', accessToken: 'access-a' }));
    await expect(second).resolves.toBe('access-a');
    reads[0]?.resolve(oauthSession({ loginId: 'login-b', accessToken: 'access-b' }));
    expect((await rejectionOf(first)).code).toBe('login_required');

    // The pin is login-a: it keeps serving login-a and refuses login-b.
    await store.writeSession(oauthSession({ loginId: 'login-a', accessToken: 'access-a2' }));
    await expect(tokens.getAccessToken()).resolves.toBe('access-a2');
    await store.writeSession(oauthSession({ loginId: 'login-b', accessToken: 'access-b2' }));
    expect((await rejectionOf(tokens.getAccessToken())).code).toBe('login_required');
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it('a logout mid-command still asks to sign in', async () => {
    await store.writeSession(oauthSession());

    const tokens = provider(fakeAuthServer());

    await expect(tokens.getAccessToken()).resolves.toBe('access-0');
    await store.deleteSession('staging');

    const error = await rejectionOf(tokens.getAccessToken());

    expect(error.code).toBe('login_required');
    expect(error.message).toBe(NOT_SIGNED_IN);
  });
});

describe('resolveSessionEnvironment', () => {
  const sessions = (...environments: Environment[]): (() => Promise<Environment[]>) =>
    vi.fn(() => Promise.resolve(environments));

  it('uses a valid --env without listing sessions', async () => {
    const list = sessions('go', 'staging');

    await expect(resolveSessionEnvironment('fmo', list)).resolves.toStrictEqual({
      ok: true,
      environment: 'fmo',
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an unknown --env with the shared message', async () => {
    await expect(resolveSessionEnvironment('prod', sessions('staging'))).resolves.toStrictEqual({
      ok: false,
      problem: 'unknown_environment',
      message: 'Unknown --env "prod". Use one of: go, fmo, staging, integration, test1.',
    });
  });

  it('without --env, picks the only signed-in environment', async () => {
    await expect(resolveSessionEnvironment(undefined, sessions('test1'))).resolves.toStrictEqual({
      ok: true,
      environment: 'test1',
    });
  });

  it('without --env and no session, says how to sign in', async () => {
    await expect(resolveSessionEnvironment(undefined, sessions())).resolves.toStrictEqual({
      ok: false,
      problem: 'not_signed_in',
      message: "You're not signed in. Run `appbuilder login --env go` (or another --env).",
    });
  });

  it('without --env and several sessions, asks for --env', async () => {
    await expect(
      resolveSessionEnvironment(undefined, sessions('go', 'staging')),
    ).resolves.toStrictEqual({
      ok: false,
      problem: 'several_sessions',
      message: "You're signed in to several environments; pass --env <env>: go, staging",
    });
  });
});

describe('createDefaultTokenProvider', () => {
  it('refreshes by the real clock through the global fetch', async () => {
    // Expired by the real clock, but more than the refresh leeway away from epoch 0,
    // so a provider wired to any other clock would hand back the stored token.
    await store.writeSession(
      oauthSession({
        accessToken: 'stored-access',
        refreshToken: 'stored-refresh',
        expiresAt: 10 * 60 * 1000,
        scope: undefined,
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(tokenBody(2)));

    try {
      const provider = createDefaultTokenProvider('staging', store);
      const before = Date.now();

      expect(provider.environment).toBe('staging');
      await expect(provider.getAccessToken()).resolves.toBe('access-2');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(TOKEN);
      expect(fetchSpy.mock.calls[0]?.[1]?.body).toContain(
        'grant_type=refresh_token&refresh_token=stored-refresh',
      );

      // The new expiry is stamped with the real clock too.
      const saved = await store.readSession('staging');

      expect(saved?.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(saved?.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
