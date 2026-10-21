import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from './credentials.js';
import type { KizenIdentity } from './kizenClient.js';
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
import { accountKey, createOAuthStore, type OAuthSession, type OAuthStore } from './oauthStore.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  deferred,
  hangUntilAbort,
  holdingStore,
  httpGet,
  ISSUER,
  jsonResponse,
  NOW,
  oauthSession,
  rejectionOf,
  signIn,
  TOKEN_ENDPOINT as TOKEN,
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

/** What `/auth/bootstrap` says about account A, with the labels `oauthSession()` stores. */
const IDENTITY_A: KizenIdentity = {
  ...ACCOUNT_A,
  businessName: 'Acme A',
  fullName: 'Ada A',
  email: 'ada@a.test',
};

const IDENTITY_B: KizenIdentity = {
  ...ACCOUNT_B,
  businessName: 'Bravo B',
  fullName: 'Bob B',
  email: 'bob@b.test',
};

/**
 * `identify` for a login: the bootstrap answer (or rejection) the new tokens get. `tokens`
 * collects the access token each lookup was made with.
 */
const identifyAs =
  (identity: KizenIdentity | Error, tokens: string[] = []): LoginDeps['identify'] =>
  async (bearer) => {
    tokens.push(await bearer.getAccessToken());

    if (identity instanceof Error) {
      throw identity;
    }

    return identity;
  };

const loginDeps = (
  server: FakeAuthServer,
  browser: FakeBrowser,
  printed: string[] = [],
  identity: KizenIdentity | Error = IDENTITY_A,
): LoginDeps => ({
  store,
  fetch: server.fetch,
  now: () => NOW,
  print: (line) => {
    printed.push(line);
  },
  openBrowser: browser.open,
  startLoopbackServer,
  identify: identifyAs(identity),
  timeoutMs: 5000,
});

/** A staging token provider on `store` and `server`'s fetch; override what a test needs. */
const provider = (
  server: FakeAuthServer,
  overrides: Partial<TokenProviderDeps> = {},
): BearerTokenProvider =>
  createTokenProvider('staging', {
    store,
    fetch: server.fetch,
    now: () => NOW,
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
      ...IDENTITY_A,
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

  it('login looks up the identity with the new tokens before saving anything', async () => {
    const tokens: string[] = [];
    const order: string[] = [];
    const tracking: OAuthStore = {
      ...store,
      writeSession: async (session) => {
        order.push('writeSession');
        await store.writeSession(session);
      },
      setCurrent: async (environment, account) => {
        order.push('setCurrent');
        await store.setCurrent(environment, account);
      },
      readSession: async (environment) => {
        order.push('readSession');

        return store.readSession(environment);
      },
    };
    const deps: LoginDeps = {
      ...loginDeps(fakeAuthServer(), fakeBrowser(approve)),
      store: tracking,
      identify: async (bearer) => {
        order.push('identify');

        return identifyAs(IDENTITY_A, tokens)(bearer);
      },
    };

    await login('staging', deps);

    expect(tokens).toStrictEqual(['access-1']);
    expect(order).toStrictEqual(['identify', 'writeSession', 'setCurrent', 'readSession']);
  });

  it('login saves nothing when the identity lookup fails', async () => {
    await signIn(store, oauthSession());

    const deps = loginDeps(
      fakeAuthServer(),
      fakeBrowser(approve),
      [],
      new Error('Kizen is unavailable'),
    );

    await expect(login('staging', deps)).rejects.toThrow('Kizen is unavailable');
    // The previous sign-in is untouched, and no other account file appeared.
    expect(await store.readSession('staging')).toStrictEqual(oauthSession());
    expect((await readdir(store.dir)).sort()).toStrictEqual([
      'clients.json',
      `staging.${accountKey(ACCOUNT_A)}.json`,
      'staging.json',
    ]);
  });

  it('identity ids from the server only reach a path encoded, and invalid ones save nothing', async () => {
    // Path syntax from a (fake) server is saved inside oauth/, under its encoded name.
    const traversal = { ...IDENTITY_A, businessId: '../../x', userId: '/etc/passwd' };
    const saved = await login(
      'staging',
      loginDeps(fakeAuthServer(), fakeBrowser(approve), [], traversal),
    );

    expect(saved).toMatchObject({ businessId: '../../x', userId: '/etc/passwd' });
    expect((await readdir(store.dir)).sort()).toStrictEqual([
      'clients.json',
      `staging.${accountKey(traversal)}.json`,
      'staging.json',
    ]);
    expect((await readdir(dir)).sort()).toStrictEqual(['oauth']);

    // Ids that fail validation: nothing is written, and the previous sign-in stays current.
    for (const bad of [
      { ...IDENTITY_A, businessId: '' },
      { ...IDENTITY_A, userId: 'a\u0000b' },
      { ...IDENTITY_A, businessId: 'x'.repeat(200) },
      // One byte over the cap that keeps the file name within 255 bytes.
      { ...IDENTITY_A, businessId: 'x'.repeat(56) },
    ]) {
      const error = await rejectionOf(
        login('staging', loginDeps(fakeAuthServer(), fakeBrowser(approve), [], bad)),
      );

      expect(error.code).toBe('invalid_identity');
      expect(await store.readSession('staging')).toStrictEqual(saved);
      expect(await readdir(store.dir)).toHaveLength(3);
    }
  });

  it('re-login to the same account overwrites its file and leaves no second file', async () => {
    await login(
      'staging',
      loginDeps(
        fakeAuthServer(() => jsonResponse(tokenBody(1))),
        fakeBrowser(approve),
      ),
    );
    const second = await login(
      'staging',
      loginDeps(
        fakeAuthServer(() => jsonResponse(tokenBody(2))),
        fakeBrowser(approve),
        [],
        { ...IDENTITY_A, businessName: 'Acme Renamed' },
      ),
    );

    expect(await store.readSession('staging')).toStrictEqual(second);
    expect(second).toMatchObject({
      ...ACCOUNT_A,
      accessToken: 'access-2',
      businessName: 'Acme Renamed',
    });
    expect((await readdir(store.dir)).sort()).toStrictEqual([
      'clients.json',
      `staging.${accountKey(ACCOUNT_A)}.json`,
      'staging.json',
    ]);
    expect(JSON.parse(await readFile(store.sessionPath('staging'), 'utf-8'))).toStrictEqual(
      ACCOUNT_A,
    );
  });

  it('login to another account keeps the first one saved and makes the new one current', async () => {
    const first = await login('staging', loginDeps(fakeAuthServer(), fakeBrowser(approve)));
    const second = await login(
      'staging',
      loginDeps(
        fakeAuthServer(() => jsonResponse(tokenBody(9))),
        fakeBrowser(approve),
        [],
        IDENTITY_B,
      ),
    );

    expect(await store.readSession('staging')).toStrictEqual(second);
    expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(first);
    // Listed A (Acme) then B (Bravo); B is current.
    expect(
      (await store.listAccounts('staging')).map(({ account, current }) => [account, current]),
    ).toStrictEqual([
      [ACCOUNT_A, false],
      [ACCOUNT_B, true],
    ]);
  });

  it('login with makeCurrent saying no saves the account without moving the pointer', async () => {
    await signIn(store, oauthSession({ ...IDENTITY_B }));

    const seen: KizenIdentity[] = [];
    const session = await login('staging', loginDeps(fakeAuthServer(), fakeBrowser(approve)), {
      makeCurrent: (identity) => {
        seen.push(identity);

        return false;
      },
    });

    expect(seen).toStrictEqual([IDENTITY_A]);
    expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(session);
    expect(JSON.parse(await readFile(store.sessionPath('staging'), 'utf-8'))).toStrictEqual(
      ACCOUNT_B,
    );
  });

  it('a login whose account file is removed before it is pointed to fails rather than reporting success', async () => {
    // A logout of this account in another terminal lands between the write and the point.
    const removed: OAuthStore = {
      ...store,
      setCurrent: async (environment, account) => {
        await store.deleteSession(environment, account);
        await store.setCurrent(environment, account);
      },
    };
    const deps = { ...loginDeps(fakeAuthServer(), fakeBrowser(approve)), store: removed };
    const error = await rejectionOf(login('staging', deps));

    expect(error.code).toBe('login_required');
    expect(error.message).toBe(NOT_SIGNED_IN);
    expect(await store.readSession('staging')).toBeNull();
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
});

const EXPIRING = NOW + 30_000; // inside the 60s leeway

describe('createTokenProvider', () => {
  /** login-a with the tokens another refresh (or process) of it stored. */
  const ROTATED = oauthSession({ accessToken: 'access-rotated', refreshToken: 'refresh-rotated' });
  /** Another account, with its own tokens and app registration. */
  const LOGIN_B = oauthSession({
    ...IDENTITY_B,
    clientId: 'client-2',
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
  });

  it('returns a fresh token without refreshing', async () => {
    await signIn(store, oauthSession({ expiresAt: NOW + 61_000 }));

    const server = fakeAuthServer();

    await expect(provider(server).getAccessToken()).resolves.toBe('access-0');
    expect(server.tokenRequests()).toHaveLength(0);
  });

  it('concurrent token requests in one process trigger a single refresh', async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));

    let respond: (() => void) | undefined;
    const server = fakeAuthServer(
      (_, index) =>
        new Promise((resolve) => {
          respond = () => {
            resolve(jsonResponse(tokenBody(index + 1)));
          };
        }),
    );
    // Nothing across processes stops a second network refresh: only the in-process shared
    // promise keeps this at one.
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
    expect(server.tokenRequests()[0]?.get('grant_type')).toBe('refresh_token');
    expect(server.tokenRequests()[0]?.get('refresh_token')).toBe('refresh-0');
    expect(await store.readSession('staging')).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 3600 * 1000,
    });
    expect((await stat(store.accountPath('staging', ACCOUNT_A))).mode & 0o777).toBe(0o600);
  });

  it('getAccessToken during a 401-triggered refresh of a still-fresh token returns the refreshed token', async () => {
    // Fresh by expiry, so only the in-flight refresh says its token is rejected.
    await signIn(store, oauthSession());

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

  it('a 401 refresh after another process rotated past the rejected token uses the new one', async () => {
    // Fresh by expiry but rejected by the server: refresh even though it isn't expiring.
    await signIn(store, oauthSession());

    const server = fakeAuthServer();

    await expect(provider(server).refreshAccessToken('access-0')).resolves.toBe('access-1');
    expect(server.tokenRequests()).toHaveLength(1);

    // Rejected token is now stale: no second refresh, the current token is returned.
    await expect(provider(server).refreshAccessToken('access-0')).resolves.toBe('access-1');
    expect(server.tokenRequests()).toHaveLength(1);
  });

  it('invalid_grant on refresh deletes the session and asks to log in again', async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer(() =>
      jsonResponse({ error: 'invalid_grant', error_description: 'Token expired' }, 400),
    );
    const tokens = provider(server);
    const error = await rejectionOf(tokens.getAccessToken());

    expect(error.code).toBe('login_required');
    expect(error.message).toContain('appbuilder login --env staging');
    expect(await store.readSession('staging')).toBeNull();
    await expect(stat(store.accountPath('staging', ACCOUNT_A))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // No loop: the next call fails fast without another token request.
    expect((await rejectionOf(tokens.getAccessToken())).code).toBe('login_required');
    expect(server.tokenRequests()).toHaveLength(1);
  });

  it('invalid_client on refresh deletes the session, forgets the client id and asks to sign in', async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));
    await store.writeClientId(ISSUER, 'client-1');
    await store.writeClientId('https://other.test', 'client-other');

    const server = fakeAuthServer(() => jsonResponse({ error: 'invalid_client' }, 401));
    const error = await rejectionOf(provider(server).getAccessToken());

    expect(error.code).toBe('login_required');
    expect(error.message).toBe(
      'The staging session is no longer valid. Run `appbuilder login --env staging` to sign in.',
    );
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.readClientId(ISSUER)).toBeUndefined();
    expect(await store.readClientId('https://other.test')).toBe('client-other');
  });

  it('invalid_client keeps a client id another login registered meanwhile', async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));
    await store.writeClientId(ISSUER, 'client-1');

    const respond = deferred();
    const server = fakeAuthServer(async () => {
      await respond.promise;

      return jsonResponse({ error: 'invalid_client' }, 401);
    });
    const pending = provider(server).getAccessToken();

    pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(server.tokenRequests()).toHaveLength(1);
    });
    // A login in another process registers a new client, and is still waiting on the browser.
    await createOAuthStore(dir).writeClientId(ISSUER, 'client-new');
    respond.resolve();

    expect((await rejectionOf(pending)).code).toBe('login_required');
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.readClientId(ISSUER)).toBe('client-new');
  });

  it('an unreadable clients.json after invalid_client still asks to sign in', async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer(() => jsonResponse({ error: 'invalid_client' }, 401));
    const tokens = provider(server, {
      store: {
        ...store,
        readClientId: () =>
          Promise.reject(
            Object.assign(new Error('EACCES: permission denied, open clients.json'), {
              code: 'EACCES',
            }),
          ),
      },
    });
    const error = await rejectionOf(tokens.getAccessToken());

    expect(error.code).toBe('login_required');
    expect(error.message).toContain('is no longer valid');
    expect(await store.readSession('staging')).toBeNull();
  });

  it('invalid_client keeps the client id when this refresh did not delete the session', async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));
    await store.writeClientId(ISSUER, 'client-1');

    const server = fakeAuthServer(() => jsonResponse({ error: 'invalid_client' }, 401));
    // A logout lands between the re-read and this refresh's delete, so the delete finds nothing.
    const tokens = provider(server, {
      store: {
        ...store,
        deleteSession: async (environment, account) => {
          await store.signOut(environment);

          return store.deleteSession(environment, account);
        },
      },
    });

    expect((await rejectionOf(tokens.getAccessToken())).code).toBe('login_required');
    expect(await store.readSession('staging')).toBeNull();
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
    'transient refresh failure never writes or deletes: %s',
    async (_name, code, respond, messagePart?: string) => {
      const before = oauthSession({ expiresAt: EXPIRING });

      await signIn(store, before);

      const writeSession = vi.spyOn(store, 'writeSession');
      const deleteSession = vi.spyOn(store, 'deleteSession');
      const error = await rejectionOf(
        provider(fakeAuthServer(respond), { requestTimeoutMs: 50 }).getAccessToken(),
      );

      expect(error.code).toBe(code);

      if (messagePart !== undefined) {
        expect(error.message).toContain(messagePart);
      }

      expect(writeSession).not.toHaveBeenCalled();
      expect(deleteSession).not.toHaveBeenCalled();
      expect(await store.readSession('staging')).toStrictEqual(before);
    },
  );

  it("invalid_grant deletes only that environment's session", async () => {
    const other = oauthSession({
      environment: 'go',
      issuer: 'https://app.go.kizen.com',
      accessToken: 'go-access',
      refreshToken: 'go-refresh',
    });

    await signIn(store, oauthSession({ expiresAt: EXPIRING }));
    await signIn(store, other);

    const server = fakeAuthServer(() => jsonResponse({ error: 'invalid_grant' }, 400));

    expect((await rejectionOf(provider(server).getAccessToken())).code).toBe('login_required');
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.readSession('go')).toStrictEqual(other);
    expect(await store.listSessions()).toStrictEqual(['go']);
  });

  describe('a refresh whose token response is held', () => {
    const INVALID_GRANT = (): Response => jsonResponse({ error: 'invalid_grant' }, 400);
    const INVALID_CLIENT = (): Response => jsonResponse({ error: 'invalid_client' }, 401);

    /**
     * Starts a refresh of an expiring login-a session whose token response is held until
     * `release()`; resolves once the request is in flight. `respond` is the held response.
     */
    const heldRefresh = async (
      respond: (params: URLSearchParams) => Response | Promise<Response> = () =>
        jsonResponse(tokenBody(1)),
    ): Promise<{ pending: Promise<string>; release: () => void; server: FakeAuthServer }> => {
      await signIn(store, oauthSession({ expiresAt: EXPIRING }));

      const gate = deferred();
      const server = fakeAuthServer(async (params) => {
        await gate.promise;

        return respond(params);
      });
      const pending = provider(server).getAccessToken();

      // Observe the outcome even if a test asserts on it late.
      pending.catch(() => undefined);
      await vi.waitFor(() => {
        expect(server.tokenRequests()).toHaveLength(1);
      });

      return {
        pending,
        release: () => {
          gate.resolve();
        },
        server,
      };
    };

    it("a refresh that completes after logout doesn't restore the session", async () => {
      const { pending, release } = await heldRefresh();

      expect(await createOAuthStore(dir).signOut('staging')).toBe(true);
      release();

      const error = await rejectionOf(pending);

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(NOT_SIGNED_IN);
      await expect(stat(store.sessionPath('staging'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([
      [
        "a refresh that completes after a switch to another account doesn't overwrite it",
        undefined,
      ],
      [
        'a refresh that gets invalid_grant after a switch to another account does not delete it',
        INVALID_GRANT,
      ],
    ])('%s', async (_name, respond) => {
      const { pending, release, server } = await heldRefresh(respond);

      await signIn(createOAuthStore(dir), LOGIN_B);
      release();

      const error = await rejectionOf(pending);

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(SIGN_IN_CHANGED);
      expect(await store.readSession('staging')).toStrictEqual(LOGIN_B);
      expect(server.tokenRequests()).toHaveLength(1);
    });

    it("a refresh that completes after a switch saves the old account's new tokens and still aborts", async () => {
      const { pending, release } = await heldRefresh();

      // Account B was saved earlier; the user switches to it while A's refresh is out.
      await signIn(createOAuthStore(dir), LOGIN_B);
      release();

      const error = await rejectionOf(pending);

      expect(error.message).toBe(SIGN_IN_CHANGED);
      // The pointer is still B, and A's file holds the pair the server just issued, so switching
      // back to A later works.
      expect(JSON.parse(await readFile(store.sessionPath('staging'), 'utf-8'))).toStrictEqual(
        ACCOUNT_B,
      );
      expect(await store.readSession('staging')).toStrictEqual(LOGIN_B);
      expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(
        oauthSession({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: NOW + 3600 * 1000,
        }),
      );
    });

    it('a refresh that completes after a switch and a logout of the old account writes nothing', async () => {
      const { pending, release } = await heldRefresh();

      await signIn(createOAuthStore(dir), LOGIN_B);
      await createOAuthStore(dir).removeAccount('staging', ACCOUNT_A);
      release();

      expect((await rejectionOf(pending)).message).toBe(SIGN_IN_CHANGED);
      expect(await store.readAccount('staging', ACCOUNT_A)).toBeNull();
      expect(await store.readSession('staging')).toStrictEqual(LOGIN_B);
    });

    it("a refresh that completes after a switch keeps a peer's newer tokens for the old account", async () => {
      const { pending, release } = await heldRefresh();

      await signIn(createOAuthStore(dir), LOGIN_B);
      await createOAuthStore(dir).writeSession(ROTATED);
      release();

      expect((await rejectionOf(pending)).message).toBe(SIGN_IN_CHANGED);
      expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(ROTATED);
    });

    it("a refresh that completes after a peer rotated keeps the peer's tokens", async () => {
      const { pending, release } = await heldRefresh();

      await createOAuthStore(dir).writeSession(ROTATED);
      release();

      // This command still gets the access token it was issued, but doesn't store it.
      await expect(pending).resolves.toBe('access-1');
      expect(await store.readSession('staging')).toStrictEqual(ROTATED);
    });

    it.each([
      ['invalid_grant', INVALID_GRANT],
      ['invalid_client', INVALID_CLIENT],
    ])(
      "%s after a peer rotated returns the peer's token and keeps the session",
      async (_name, respond) => {
        await store.writeClientId(ISSUER, 'client-1');

        const { pending, release, server } = await heldRefresh(respond);

        await createOAuthStore(dir).writeSession(ROTATED);
        release();

        await expect(pending).resolves.toBe('access-rotated');
        expect(await store.readSession('staging')).toStrictEqual(ROTATED);
        // The client wasn't forgotten: the session that uses it is still there.
        expect(await store.readClientId(ISSUER)).toBe('client-1');
        expect(server.tokenRequests()).toHaveLength(1);
      },
    );

    it.each([
      ['accepted, stores its rotation', true],
      ['refused too, deletes the session after one more request', false],
    ])(
      "invalid_grant after a peer rotated to tokens that aren't fresh refreshes them once: %s",
      async (_name, peerAccepted) => {
        const peer = oauthSession({
          accessToken: 'access-peer',
          refreshToken: 'refresh-peer',
          expiresAt: EXPIRING,
        });
        const { pending, release, server } = await heldRefresh((params) =>
          peerAccepted && params.get('refresh_token') === 'refresh-peer'
            ? jsonResponse(tokenBody(7))
            : INVALID_GRANT(),
        );

        await createOAuthStore(dir).writeSession(peer);
        release();

        if (peerAccepted) {
          await expect(pending).resolves.toBe('access-7');
          expect(await store.readSession('staging')).toStrictEqual(
            oauthSession({
              accessToken: 'access-7',
              refreshToken: 'refresh-7',
              expiresAt: NOW + 3600 * 1000,
            }),
          );
        } else {
          expect((await rejectionOf(pending)).message).toContain('is no longer valid');
          expect(await store.readSession('staging')).toBeNull();
        }

        expect(server.tokenRequests().map((params) => params.get('refresh_token'))).toStrictEqual([
          'refresh-0',
          'refresh-peer',
        ]);
      },
    );

    it('the refresh after a peer rotated runs at most once', async () => {
      const stale = (n: string): OAuthSession =>
        oauthSession({
          accessToken: `access-${n}`,
          refreshToken: `refresh-${n}`,
          expiresAt: EXPIRING,
        });
      const { pending, release, server } = await heldRefresh(async (params) => {
        // While the retry is in flight, yet another peer rotates to tokens that aren't fresh.
        if (params.get('refresh_token') === 'refresh-peer') {
          await createOAuthStore(dir).writeSession(stale('peer2'));
        }

        return INVALID_GRANT();
      });

      await createOAuthStore(dir).writeSession(stale('peer'));
      release();

      // The newest peer's token comes back as it is, without a third request or a delete.
      await expect(pending).resolves.toBe('access-peer2');
      expect(server.tokenRequests().map((params) => params.get('refresh_token'))).toStrictEqual([
        'refresh-0',
        'refresh-peer',
      ]);
      expect(await store.readSession('staging')).toStrictEqual(stale('peer2'));
    });

    it('a refresh with no refresh token does not delete another account that became current', async () => {
      await signIn(store, oauthSession({ expiresAt: EXPIRING, refreshToken: undefined }));

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

            // The second read is the refresh's own: pause right after it.
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
      await signIn(createOAuthStore(dir), LOGIN_B);
      resume.resolve();

      const error = await rejectionOf(pending);

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(SIGN_IN_CHANGED);
      expect(await store.readSession('staging')).toStrictEqual(LOGIN_B);
      expect(server.fetch).not.toHaveBeenCalled();
    });

    it('a refresh with no refresh token deletes the unchanged session', async () => {
      await signIn(store, oauthSession({ expiresAt: EXPIRING, refreshToken: undefined }));

      const server = fakeAuthServer();
      const error = await rejectionOf(provider(server).getAccessToken());

      expect(error.message).toBe(
        'The staging session has expired. Run `appbuilder login --env staging` to sign in.',
      );
      expect(await store.readSession('staging')).toBeNull();
      expect(server.fetch).not.toHaveBeenCalled();
    });
  });

  describe('a refresh held after its last check', () => {
    /** A real login to account B on its own fake server, so its tokens differ from the refresh's. */
    const loginB = (): Promise<OAuthSession> =>
      login(
        'staging',
        loginDeps(
          fakeAuthServer(() => jsonResponse(tokenBody(50))),
          fakeBrowser(approve),
          [],
          IDENTITY_B,
        ),
      );

    /** Starts a refresh of login A through `held`'s store; resolves once it is held. */
    const refreshUntilHeld = async (
      method: 'writeSession' | 'deleteSession',
      respond?: Parameters<typeof fakeAuthServer>[0],
    ): Promise<{ pending: Promise<string>; release: () => void }> => {
      await signIn(store, oauthSession({ expiresAt: EXPIRING }));

      const held = holdingStore(createOAuthStore(dir), method);
      const pending = provider(fakeAuthServer(respond), { store: held.store }).getAccessToken();

      pending.catch(() => undefined);
      await held.reached;

      return { pending, release: held.release };
    };

    it("a refresh that writes after logout doesn't undo it", async () => {
      const { pending, release } = await refreshUntilHeld('writeSession');

      expect(await createOAuthStore(dir).signOut('staging')).toBe(true);
      release();

      // The refresh went through and wrote account A's own file, which is saved but not current.
      await expect(pending).resolves.toBe('access-1');
      expect(
        JSON.parse(await readFile(store.accountPath('staging', ACCOUNT_A), 'utf-8')),
      ).toMatchObject({ ...ACCOUNT_A, accessToken: 'access-1' });
      // The logout stands.
      expect(await store.readSession('staging')).toBeNull();
      expect(await store.listSessions()).toStrictEqual([]);
    });

    it("a refresh that writes after another account becomes current doesn't replace it", async () => {
      const { pending, release } = await refreshUntilHeld('writeSession');
      const b = await loginB();

      release();

      await expect(pending).resolves.toBe('access-1');
      expect(b).toMatchObject({
        ...ACCOUNT_B,
        accessToken: 'access-50',
        refreshToken: 'refresh-50',
      });
      // Current is exactly B, and A's file holds A's own refreshed tokens.
      expect(await store.readSession('staging')).toStrictEqual(b);
      expect(JSON.parse(await readFile(store.sessionPath('staging'), 'utf-8'))).toStrictEqual(
        ACCOUNT_B,
      );
      expect(await store.readAccount('staging', ACCOUNT_A)).toMatchObject({
        ...ACCOUNT_A,
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
      });
      expect(await store.listSessions()).toStrictEqual(['staging']);
    });

    it("an invalid_grant delete after another account becomes current doesn't remove it", async () => {
      const { pending, release } = await refreshUntilHeld('deleteSession', () =>
        jsonResponse({ error: 'invalid_grant' }, 400),
      );
      const b = await loginB();

      release();

      expect((await rejectionOf(pending)).message).toContain('is no longer valid');
      // Only account A's file went.
      await expect(stat(store.accountPath('staging', ACCOUNT_A))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await store.readSession('staging')).toStrictEqual(b);
    });
  });

  describe('two processes refreshing at once', () => {
    const GRACE_MS = 300_000;

    /**
     * A token endpoint with Kizen's refresh semantics (django-oauth-toolkit with rotation and a
     * 300s grace period, no reuse protection): a refresh token presented again within the grace
     * window of its rotation gets the same pair, as long as that pair's refresh token hasn't been
     * rotated itself; otherwise invalid_grant, and nothing is revoked. Rotation deletes the
     * previous access token.
     */
    const graceServer = (initial: {
      access: string;
      refresh: string;
    }): {
      respond: (refresh: string | null) => Response;
      accepts: (refresh: string | undefined) => boolean;
      validAccess: (access: string) => boolean;
      advance: (ms: number) => void;
    } => {
      let serverNow = 0;
      let issued = 0;
      const validAccess = new Set([initial.access]);
      const live = new Set([initial.refresh]);
      const rotations = new Map<string, { at: number; access: string; refresh: string }>();

      const respond = (refresh: string | null): Response => {
        if (refresh !== null && live.has(refresh)) {
          issued += 1;

          const pair = { access: `access-${String(issued)}`, refresh: `refresh-${String(issued)}` };
          const previous = [...rotations.values()].find((r) => r.refresh === refresh)?.access;

          validAccess.delete(previous ?? initial.access);
          validAccess.add(pair.access);
          live.delete(refresh);
          live.add(pair.refresh);
          rotations.set(refresh, { at: serverNow, ...pair });

          return jsonResponse({ ...tokenBody(issued), access_token: pair.access });
        }

        const rotation = refresh === null ? undefined : rotations.get(refresh);

        if (rotation && serverNow - rotation.at <= GRACE_MS && live.has(rotation.refresh)) {
          return jsonResponse({
            access_token: rotation.access,
            refresh_token: rotation.refresh,
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }

        return jsonResponse({ error: 'invalid_grant' }, 400);
      };

      return {
        respond,
        accepts: (refresh: string | undefined) => refresh !== undefined && live.has(refresh),
        validAccess: (access: string) => validAccess.has(access),
        advance: (ms: number) => {
          serverNow += ms;
        },
      };
    };

    it.each([
      ['both inside the grace window', 0],
      ['the second after the grace window', GRACE_MS + 1],
    ])(
      'two processes refreshing at once both keep a working session: %s',
      async (_name, secondDelayMs) => {
        for (const first of [0, 1]) {
          await signIn(store, oauthSession({ expiresAt: EXPIRING }));

          const kizen = graceServer({ access: 'access-0', refresh: 'refresh-0' });
          const gates = [deferred(), deferred()];
          // One fake server, two processes: separate providers on separate stores over one dir.
          const servers = gates.map((gate) =>
            fakeAuthServer(async (params) => {
              await gate.promise;

              return kizen.respond(params.get('refresh_token'));
            }),
          );
          const pending = servers.map((server) =>
            provider(server, { store: createOAuthStore(dir) }).getAccessToken(),
          );

          // Both have sent refresh-0 before either is answered.
          await vi.waitFor(() => {
            expect(servers.map((server) => server.tokenRequests().length)).toStrictEqual([1, 1]);
          });

          const second = 1 - first;

          gates[first]?.resolve();
          await pending[first];
          kizen.advance(secondDelayMs);
          gates[second]?.resolve();

          const tokens = await Promise.all(pending);
          const stored = await store.readSession('staging');

          // Each process got a token the server still accepts, and the file holds a pair the
          // server accepts for the next refresh.
          expect(tokens.every((token) => kizen.validAccess(token))).toBe(true);
          expect(kizen.validAccess(stored?.accessToken ?? '')).toBe(true);
          expect(kizen.accepts(stored?.refreshToken)).toBe(true);
        }
      },
    );

    it('a delayed write after a peer rotation within the grace window leaves a working session', async () => {
      await signIn(store, oauthSession({ expiresAt: EXPIRING }));

      const kizen = graceServer({ access: 'access-0', refresh: 'refresh-0' });
      const answer = (): FakeAuthServer =>
        fakeAuthServer((params) => kizen.respond(params.get('refresh_token')));
      // Process 1 is answered first, passes its re-read, and is held before it writes.
      const held = holdingStore(createOAuthStore(dir), 'writeSession');
      const delayed = provider(answer(), { store: held.store }).getAccessToken();

      await held.reached;

      // Process 2 presents the same refresh token inside the grace window and stores its rotation.
      kizen.advance(GRACE_MS - 1);

      const peer = await provider(answer(), { store: createOAuthStore(dir) }).getAccessToken();
      const peerStored = await store.readSession('staging');

      // Then process 1's write lands over it.
      held.release();

      const tokens = [await delayed, peer];
      const stored = await store.readSession('staging');

      expect(tokens.every((token) => kizen.validAccess(token))).toBe(true);
      expect(stored).toStrictEqual(peerStored);
      expect(kizen.validAccess(stored?.accessToken ?? '')).toBe(true);
      expect(kizen.accepts(stored?.refreshToken)).toBe(true);
    });
  });

  it('a refresh with the session unchanged writes the rotated tokens', async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer();

    await expect(provider(server).getAccessToken()).resolves.toBe('access-1');
    expect(await store.readSession('staging')).toStrictEqual(
      oauthSession({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: NOW + 3600 * 1000,
      }),
    );
  });

  it.each([
    ['an expiring session with a refresh token', { expiresAt: EXPIRING }],
    [
      'an expiring session without a refresh token',
      { expiresAt: EXPIRING, refreshToken: undefined },
    ],
    ['a fresh session', {}],
  ] as const)(
    'refresh does not request or write when another account became current (%s)',
    async (_, replacement) => {
      await signIn(store, oauthSession({ expiresAt: EXPIRING }));

      const newLogin = { ...LOGIN_B, ...replacement };
      const server = fakeAuthServer();
      let reads = 0;
      // "Login" in another process lands after the provider read (and pinned) login-a, before
      // the refresh reads the session again.
      const pending = provider(server, {
        store: {
          ...store,
          readSession: async (environment) => {
            reads += 1;

            if (reads === 2) {
              await signIn(createOAuthStore(dir), newLogin);
            }

            return store.readSession(environment);
          },
        },
      }).getAccessToken();

      const error = await rejectionOf(pending);

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(SIGN_IN_CHANGED);
      // Neither refresh token was spent, and the new login's session is untouched.
      expect(server.fetch).not.toHaveBeenCalled();
      expect(await store.readSession('staging')).toStrictEqual(newLogin);
    },
  );

  it('switching to another account aborts a running command with sign-in changed', async () => {
    await signIn(store, oauthSession());

    const server = fakeAuthServer();
    const tokens = provider(server);

    await expect(tokens.getAccessToken()).resolves.toBe('access-0');

    const newLogin = oauthSession({ ...ACCOUNT_B, accessToken: 'access-b' });

    await signIn(store, newLogin);

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

  it('another user in the same business is another account to the pin', async () => {
    await signIn(store, oauthSession());

    const tokens = provider(fakeAuthServer());

    await expect(tokens.getAccessToken()).resolves.toBe('access-0');
    await signIn(store, oauthSession({ userId: 'user-other', accessToken: 'access-other' }));

    expect((await rejectionOf(tokens.getAccessToken())).message).toBe(SIGN_IN_CHANGED);
  });

  it("re-login to the same account doesn't abort a running command", async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer((params) =>
      jsonResponse(tokenBody(params.get('refresh_token') === 'refresh-relogin' ? 8 : 1)),
    );
    const tokens = provider(server);

    await expect(tokens.getAccessToken()).resolves.toBe('access-1');

    // Signing in again to account A, maybe with a new app registration, replaces its tokens.
    const relogin = oauthSession({
      clientId: 'client-2',
      accessToken: 'access-relogin',
      refreshToken: 'refresh-relogin',
    });

    await signIn(store, relogin);

    // The command keeps going, on the new sign-in's tokens.
    await expect(tokens.getAccessToken()).resolves.toBe('access-relogin');
    await expect(tokens.refreshAccessToken('access-relogin')).resolves.toBe('access-8');
    expect(server.tokenRequests().at(-1)?.get('client_id')).toBe('client-2');
    expect(await store.readSession('staging')).toMatchObject({
      ...ACCOUNT_A,
      clientId: 'client-2',
      accessToken: 'access-8',
      refreshToken: 'refresh-8',
    });
  });

  it("a held refresh after a re-login to the same account keeps the re-login's tokens", async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));

    const gate = deferred();
    const server = fakeAuthServer(async () => {
      await gate.promise;

      return jsonResponse(tokenBody(1));
    });
    const pending = provider(server).getAccessToken();
    const relogin = oauthSession({
      accessToken: 'access-relogin',
      refreshToken: 'refresh-relogin',
    });

    await vi.waitFor(() => {
      expect(server.tokenRequests()).toHaveLength(1);
    });
    await signIn(createOAuthStore(dir), relogin);
    gate.resolve();

    // Not "sign-in changed": the command gets the token it was issued, and the file keeps the
    // re-login's tokens, like a peer's rotation.
    await expect(pending).resolves.toBe('access-1');
    expect(await store.readSession('staging')).toStrictEqual(relogin);
  });

  it('a refresh of a non-current saved account never changes the pointer', async () => {
    // A is saved and expiring; B is current.
    await store.writeSession(oauthSession({ expiresAt: EXPIRING }));
    await signIn(store, LOGIN_B);

    const server = fakeAuthServer();
    const setCurrent = vi.spyOn(store, 'setCurrent');
    const tokens = provider(server, { account: ACCOUNT_A });

    await expect(tokens.getAccessToken()).resolves.toBe('access-1');
    // A refused refresh token too: the account's file goes, the pointer stays.
    await expect(tokens.refreshAccessToken('access-1')).resolves.toBe('access-2');

    expect(setCurrent).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(store.sessionPath('staging'), 'utf-8'))).toStrictEqual(
      ACCOUNT_B,
    );
    expect(await store.readSession('staging')).toStrictEqual(LOGIN_B);
    expect(await store.readAccount('staging', ACCOUNT_A)).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });

    const refused = provider(
      fakeAuthServer(() => jsonResponse({ error: 'invalid_grant' }, 400)),
      { account: ACCOUNT_A },
    );

    expect((await rejectionOf(refused.refreshAccessToken('access-2'))).code).toBe('login_required');
    expect(await store.readAccount('staging', ACCOUNT_A)).toBeNull();
    expect(setCurrent).not.toHaveBeenCalled();
    expect(await store.readSession('staging')).toStrictEqual(LOGIN_B);
  });

  it('keeps working across refresh-token rotation within one login', async () => {
    await signIn(store, oauthSession({ expiresAt: EXPIRING }));

    const server = fakeAuthServer();
    const tokens = provider(server);

    // This process rotates the refresh token.
    await expect(tokens.getAccessToken()).resolves.toBe('access-1');
    expect(await store.readSession('staging')).toMatchObject({
      ...ACCOUNT_A,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });

    // Another process rotates it again within the same login.
    await signIn(store, ROTATED);
    await expect(tokens.getAccessToken()).resolves.toBe('access-rotated');

    // And a 401 makes this process rotate once more.
    await expect(tokens.refreshAccessToken('access-rotated')).resolves.toBe('access-2');
    expect(server.tokenRequests().map((params) => params.get('refresh_token'))).toStrictEqual([
      'refresh-0',
      'refresh-rotated',
    ]);
    expect(await store.readSession('staging')).toMatchObject({
      ...ACCOUNT_A,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
  });

  it('concurrent first reads pin one account', async () => {
    const reads = [deferred<OAuthSession>(), deferred<OAuthSession>()];
    let index = 0;
    const readSession = vi.fn(() => {
      const read = reads[index];

      index += 1;

      return read ? read.promise : store.readSession('staging');
    });
    const server = fakeAuthServer();
    // Fresh sessions only, so nothing refreshes.
    const tokens = provider(server, { store: { ...store, readSession } });
    const first = tokens.getAccessToken();
    const second = tokens.getAccessToken();

    expect(readSession).toHaveBeenCalledTimes(2);

    // The second call's read lands first, with account A; the first call's read
    // then sees account B. Whichever lands first is the pin; the other must fail.
    reads[1]?.resolve(oauthSession({ accessToken: 'access-a' }));
    await expect(second).resolves.toBe('access-a');
    reads[0]?.resolve(oauthSession({ ...ACCOUNT_B, accessToken: 'access-b' }));
    expect((await rejectionOf(first)).code).toBe('login_required');

    // The pin is account A: it keeps serving A and refuses B.
    await signIn(store, oauthSession({ accessToken: 'access-a2' }));
    await expect(tokens.getAccessToken()).resolves.toBe('access-a2');
    await signIn(store, oauthSession({ ...ACCOUNT_B, accessToken: 'access-b2' }));
    expect((await rejectionOf(tokens.getAccessToken())).code).toBe('login_required');
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it('a logout mid-command still asks to sign in', async () => {
    await signIn(store, oauthSession());

    const tokens = provider(fakeAuthServer());

    await expect(tokens.getAccessToken()).resolves.toBe('access-0');
    await store.signOut('staging');

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
      message:
        "You're not signed in. Run `appbuilder login` (add `--env <env>` to sign in to an environment other than go).",
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
    await signIn(
      store,
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
