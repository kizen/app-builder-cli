import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from './credentials.js';
import { createKizenClient } from './kizenClient.js';
import {
  AUTH_HEADER_REQUEST_TIMEOUT_MS,
  CLAUDE_CODE_HELPER_LIMIT_MS,
  createDefaultAuthCommandDeps,
  runAuthHeader,
  runLogin,
  runLogout,
  runWhoami,
  type AuthCommandDeps,
} from './oauthCommands.js';
import { createTokenProvider, type LoginDeps, type TokenProviderOptions } from './oauthSession.js';
import { createOAuthStore, type OAuthSession, type OAuthStore } from './oauthStore.js';
import {
  deferred,
  hangUntilAbort,
  ISSUER,
  jsonResponse,
  NOW,
  oauthSession,
  rejectionOf,
} from '../test/oauth.js';

const ACCESS = 'secret-access-7f3a';
const REFRESH = 'secret-refresh-91bc';
const ROTATED_ACCESS = 'secret-access-rotated-22d0';
const ROTATED_REFRESH = 'secret-refresh-rotated-5e1f';

let dir: string;
let store: OAuthStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'appbuilder-oauth-cmd-'));
  store = createOAuthStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const session = (environment: Environment, overrides: Partial<OAuthSession> = {}): OAuthSession =>
  oauthSession({
    environment,
    loginId: 'login-1',
    tokenEndpoint: 'https://staging.kizen.com/oauth2/token',
    accessToken: ACCESS,
    refreshToken: REFRESH,
    ...overrides,
  });

const BOOTSTRAP = {
  team: { id: 't1', user: 'user-9', full_name: 'Ada Lovelace', email: 'ada@example.com' },
  business: { id: 'biz-9', name: 'Acme Corp' },
};

interface Harness {
  deps: AuthCommandDeps;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  providerOptions: TokenProviderOptions[];
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  all: () => string;
}

interface HarnessOptions {
  processEnv?: Record<string, string | undefined>;
  timeouts?: AuthCommandDeps['authHeaderTimeouts'];
  /** Token endpoint behavior; defaults to issuing the rotated pair. */
  tokenEndpoint?: (init: RequestInit | undefined) => Response | Promise<Response>;
}

const rotatedTokens = (): Response =>
  jsonResponse({
    access_token: ROTATED_ACCESS,
    refresh_token: ROTATED_REFRESH,
    token_type: 'Bearer',
    expires_in: 3600,
  });

/** Real store, real token provider and Kizen client; only `fetch` is fake. */
function harness(
  kizen: (url: string, auth: string | undefined) => Response,
  options: HarnessOptions = {},
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const providerOptions: TokenProviderOptions[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = input as string;

    if (url.endsWith('/oauth2/token')) {
      return Promise.resolve((options.tokenEndpoint ?? rotatedTokens)(init));
    }

    return Promise.resolve(
      kizen(url, (init?.headers as Record<string, string> | undefined)?.Authorization),
    );
  });
  const now = (): number => NOW;
  const tokenProvider: AuthCommandDeps['tokenProvider'] = (environment, providerOpts = {}) => {
    providerOptions.push(providerOpts);

    return createTokenProvider(environment, { store, fetch: fetchMock, now, ...providerOpts });
  };

  const deps: AuthCommandDeps = {
    store,
    loginDeps: {} as LoginDeps,
    getIdentity: (environment) =>
      createKizenClient({ bearer: tokenProvider(environment), fetch: fetchMock }).getIdentity(),
    tokenProvider,
    authHeaderTimeouts: options.timeouts ?? { requestTimeoutMs: AUTH_HEADER_REQUEST_TIMEOUT_MS },
    processEnv: options.processEnv ?? {},
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
  };

  return {
    deps,
    fetchMock,
    providerOptions,
    stdout,
    stderr,
    exitCodes,
    all: () => [...stdout, ...stderr].join(''),
  };
}

const expectNoSecrets = (text: string): void => {
  for (const secret of [ACCESS, REFRESH, ROTATED_ACCESS, ROTATED_REFRESH]) {
    expect(text).not.toContain(secret);
  }
};

/** A failed auth-header: nothing on stdout, exit 1, one token-free stderr line containing `contains`. */
const expectHeaderFailure = (
  h: Pick<Harness, 'stdout' | 'stderr' | 'exitCodes'>,
  contains = '',
): void => {
  expect(h.stdout).toStrictEqual([]);
  expect(h.exitCodes).toStrictEqual([1]);
  expect(h.stderr).toHaveLength(1);
  expect(h.stderr[0]).toContain(contains);
  expectNoSecrets(h.stderr.join(''));
};

describe('whoami', () => {
  it('whoami output never contains the access or refresh token', async () => {
    // Fixture 1: fresh token, used as is.
    await store.writeSession(session('staging'));

    const fresh = harness((url, auth) =>
      url.endsWith('/auth/bootstrap') && auth === `Bearer ${ACCESS}`
        ? jsonResponse(BOOTSTRAP)
        : jsonResponse({ detail: 'unexpected' }, 400),
    );

    await runWhoami({ env: 'staging' }, fresh.deps);

    expect(fresh.stdout.join('')).toBe(
      'Environment: staging\nUser: Ada Lovelace <ada@example.com> (user-9)\nBusiness: Acme Corp (biz-9)\n',
    );
    expect(fresh.exitCodes).toStrictEqual([]);
    expectNoSecrets(fresh.all());

    // Fixture 2: expiring token, refreshed (rotated) first.
    await store.writeSession(session('staging', { expiresAt: NOW + 10_000 }));

    const refreshed = harness((url, auth) =>
      auth === `Bearer ${ROTATED_ACCESS}`
        ? jsonResponse(BOOTSTRAP)
        : jsonResponse({ detail: 'old token' }, 401),
    );

    await runWhoami({}, refreshed.deps);

    expect(refreshed.stdout.join('')).toContain('Business: Acme Corp (biz-9)');
    expect(refreshed.fetchMock.mock.calls.map(([url]) => url as string)).toContain(
      'https://staging.kizen.com/oauth2/token',
    );
    expectNoSecrets(refreshed.all());

    // Fixture 3: Kizen rejects the session; the error output is token-free too.
    const rejected = harness(() => jsonResponse({ detail: 'Invalid token.' }, 401));

    await runWhoami({ env: 'staging' }, rejected.deps);

    expect(rejected.exitCodes).toStrictEqual([1]);
    expect(rejected.stderr.join('')).toContain('appbuilder login --env staging');
    expectNoSecrets(rejected.all());
  });

  it('asks to log in when there is no session', async () => {
    const h = harness(() => jsonResponse(BOOTSTRAP));

    await runWhoami({}, h.deps);

    expect(h.exitCodes).toStrictEqual([1]);
    expect(h.stderr.join('')).toContain('appbuilder login --env go');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('asks for --env when several sessions exist, and rejects an unknown one', async () => {
    await store.writeSession(session('staging'));
    await store.writeSession(session('integration'));

    const h = harness(() => jsonResponse(BOOTSTRAP));

    await runWhoami({}, h.deps);
    await runWhoami({ env: 'prod' }, h.deps);

    expect(h.stderr.join('')).toContain('pass --env <env>: staging, integration');
    expect(h.stderr.join('')).toContain('Unknown --env "prod"');
    expect(h.exitCodes).toStrictEqual([1, 1]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  it('deletes only the chosen session, locally', async () => {
    await store.writeSession(session('staging'));
    await store.writeSession(session('integration'));

    const h = harness(() => jsonResponse(BOOTSTRAP));

    await runLogout({ env: 'staging' }, h.deps);

    expect(await store.readSession('staging')).toBeNull();
    expect(await store.readSession('integration')).not.toBeNull();
    expect(h.stdout.join('')).toContain('Signed out of staging');
    expect(h.fetchMock).not.toHaveBeenCalled();

    await runLogout({ env: 'staging' }, h.deps);
    await runLogout({}, h.deps);

    expect(await store.readSession('integration')).toBeNull();
    expect(h.stdout.join('')).toContain('Not signed in to staging.');

    await runLogout({}, h.deps);

    expect(h.stdout.at(-1)).toBe('Not signed in.\n');
    expect(h.exitCodes).toStrictEqual([]);
  });
});

describe('logout and a refresh', () => {
  it('logout during an in-flight refresh leaves no session on disk', async () => {
    await store.writeSession(session('staging', { expiresAt: NOW + 30_000 }));

    const started = deferred();
    const respond = deferred();
    const h = harness(() => jsonResponse(BOOTSTRAP), {
      // The token response is held until logout has finished.
      tokenEndpoint: async () => {
        started.resolve();
        await respond.promise;

        return rotatedTokens();
      },
    });
    const refreshing = h.deps.tokenProvider('staging').getAccessToken();

    refreshing.catch(() => undefined);
    await started.promise;
    await runLogout({ env: 'staging' }, h.deps);
    respond.resolve();

    const error = await rejectionOf(refreshing);

    expect(error.code).toBe('login_required');
    expect(await store.readSession('staging')).toBeNull();
    await expect(stat(store.sessionPath('staging'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.stdout.join('')).toContain('Signed out of staging');
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('logout removes a corrupt session file', async () => {
    const h = harness(() => jsonResponse(BOOTSTRAP));
    const path = store.sessionPath('staging');

    await mkdir(store.dir, { recursive: true });

    // With --env, and as the only (unreadable) session without it.
    for (const options of [{ env: 'staging' }, {}]) {
      await writeFile(path, '{"accessToken": "secret-in-file", "trunc');
      await runLogout(options, h.deps);

      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(h.stdout.at(-1)).toBe(
        'Signed out of staging. The session was removed from this machine.\n',
      );
    }

    expect(h.exitCodes).toStrictEqual([]);
    expect(h.all()).not.toContain('secret-in-file');
  });
});

describe('unreadable session', () => {
  const corrupt = async (): Promise<string> => {
    await mkdir(store.dir, { recursive: true });
    await writeFile(store.sessionPath('staging'), `{"accessToken": "${ACCESS}", "trunc`);

    return store.sessionPath('staging');
  };

  it("whoami reports the unreadable file rather than 'not signed in'", async () => {
    const path = await corrupt();
    const h = harness(() => jsonResponse(BOOTSTRAP));

    await runWhoami({}, h.deps);

    expect(h.exitCodes).toStrictEqual([1]);
    expect(h.stderr.join('')).toContain(`The saved staging session at ${path} can't be read.`);
    expect(h.stderr.join('')).toContain('appbuilder login --env staging');
    expect(h.stderr.join('')).not.toContain("You're not signed in");
    expectNoSecrets(h.all());
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('login', () => {
  /** A server and browser that approve at once, so the real `login` signs in to staging. */
  const approvingLoginDeps = (): LoginDeps => ({
    store,
    fetch: (input) => {
      const url = input as string;

      return Promise.resolve(
        url.endsWith('/.well-known/oauth-authorization-server')
          ? jsonResponse({
              issuer: ISSUER,
              authorization_endpoint: `${ISSUER}/oauth2/authorize`,
              token_endpoint: `${ISSUER}/oauth2/token`,
              registration_endpoint: `${ISSUER}/oauth2/register`,
            })
          : url.endsWith('/oauth2/register')
            ? jsonResponse({ client_id: 'client-1' }, 201)
            : rotatedTokens(),
      );
    },
    now: () => NOW,
    print: () => undefined,
    openBrowser: () => undefined,
    startLoopbackServer: () =>
      Promise.resolve({
        host: '127.0.0.1',
        port: 1,
        redirectUri: 'http://127.0.0.1:1/callback',
        result: Promise.resolve({ code: 'auth-code' }),
        close: () => Promise.resolve(),
      }),
  });

  it('login prints Signed in and the account identity', async () => {
    const h = harness(() => jsonResponse({ detail: 'login never calls Kizen' }, 500));

    await runLogin(
      { env: 'staging' },
      {
        ...h.deps,
        loginDeps: approvingLoginDeps(),
        getIdentity: () =>
          Promise.resolve({
            userId: 'user-9',
            businessId: 'biz-9',
            businessName: 'Acme Corp',
            fullName: 'Ada Lovelace',
            email: 'ada@example.com',
          }),
      },
    );

    expect(h.stdout).toStrictEqual([
      'Signed in to staging.\n',
      'Environment: staging\nUser: Ada Lovelace <ada@example.com> (user-9)\nBusiness: Acme Corp (biz-9)\n',
    ]);
    expect(h.stderr).toStrictEqual(['Signing in to staging.\n']);
    expect(h.exitCodes).toStrictEqual([]);
    expect(await store.readSession('staging')).toMatchObject({ accessToken: ROTATED_ACCESS });
    expectNoSecrets(h.all());
  });

  it("login still succeeds when the account details can't be loaded", async () => {
    const h = harness(() => jsonResponse({ detail: 'login never calls Kizen' }, 500));

    await runLogin(
      { env: 'staging' },
      {
        ...h.deps,
        loginDeps: approvingLoginDeps(),
        getIdentity: () => Promise.reject(new Error('Kizen is unavailable')),
      },
    );

    expect(h.stdout).toStrictEqual(['Signed in to staging.\n']);
    expect(h.stderr).toStrictEqual([
      'Signing in to staging.\n',
      "Signed in, but couldn't load the account details: Kizen is unavailable\n",
    ]);
    expect(h.exitCodes).toStrictEqual([]);
    expect(await store.readSession('staging')).toMatchObject({ accessToken: ROTATED_ACCESS });
  });

  it('login progress lines from the production deps go to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      createDefaultAuthCommandDeps(store).loginDeps.print('Opening your browser');
      expect(write).toHaveBeenCalledWith('Opening your browser\n');
    } finally {
      write.mockRestore();
    }
  });

  it('rejects an unknown --env before contacting anything', async () => {
    const h = harness(() => jsonResponse(BOOTSTRAP));

    await runLogin({ env: 'nope' }, h.deps);

    expect(h.exitCodes).toStrictEqual([1]);
    expect(h.stderr.join('')).toContain('Unknown --env "nope"');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('auth-header', () => {
  const STAGING_MCP = 'https://staging.kizen.com/api/mcp';
  const noKizen = (): Response => jsonResponse({ detail: 'auth-header never calls Kizen' }, 500);
  const header = (token: string): string =>
    `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`;

  /** Two signed-in environments, with different tokens, so env resolution is observable. */
  const twoSessions = async (): Promise<void> => {
    await store.writeSession(session('staging'));
    await store.writeSession(
      session('integration', {
        accessToken: 'integration-access',
        refreshToken: 'integration-refresh',
      }),
    );
  };

  it('auth-header prints exactly one JSON line with the bearer token and nothing else on stdout', async () => {
    await store.writeSession(session('staging'));

    const h = harness(noKizen);

    await runAuthHeader({}, h.deps);

    expect(h.stdout).toHaveLength(1);
    expect(h.stdout[0]?.endsWith('\n')).toBe(true);
    expect(h.stdout[0]?.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(h.stdout[0] ?? '')).toStrictEqual({ Authorization: `Bearer ${ACCESS}` });
    expect(h.stderr).toStrictEqual([]);
    expect(h.exitCodes).toStrictEqual([]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('auth-header writes nothing to stdout and exits non-zero when not signed in', async () => {
    const none = harness(noKizen);

    await runAuthHeader({}, none.deps);

    // Signed in elsewhere, but not to the requested environment.
    await store.writeSession(session('staging'));

    const other = harness(noKizen);

    await runAuthHeader({ env: 'integration' }, other.deps);

    expectHeaderFailure(none, 'appbuilder login --env go');
    expectHeaderFailure(other, 'appbuilder login --env integration');

    for (const h of [none, other]) {
      expect(h.stderr[0]?.trimEnd().includes('\n')).toBe(false);
    }
  });

  it('auth-header resolves env from CLAUDE_CODE_MCP_SERVER_URL', async () => {
    await twoSessions();

    const staging = harness(noKizen, {
      processEnv: { CLAUDE_CODE_MCP_SERVER_URL: STAGING_MCP },
    });
    const integration = harness(noKizen, {
      processEnv: { CLAUDE_CODE_MCP_SERVER_URL: 'https://integration.kizen.dev/api/mcp' },
    });

    await runAuthHeader({}, staging.deps);
    await runAuthHeader({}, integration.deps);

    expect(staging.stdout).toStrictEqual([header(ACCESS)]);
    expect(integration.stdout).toStrictEqual([header('integration-access')]);

    // Without the variable, two sessions are ambiguous.
    const unset = harness(noKizen);

    await runAuthHeader({}, unset.deps);
    expectHeaderFailure(unset, 'pass --env <env>');
  });

  it('auth-header errors on a server URL matching no environment', async () => {
    // Only one session, so falling through to "the only signed-in one" would succeed.
    await store.writeSession(session('staging'));

    const h = harness(noKizen, {
      processEnv: { CLAUDE_CODE_MCP_SERVER_URL: 'https://mcp.example.com/api/mcp?x=1' },
    });

    await runAuthHeader({}, h.deps);

    expectHeaderFailure(h);
    expect(h.stderr).toStrictEqual([
      "appbuilder auth-header: No Kizen environment matches the MCP server https://mcp.example.com, so auth-header won't send it a token.\n",
    ]);
    expect(h.providerOptions).toStrictEqual([]);
  });

  it('--env disagreeing with CLAUDE_CODE_MCP_SERVER_URL is an error and prints no token', async () => {
    await twoSessions();

    const cases: [string, string, string][] = [
      // A different Kizen environment.
      [
        'integration',
        STAGING_MCP,
        "--env integration doesn't match the MCP server https://staging.kizen.com (staging)",
      ],
      // Not a Kizen server at all.
      ['staging', 'https://mcp.example.com/mcp', 'No Kizen environment matches the MCP server'],
      // Same host, different port: a different origin.
      ['staging', 'https://staging.kizen.com:8443/api/mcp', 'https://staging.kizen.com:8443'],
      // Not a URL.
      ['staging', 'not a url', 'CLAUDE_CODE_MCP_SERVER_URL is not a valid URL'],
    ];

    for (const [env, url, message] of cases) {
      const h = harness(noKizen, { processEnv: { CLAUDE_CODE_MCP_SERVER_URL: url } });

      await runAuthHeader({ env }, h.deps);

      expectHeaderFailure(h, message);
      expect(h.providerOptions).toStrictEqual([]);
    }

    const unknown = harness(noKizen, { processEnv: { CLAUDE_CODE_MCP_SERVER_URL: STAGING_MCP } });

    await runAuthHeader({ env: 'prod' }, unknown.deps);
    expectHeaderFailure(unknown, 'Unknown --env "prod"');
  });

  it('--env agreeing with CLAUDE_CODE_MCP_SERVER_URL prints the token', async () => {
    await twoSessions();

    const h = harness(noKizen, {
      processEnv: { CLAUDE_CODE_MCP_SERVER_URL: 'https://integration.kizen.dev/api/mcp' },
    });

    await runAuthHeader({ env: 'integration' }, h.deps);

    expect(h.stdout).toStrictEqual([header('integration-access')]);
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('--env without CLAUDE_CODE_MCP_SERVER_URL prints the token', async () => {
    // Two sessions: without --env this would be ambiguous.
    await twoSessions();

    const h = harness(noKizen, { processEnv: { CLAUDE_CODE_MCP_SERVER_URL: '' } });

    await runAuthHeader({ env: 'integration' }, h.deps);

    expect(h.stdout).toStrictEqual([header('integration-access')]);
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('the production deps forward auth-header timeouts to the token request', async () => {
    // Real createDefaultAuthCommandDeps wiring on a temp store; only the global
    // fetch is replaced, with a token endpoint that never answers. These deps use
    // the real clock, so the session expires 30s from now (inside the refresh leeway).
    await store.writeSession(session('staging', { expiresAt: Date.now() + 30_000 }));

    const hang = vi.fn<typeof fetch>((_input, init) => hangUntilAbort(init));

    vi.stubGlobal('fetch', hang);

    try {
      const deps = createDefaultAuthCommandDeps(store);
      const started = Date.now();
      const error = await rejectionOf(
        deps.tokenProvider('staging', { requestTimeoutMs: 150 }).getAccessToken(),
      );
      const elapsed = Date.now() - started;

      expect(error).toMatchObject({ code: 'network_error' });
      expect(hang).toHaveBeenCalledTimes(1);
      expect(hang.mock.calls[0]?.[0]).toBe('https://staging.kizen.com/oauth2/token');
      // About the configured 150ms: not immediate, and nowhere near the 20s default.
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(2_000);

      // And runAuthHeader on the production deps passes its own timeouts through.
      const out = { stdout: [] as string[], stderr: [] as string[], exitCodes: [] as number[] };
      const headerStarted = Date.now();

      await runAuthHeader(
        {},
        {
          ...deps,
          authHeaderTimeouts: { requestTimeoutMs: 150 },
          processEnv: { CLAUDE_CODE_MCP_SERVER_URL: STAGING_MCP },
          writeStdout: (text) => out.stdout.push(text),
          writeStderr: (text) => out.stderr.push(text),
          setExitCode: (code) => out.exitCodes.push(code),
        },
      );

      expect(Date.now() - headerStarted).toBeLessThan(2_000);
      expectHeaderFailure(out, 'timed out');
      expect(await store.readSession('staging')).toMatchObject({ refreshToken: REFRESH });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('auth-header refreshes an expiring token and prints the new one', async () => {
    await store.writeSession(session('staging', { expiresAt: NOW + 30_000 }));

    const h = harness(noKizen);

    await runAuthHeader({ env: 'staging' }, h.deps);

    expect(h.stdout).toStrictEqual([header(ROTATED_ACCESS)]);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(await store.readSession('staging')).toMatchObject({
      accessToken: ROTATED_ACCESS,
      refreshToken: ROTATED_REFRESH,
      expiresAt: NOW + 3600 * 1000,
    });
  });

  it("auth-header uses timeouts under Claude Code's 10s helper limit", async () => {
    // The production wiring carries the short request timeout, and one full request fits inside
    // the helper limit with room for start-up.
    expect(createDefaultAuthCommandDeps(store).authHeaderTimeouts).toStrictEqual({
      requestTimeoutMs: AUTH_HEADER_REQUEST_TIMEOUT_MS,
    });
    expect(AUTH_HEADER_REQUEST_TIMEOUT_MS).toBeLessThan(CLAUDE_CODE_HELPER_LIMIT_MS - 1_000);

    // That value is what reaches the token provider.
    await store.writeSession(session('staging'));

    const wired = harness(noKizen);

    await runAuthHeader({}, wired.deps);
    expect(wired.providerOptions).toStrictEqual([
      { requestTimeoutMs: AUTH_HEADER_REQUEST_TIMEOUT_MS },
    ]);
  });

  it('a peer-rotated retry stays within one request timeout', async () => {
    const TIMEOUT_MS = 400;
    const FIRST_ANSWER_MS = 300;

    await store.writeSession(session('staging', { expiresAt: NOW + 30_000 }));

    const h = harness(noKizen, {
      timeouts: { requestTimeoutMs: TIMEOUT_MS },
      tokenEndpoint: async (init) => {
        if (new URLSearchParams(init?.body as string).get('refresh_token') === REFRESH) {
          // Late, a peer rotates to tokens that aren't fresh, and this request is refused.
          await new Promise((resolve) => setTimeout(resolve, FIRST_ANSWER_MS));
          await store.writeSession(
            session('staging', {
              accessToken: ROTATED_ACCESS,
              refreshToken: ROTATED_REFRESH,
              expiresAt: NOW + 30_000,
            }),
          );

          return jsonResponse({ error: 'invalid_grant' }, 400);
        }

        // The retry with the peer's refresh token never answers.
        return hangUntilAbort(init);
      },
    });
    const started = Date.now();

    await runAuthHeader({ env: 'staging' }, h.deps);

    // One timeout in total, not one per request (that would be FIRST_ANSWER_MS + TIMEOUT_MS).
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 150);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expectHeaderFailure(h, 'timed out');
    expect(await store.readSession('staging')).toMatchObject({ refreshToken: ROTATED_REFRESH });
  });

  it('auth-header prints nothing on stdout when the session is unreadable', async () => {
    await mkdir(store.dir, { recursive: true });
    await writeFile(store.sessionPath('staging'), `{"accessToken": "${ACCESS}", "trunc`);

    // Selected by the MCP server URL, by --env, and as the only session file.
    const runs: [{ env?: string }, Record<string, string>][] = [
      [{}, { CLAUDE_CODE_MCP_SERVER_URL: STAGING_MCP }],
      [{ env: 'staging' }, {}],
      [{}, {}],
    ];

    for (const [options, processEnv] of runs) {
      const h = harness(noKizen, { processEnv });

      await runAuthHeader(options, h.deps);

      expectHeaderFailure(h);
      expect(h.stderr).toStrictEqual([
        `appbuilder auth-header: The saved staging session at ${store.sessionPath('staging')} can't be read. Run \`appbuilder login --env staging\` to sign in again.\n`,
      ]);
      expect(h.fetchMock).not.toHaveBeenCalled();
    }
  });

  it('auth-header never writes tokens to stderr', async () => {
    // invalid_grant on refresh (the session, with its refresh token, is deleted).
    await store.writeSession(session('staging', { expiresAt: NOW + 30_000 }));

    const revoked = harness(noKizen, {
      tokenEndpoint: () =>
        jsonResponse({ error: 'invalid_grant', error_description: 'Revoked' }, 400),
    });

    await runAuthHeader({}, revoked.deps);
    expect(revoked.stderr[0]).toContain('appbuilder login --env staging');

    // The token endpoint is unreachable.
    await store.writeSession(session('staging', { expiresAt: NOW + 30_000 }));

    const unreachable = harness(noKizen, {
      tokenEndpoint: () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      },
    });

    await runAuthHeader({}, unreachable.deps);
    expect(unreachable.stderr[0]).toContain('ECONNREFUSED');

    // A mismatched server URL with a valid session on disk.
    const mismatched = harness(noKizen, {
      processEnv: { CLAUDE_CODE_MCP_SERVER_URL: 'https://other.test/mcp' },
    });

    await runAuthHeader({}, mismatched.deps);

    for (const h of [revoked, unreachable, mismatched]) {
      expectHeaderFailure(h);
    }
  });
});
