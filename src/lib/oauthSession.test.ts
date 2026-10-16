import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from './credentials.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, OAuthError, startLoopbackServer } from './oauth.js';
import {
  createDefaultTokenProvider,
  createTokenProvider,
  login,
  resolveSessionEnvironment,
  type LoginDeps,
} from './oauthSession.js';
import { createOAuthStore, type OAuthSession, type OAuthStore } from './oauthStore.js';

const ISSUER = 'https://staging.kizen.com';
// Deliberately not the conventional /oauth2/* paths, so passing tests prove the
// flow uses the discovered endpoints rather than hard-coded ones.
const AUTHORIZE = `${ISSUER}/discovered/authorize`;
const TOKEN = `${ISSUER}/discovered/token`;
const REGISTER = `${ISSUER}/discovered/register`;
const NOW = 1_700_000_000_000;

let dir: string;
let store: OAuthStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'appbuilder-oauth-session-'));
  store = createOAuthStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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
  ) => Response | Promise<Response> = (_, i) => json(tokenBody(i + 1)),
): FakeAuthServer {
  let registered = 0;
  const tokenParams: URLSearchParams[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = input as string;

    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Promise.resolve(
        json({
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

      return Promise.resolve(json({ client_id: `registered-${String(registered)}` }, 201));
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

const httpGet = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    request(url, { agent: false }, (res) => {
      res.resume();
      res.on('end', resolve);
    })
      .on('error', reject)
      .end();
  });

const httpGetStatus = (url: string): Promise<number> =>
  new Promise((resolve, reject) => {
    request(url, { agent: false }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve(res.statusCode ?? 0);
      });
    })
      .on('error', reject)
      .end();
  });

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

/** Whether the staging lock can be taken right now (released again if so). */
const lockIsFree = async (): Promise<boolean> => {
  try {
    await (
      await createOAuthStore(dir).acquireLock('staging', { retryMs: 1, waitMs: 0 })
    )();

    return true;
  } catch {
    return false;
  }
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

/** `store`, but signals the first time something asks for the session lock. */
const signallingStore = (atLock: Deferred<void>): OAuthStore => ({
  ...store,
  acquireLock: (environment, options) => {
    atLock.resolve();

    return store.acquireLock(environment, options);
  },
});

const rejectionOf = async (promise: Promise<unknown>): Promise<OAuthError> => {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );

  expect(error).toBeInstanceOf(OAuthError);

  return error as OAuthError;
};

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

  it('a forged callback does not end the login, and its code is never exchanged', async () => {
    const server = fakeAuthServer();
    const statuses: number[] = [];
    const deps: LoginDeps = {
      ...loginDeps(server, fakeBrowser(approve)),
      openBrowser: (raw) => {
        const authorize = new URL(raw);
        const callback = authorize.searchParams.get('redirect_uri') ?? '';

        // Another local process gets there first with a guessed state.
        void httpGetStatus(`${callback}?code=forged-code&state=forged`).then(async (status) => {
          statuses.push(status);
          statuses.push(
            await httpGetStatus(
              `${callback}?${new URLSearchParams(approve(authorize)).toString()}`,
            ),
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
        ? json({ error: 'invalid_client' }, 401)
        : json(tokenBody(index + 1)),
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

  it('invalid_client on the re-registered client is not retried again', async () => {
    await store.writeClientId(ISSUER, 'stale-client');

    const server = fakeAuthServer(() => json({ error: 'invalid_client' }, 401));
    const browser = fakeBrowser(approve);
    const error = await rejectionOf(login('staging', loginDeps(server, browser)));

    expect(error.code).toBe('invalid_client');
    expect(server.registrations()).toBe(1);
    expect(browser.authorizeUrls).toHaveLength(2);
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

  it('a freshly registered client rejected as invalid_client is not re-registered', async () => {
    const server = fakeAuthServer(() => json({ error: 'invalid_client' }, 401));
    const browser = fakeBrowser(approve);

    expect((await rejectionOf(login('staging', loginDeps(server, browser)))).code).toBe(
      'invalid_client',
    );
    expect(server.registrations()).toBe(1);
    expect(browser.authorizeUrls).toHaveLength(1);
  });
});

const storedSession = (overrides: Partial<OAuthSession> = {}): OAuthSession => ({
  environment: 'staging',
  issuer: ISSUER,
  clientId: 'client-1',
  tokenEndpoint: TOKEN,
  accessToken: 'access-0',
  refreshToken: 'refresh-0',
  expiresAt: NOW + 3600 * 1000,
  scope: 'read write offline_access',
  ...overrides,
});

const EXPIRING = NOW + 30_000; // inside the 60s leeway

describe('createTokenProvider', () => {
  const provider = (server: FakeAuthServer, now = NOW): ReturnType<typeof createTokenProvider> =>
    createTokenProvider('staging', {
      store,
      fetch: server.fetch,
      now: () => now,
      lock: { retryMs: 5, waitMs: 2000 },
    });

  it('returns a fresh token without refreshing', async () => {
    await store.writeSession(storedSession({ expiresAt: NOW + 61_000 }));

    const server = fakeAuthServer();

    await expect(provider(server).getAccessToken()).resolves.toBe('access-0');
    expect(server.tokenRequests()).toHaveLength(0);
  });

  it('concurrent token requests in one process trigger a single refresh', async () => {
    await store.writeSession(storedSession({ expiresAt: EXPIRING }));

    let respond: (() => void) | undefined;
    const server = fakeAuthServer(
      (_, index) =>
        new Promise((resolve) => {
          respond = () => {
            resolve(json(tokenBody(index + 1)));
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

  it('refresh after lock uses session already rotated by another process', async () => {
    await store.writeSession(storedSession({ expiresAt: EXPIRING }));

    // "Another process": a second store on the same directory holding the lock.
    const other = createOAuthStore(dir);
    const release = await other.acquireLock('staging');
    const server = fakeAuthServer();
    const pending = provider(server).getAccessToken();

    await new Promise((resolve) => setTimeout(resolve, 40));
    await other.writeSession(
      storedSession({
        accessToken: 'access-rotated',
        refreshToken: 'refresh-rotated',
        expiresAt: NOW + 3600 * 1000,
      }),
    );
    await release();

    await expect(pending).resolves.toBe('access-rotated');
    expect(server.tokenRequests()).toHaveLength(0);
    expect(await store.readSession('staging')).toMatchObject({ refreshToken: 'refresh-rotated' });
  });

  it('a 401 refresh after another process rotated past the rejected token uses the new one', async () => {
    // Fresh by expiry but rejected by the server: refresh even though it isn't expiring.
    await store.writeSession(storedSession());

    const server = fakeAuthServer();

    await expect(provider(server).refreshAccessToken('access-0')).resolves.toBe('access-1');
    expect(server.tokenRequests()).toHaveLength(1);

    // Rejected token is now stale: no second refresh, the current token is returned.
    await expect(provider(server).refreshAccessToken('access-0')).resolves.toBe('access-1');
    expect(server.tokenRequests()).toHaveLength(1);
  });

  it('invalid_grant on refresh deletes the session and asks to log in again', async () => {
    await store.writeSession(storedSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer(() =>
      json({ error: 'invalid_grant', error_description: 'Token expired' }, 400),
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
    expect(await lockIsFree()).toBe(true);
  });

  it('a token request that exceeds the timeout rejects with network_error and releases the lock', async () => {
    await store.writeSession(storedSession({ expiresAt: EXPIRING }));

    // Never answers; only the request's abort signal ends it.
    const server = fakeAuthServer(
      (_params, _index, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    const tokens = createTokenProvider('staging', {
      store,
      fetch: server.fetch,
      now: () => NOW,
      requestTimeoutMs: 50,
    });
    const error = await rejectionOf(tokens.getAccessToken());

    expect(error.code).toBe('network_error');
    expect(error.message).toContain('timed out');
    expect(await store.readSession('staging')).toMatchObject({ refreshToken: 'refresh-0' });
    expect(await lockIsFree()).toBe(true);
  });

  it('bounds token requests by default well under the 30s lock stale window', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  });

  it('a fetch that throws keeps the session, releases the lock and maps to network_error', async () => {
    await store.writeSession(storedSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    const error = await rejectionOf(provider(server).getAccessToken());

    expect(error.code).toBe('network_error');
    expect(error.message).toContain('ECONNREFUSED');
    expect(await store.readSession('staging')).toMatchObject({ refreshToken: 'refresh-0' });
    expect(await lockIsFree()).toBe(true);
  });

  it('invalid_client on refresh with the clients lock held fails fast and still asks to log in', async () => {
    await store.writeSession(storedSession({ expiresAt: EXPIRING }));
    await store.writeClientId(ISSUER, 'client-1');

    // Another live process holds the clients.json lock and never lets go.
    await writeFile(join(store.dir, 'clients.lock.9'), `${String(process.pid)} ${'a'.repeat(32)}`);

    const server = fakeAuthServer(() => json({ error: 'invalid_client' }, 401));
    // The short lock budget auth-header uses.
    const tokens = createTokenProvider('staging', {
      store,
      fetch: server.fetch,
      now: () => NOW,
      lock: { retryMs: 5, waitMs: 3000 },
    });
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

  it('transient refresh failure keeps the session', async () => {
    const failures: [string, Parameters<typeof fakeAuthServer>[0]][] = [
      ['server_error', () => new Response('bad gateway', { status: 502 })],
      ['temporarily_unavailable', () => json({ error: 'temporarily_unavailable' }, 503)],
      [
        'network_error',
        () => {
          throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        },
      ],
      [
        'network_error',
        (_params, _index, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason as Error);
            });
          }),
      ],
    ];

    for (const [code, respond] of failures) {
      const before = storedSession({ expiresAt: EXPIRING });

      await store.writeSession(before);

      const server = fakeAuthServer(respond);
      const tokens = createTokenProvider('staging', {
        store,
        fetch: server.fetch,
        now: () => NOW,
        lock: { retryMs: 5, waitMs: 2000 },
        requestTimeoutMs: 50,
      });
      const error = await rejectionOf(tokens.getAccessToken());

      expect(error.code).toBe(code);
      expect(await store.readSession('staging')).toStrictEqual(before);
      expect(await lockIsFree()).toBe(true);
    }
  });

  it("invalid_grant deletes only that environment's session", async () => {
    const other = storedSession({
      environment: 'go',
      issuer: 'https://app.go.kizen.com',
      accessToken: 'go-access',
      refreshToken: 'go-refresh',
    });

    await store.writeSession(storedSession({ expiresAt: EXPIRING }));
    await store.writeSession(other);

    const server = fakeAuthServer(() => json({ error: 'invalid_grant' }, 400));

    expect((await rejectionOf(provider(server).getAccessToken())).code).toBe('login_required');
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.readSession('go')).toStrictEqual(other);
    expect(await store.listSessions()).toStrictEqual(['go']);
  });

  it("login during an in-flight refresh keeps the new login's tokens", async () => {
    await store.writeSession(storedSession({ expiresAt: EXPIRING }));

    const loginAtLock = deferred();
    let loginDone = new Promise<unknown>(() => undefined);
    const server = fakeAuthServer(async (params) => {
      if (params.get('grant_type') === 'refresh_token') {
        // The refresh holds the lock until login is ready to write (or, if login
        // didn't take the lock, has already written).
        await Promise.race([loginAtLock.promise, loginDone]);

        return json({ ...tokenBody(1), access_token: 'refreshed-old-login' });
      }

      return json({
        ...tokenBody(2),
        access_token: 'new-login-access',
        refresh_token: 'new-login-refresh',
      });
    });
    const refreshing = provider(server).getAccessToken();

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
  });

  it('a refresh waiting on the lock while login writes uses the new login', async () => {
    await store.writeSession(storedSession({ expiresAt: EXPIRING }));

    // "Login" in another process holds the lock and writes a new, fresh session.
    const release = await createOAuthStore(dir).acquireLock('staging');
    const server = fakeAuthServer();
    const refreshAtLock = deferred();
    const pending = createTokenProvider('staging', {
      store: signallingStore(refreshAtLock),
      fetch: server.fetch,
      now: () => NOW,
      lock: { retryMs: 5, waitMs: 2000 },
    }).getAccessToken();

    await refreshAtLock.promise;
    await store.writeSession(
      storedSession({ accessToken: 'new-login', refreshToken: 'new-refresh', clientId: 'c2' }),
    );
    await release();

    await expect(pending).resolves.toBe('new-login');
    expect(server.tokenRequests()).toHaveLength(0);
    expect(await store.readSession('staging')).toMatchObject({
      accessToken: 'new-login',
      clientId: 'c2',
    });
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
    await store.writeSession({
      environment: 'staging',
      issuer: ISSUER,
      clientId: 'client-1',
      tokenEndpoint: TOKEN,
      accessToken: 'stored-access',
      refreshToken: 'stored-refresh',
      expiresAt: 10 * 60 * 1000,
      scope: undefined,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(tokenBody(2)));

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
