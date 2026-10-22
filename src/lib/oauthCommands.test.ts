import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from './credentials.js';
import { createKizenClient, type KizenIdentity } from './kizenClient.js';
import {
  accountPickerItems,
  AUTH_HEADER_REQUEST_TIMEOUT_MS,
  BROWSER_PICK,
  createDefaultAuthCommandDeps,
  matchBusiness,
  pickedAccount,
  runAuthHeader,
  runLogin,
  runLogout,
  runWhoami,
  type AuthCommandDeps,
  type PickAccount,
} from './oauthCommands.js';
import { createTokenProvider, type LoginDeps, type TokenProviderOptions } from './oauthSession.js';
import {
  accountKey,
  createOAuthStore,
  type OAuthAccount,
  type OAuthSession,
  type OAuthStore,
  type SavedAccount,
} from './oauthStore.js';
import { quoteArg } from './shellArg.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ISSUER,
  jsonResponse,
  NOW,
  oauthSession,
  signIn,
} from '../test/oauth.js';

const ACCESS = 'secret-access-7f3a';
const REFRESH = 'secret-refresh-91bc';
const ROTATED_ACCESS = 'secret-access-rotated-22d0';
const ROTATED_REFRESH = 'secret-refresh-rotated-5e1f';

const { businessId: BIZ_A, userId: USER_A } = ACCOUNT_A;
const { businessId: BIZ_B, userId: USER_B } = ACCOUNT_B;
const BIZ_A2 = 'abababab-abab-4bab-8bab-abababababab';
const USER_A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const BIZ_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const BIZ_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER_D = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const BIZ_Z = '00000000-0000-4000-8000-000000000000';
const USER_Z = '01010101-0101-4010-8010-010101010101';
const BIZ_9 = '99999999-9999-4999-8999-999999999999';
const USER_9 = '91919191-9191-4919-8919-919191919191';
const NOBODY = '02020202-0202-4020-8020-020202020202';

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
    tokenEndpoint: 'https://staging.kizen.com/oauth2/token',
    accessToken: ACCESS,
    refreshToken: REFRESH,
    ...overrides,
  });

/** An `/auth/bootstrap` body for `identity`. */
const bootstrapFor = (identity: KizenIdentity): Record<string, unknown> => ({
  team: { id: 't1', user: identity.userId, full_name: identity.fullName, email: identity.email },
  business: { id: identity.businessId, name: identity.businessName },
});

const IDENTITY_9: KizenIdentity = {
  userId: USER_9,
  businessId: BIZ_9,
  businessName: 'Acme Corp',
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
};

const BOOTSTRAP = bootstrapFor(IDENTITY_9);

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
  /** What `isInteractive` answers; false by default, as for a script. */
  interactive?: boolean;
  pickAccount?: PickAccount;
  timeouts?: AuthCommandDeps['authHeaderTimeouts'];
  /** The token provider's clock; `NOW` by default. */
  now?: () => number;
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
  const now = options.now ?? ((): number => NOW);
  const tokenProvider: AuthCommandDeps['tokenProvider'] = (environment, providerOpts = {}) => {
    providerOptions.push(providerOpts);

    return createTokenProvider(environment, { store, fetch: fetchMock, now, ...providerOpts });
  };

  const deps: AuthCommandDeps = {
    store,
    loginDeps: {} as LoginDeps,
    identify: (bearer) => createKizenClient({ bearer, fetch: fetchMock }).getIdentity(),
    tokenProvider,
    isInteractive: () => options.interactive ?? false,
    ...(options.pickAccount !== undefined && { pickAccount: options.pickAccount }),
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

/** The words a real `/bin/sh` makes of `command`, one per line (none of the values hold one). */
const shellWords = (command: string): string[] =>
  execFileSync('/bin/sh', ['-c', `set -- ${command}; for w; do printf '%s\\n' "$w"; done`], {
    encoding: 'utf-8',
  })
    .split('\n')
    .slice(0, -1);

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
    await signIn(store, session('staging'));

    const fresh = harness((url, auth) =>
      url.endsWith('/auth/bootstrap') && auth === `Bearer ${ACCESS}`
        ? jsonResponse(BOOTSTRAP)
        : jsonResponse({ detail: 'unexpected' }, 400),
    );

    await runWhoami({ env: 'staging' }, fresh.deps);

    expect(fresh.stdout.join('')).toBe(
      `Environment: staging\nUser: Ada Lovelace <ada@example.com> (${USER_9})\nBusiness: Acme Corp (${BIZ_9})\n`,
    );
    expect(fresh.exitCodes).toStrictEqual([]);
    expectNoSecrets(fresh.all());

    // Fixture 2: expiring token, refreshed (rotated) first.
    await signIn(store, session('staging', { expiresAt: NOW + 10_000 }));

    const refreshed = harness((url, auth) =>
      auth === `Bearer ${ROTATED_ACCESS}`
        ? jsonResponse(BOOTSTRAP)
        : jsonResponse({ detail: 'old token' }, 401),
    );

    await runWhoami({}, refreshed.deps);

    expect(refreshed.stdout.join('')).toContain(`Business: Acme Corp (${BIZ_9})`);
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
    expect(h.stderr.join('')).toContain('Run `appbuilder login` (add `--env <env>`');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('asks for --env when several sessions exist, and rejects an unknown one', async () => {
    await signIn(store, session('staging'));
    await signIn(store, session('integration'));

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
    await signIn(store, session('staging'));
    await signIn(store, session('integration'));

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

describe('logout and an unreadable session', () => {
  it('logout removes a corrupt session file and the pointer to it', async () => {
    const h = harness(() => jsonResponse(BOOTSTRAP));

    await signIn(store, session('staging'));
    await writeFile(
      store.accountPath('staging', ACCOUNT_A),
      '{"accessToken": "secret-in-file", "tr',
    );
    await runLogout({}, h.deps);

    expect(await readdir(store.dir)).toStrictEqual([]);
    expect(h.stdout.at(-1)).toBe(
      'Signed out of staging. The session was removed from this machine.\n',
    );
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

describe('logout and saved accounts', () => {
  it('logout removes only the current account', async () => {
    await store.writeSession(session('staging', { ...ACCOUNT_B }));
    await signIn(store, session('staging'));

    const h = harness(() => jsonResponse(BOOTSTRAP));

    await runLogout({ env: 'staging' }, h.deps);

    expect(h.stdout).toStrictEqual([
      'Signed out of staging. The session was removed from this machine.\n',
    ]);
    expect(await store.readSession('staging')).toBeNull();
    expect((await store.listAccounts('staging')).map((entry) => entry.account)).toStrictEqual([
      ACCOUNT_B,
    ]);
    // A saved account that isn't current isn't "signed in" for a bare logout.
    await runLogout({}, h.deps);
    expect(h.stdout.at(-1)).toBe('Not signed in.\n');
    expect(await store.listAccounts('staging')).toHaveLength(1);
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('logout --business removes only that saved account, and signs out when it is current', async () => {
    await store.writeSession(session('staging', { ...ACCOUNT_B, businessName: 'Bravo B' }));
    await signIn(store, session('staging'));

    const h = harness(() => jsonResponse(BOOTSTRAP));

    // Not current, matched by name ignoring case: the current account stays.
    await runLogout({ env: 'staging', business: 'BRAVO b' }, h.deps);
    expect(h.stdout.at(-1)).toBe(
      `Removed the saved staging account Bravo B (${BIZ_B}) ada@a.test from this machine.\n`,
    );
    expect(await store.readAccount('staging', ACCOUNT_B)).toBeNull();
    expect(await store.readSession('staging')).toMatchObject(ACCOUNT_A);

    // Unknown: a usage error listing what's saved, nothing removed.
    await runLogout({ env: 'staging', business: 'nope' }, h.deps);
    expect(h.stderr.at(-1)).toBe(
      `Error: No saved staging account matches --business nope. Saved accounts:\n  Acme A (${BIZ_A}) ada@a.test\n`,
    );
    expect(await store.readSession('staging')).toMatchObject(ACCOUNT_A);

    // Current, matched by id: the pointer goes too.
    await runLogout({ business: BIZ_A }, h.deps);
    expect(h.stdout.at(-1)).toBe(
      `Removed the saved staging account Acme A (${BIZ_A}) ada@a.test from this machine. You're no longer signed in to staging.\n`,
    );
    expect(await readdir(store.dir)).toStrictEqual([]);

    // Nothing saved, then nothing signed in to name an environment.
    await runLogout({ env: 'staging', business: BIZ_A }, h.deps);
    expect(h.stdout.at(-1)).toBe('No saved accounts for staging.\n');
    await runLogout({ business: BIZ_A }, h.deps);
    await runLogout({ env: 'staging', business: BIZ_A, all: true }, h.deps);
    expect(h.stderr.slice(-2)).toStrictEqual([
      'Error: Pass --env <env> with --business to remove a saved account.\n',
      "Error: --all can't be combined with --business.\n",
    ]);
    expect(h.exitCodes).toStrictEqual([1, 1, 1]);
  });

  it('logout --all removes every saved account', async () => {
    const h = harness(() => jsonResponse(BOOTSTRAP));

    // Saved but current nowhere: --all needs --env to find it.
    await store.writeSession(session('staging', { ...ACCOUNT_B }));
    await runLogout({ all: true }, h.deps);
    expect(h.stderr).toStrictEqual([
      'Error: Pass --env <env> with --all to remove every saved account.\n',
    ]);

    await signIn(store, session('staging'));
    await signIn(store, session('integration'));
    await runLogout({ env: 'staging', all: true }, h.deps);

    expect(h.stdout).toStrictEqual([
      'Signed out of staging. Removed 2 saved accounts from this machine.\n',
    ]);
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.listAccounts('staging')).toStrictEqual([]);
    // Another environment is untouched.
    expect(await store.readSession('integration')).not.toBeNull();

    await runLogout({ env: 'staging', all: true }, h.deps);
    expect(h.stdout.at(-1)).toBe('No saved accounts for staging.\n');

    // Saved but not current: still removed by --all.
    await store.writeSession(session('staging'));
    await runLogout({ env: 'staging', all: true }, h.deps);
    expect(h.stdout.at(-1)).toBe(
      'Signed out of staging. Removed 1 saved account from this machine.\n',
    );
    expect(await readdir(store.dir)).not.toContain(`staging.${accountKey(ACCOUNT_A)}.json`);
    expect(h.exitCodes).toStrictEqual([1]);
  });
});

describe('login', () => {
  const browserCalls: string[] = [];

  beforeEach(() => {
    browserCalls.length = 0;
  });

  /**
   * A server and browser that approve at once, so the real `login` signs in to staging as
   * `identity`. Opening the browser is recorded in `browserCalls`, never real.
   */
  const approvingLoginDeps = (identity: KizenIdentity | Error = IDENTITY_9): LoginDeps => ({
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
    openBrowser: (url) => {
      browserCalls.push(url);
    },
    startLoopbackServer: () =>
      Promise.resolve({
        host: '127.0.0.1',
        port: 1,
        redirectUri: 'http://127.0.0.1:1/callback',
        result: Promise.resolve({ code: 'auth-code' }),
        close: () => Promise.resolve(),
      }),
    identify: async (bearer) => {
      expect(await bearer.getAccessToken()).toBe(ROTATED_ACCESS);

      if (identity instanceof Error) {
        throw identity;
      }

      return identity;
    },
  });

  /** login's line before the URL without a TTY. */
  const AGENT_URL_LINE =
    "A browser window should open for the user to sign in to Kizen staging. If it doesn't, give them this URL:\n";

  const IDENTITY_LINES_9 = `Environment: staging\nUser: Ada Lovelace <ada@example.com> (${USER_9})\nBusiness: Acme Corp (${BIZ_9})\n`;

  /** Account A (Acme A, saved, expiring) and account B (Bravo B, current). */
  const SAVED_A = session('staging', { expiresAt: NOW + 30_000 });
  const CURRENT_B = session('staging', {
    ...ACCOUNT_B,
    businessName: 'Bravo B',
    fullName: 'Bob B',
    email: 'bob@b.test',
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
  });
  const IDENTITY_A: KizenIdentity = {
    ...ACCOUNT_A,
    businessName: 'Acme A',
    fullName: 'Ada A',
    email: 'ada@a.test',
  };

  const saveAAndB = async (): Promise<void> => {
    await store.writeSession(SAVED_A);
    await signIn(store, CURRENT_B);
  };

  /** A Kizen API whose bootstrap answers account A for its rotated token only. */
  const kizenForA = (url: string, auth: string | undefined): Response =>
    url.endsWith('/auth/bootstrap') && auth === `Bearer ${ROTATED_ACCESS}`
      ? jsonResponse(bootstrapFor(IDENTITY_A))
      : jsonResponse({ detail: 'Invalid token.' }, 401);

  /** A login harness: the real store and provider, `approvingLoginDeps` for the browser. */
  const loginHarness = (
    kizen: Parameters<typeof harness>[0] = () => jsonResponse({ detail: 'unused' }, 500),
    options: HarnessOptions & {
      identity?: KizenIdentity | Error;
      /** Send login's own progress lines (the authorize URL) to stderr, as production does. */
      printToStderr?: boolean;
    } = {},
  ): Harness => {
    const h = harness(kizen, options);

    h.deps.loginDeps = {
      ...approvingLoginDeps(options.identity),
      ...(options.printToStderr === true && {
        print: (line: string) => {
          h.deps.writeStderr(`${line}\n`);
        },
      }),
    };

    return h;
  };

  it('login prints Signed in and the account identity', async () => {
    const h = loginHarness();

    await runLogin({ env: 'staging' }, h.deps);

    expect(h.stdout).toStrictEqual(['Signed in to staging.\n', IDENTITY_LINES_9]);
    expect(h.stderr).toStrictEqual(['Signing in to staging.\n']);
    expect(h.exitCodes).toStrictEqual([]);
    expect(browserCalls).toHaveLength(1);
    expect(await store.readSession('staging')).toMatchObject({
      ...IDENTITY_9,
      accessToken: ROTATED_ACCESS,
    });
    expectNoSecrets(h.all());
  });

  it("login fails and saves nothing when the account details can't be loaded", async () => {
    const h = loginHarness(undefined, { identity: new Error('Kizen is unavailable') });

    await runLogin({ env: 'staging' }, h.deps);

    expect(h.stdout).toStrictEqual([]);
    expect(h.stderr).toStrictEqual(['Signing in to staging.\n', 'Error: Kizen is unavailable\n']);
    expect(h.exitCodes).toStrictEqual([1]);
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.listAccounts('staging')).toStrictEqual([]);
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

  describe('--list', () => {
    it('--list prints one line per saved account with the current one marked', async () => {
      await saveAAndB();

      const h = loginHarness();

      await runLogin({ env: 'staging', list: true }, h.deps);

      expect(h.stdout).toStrictEqual([
        `Acme A (${BIZ_A}) ada@a.test\n`,
        `Bravo B (${BIZ_B}) bob@b.test (current)\n`,
      ]);
      expect(h.stderr).toStrictEqual([]);
      expect(h.exitCodes).toStrictEqual([]);
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(browserCalls).toStrictEqual([]);
      expectNoSecrets(h.all());
      expect(h.all()).not.toContain('access-b');
    });

    it('--list --json prints the accounts as a JSON array, without tokens', async () => {
      await signIn(store, CURRENT_B);
      // And one that can't be read.
      await writeFile(
        store.accountPath('staging', { businessId: BIZ_D, userId: USER_D }),
        '{"trunc',
      );

      const h = loginHarness();

      await runLogin({ env: 'staging', list: true, json: true }, h.deps);

      expect(h.stdout).toHaveLength(1);
      expect(JSON.parse(h.stdout[0] ?? '')).toStrictEqual([
        {
          businessId: BIZ_B,
          userId: USER_B,
          businessName: 'Bravo B',
          fullName: 'Bob B',
          email: 'bob@b.test',
          current: true,
          readable: true,
        },
        {
          businessId: BIZ_D,
          userId: USER_D,
          businessName: null,
          fullName: null,
          email: null,
          current: false,
          readable: false,
        },
      ]);
      expectNoSecrets(h.all());
      expect(h.all()).not.toContain('access-b');
      expect(h.all()).not.toContain('refresh-b');

      // The plain form falls back to the ids.
      await runLogin({ env: 'staging', list: true }, h.deps);
      expect(h.stdout.slice(1)).toStrictEqual([
        `Bravo B (${BIZ_B}) bob@b.test (current)\n`,
        `${BIZ_D} user ${USER_D} (can't be read)\n`,
      ]);
    });

    it('--list with no saved accounts prints one line, and --json an empty array', async () => {
      const h = loginHarness();

      await runLogin({ env: 'staging', list: true }, h.deps);
      await runLogin({ env: 'staging', list: true, json: true }, h.deps);

      expect(h.stdout).toStrictEqual(['No saved accounts for staging.\n', '[]\n']);
      expect(h.exitCodes).toStrictEqual([]);
      expect(browserCalls).toStrictEqual([]);
    });

    it('--json without --list, and --list with --business, are usage errors', async () => {
      const h = loginHarness();

      await runLogin({ env: 'staging', json: true }, h.deps);
      await runLogin({ env: 'staging', list: true, business: BIZ_A }, h.deps);

      expect(h.stderr).toStrictEqual([
        'Error: --json only applies with --list.\n',
        "Error: --list can't be combined with --business.\n",
      ]);
      expect(h.exitCodes).toStrictEqual([1, 1]);
      expect(browserCalls).toStrictEqual([]);
    });
  });

  describe('switching to a saved account', () => {
    it('switching to a saved account verifies its token and makes it current', async () => {
      await saveAAndB();

      const h = loginHarness(kizenForA);

      await runLogin({ env: 'staging', business: BIZ_A }, h.deps);

      expect(h.exitCodes).toStrictEqual([]);
      expect(h.stdout).toStrictEqual([
        'Signed in to staging.\n',
        `Environment: staging\nUser: Ada A <ada@a.test> (${USER_A})\nBusiness: Acme A (${BIZ_A})\n`,
      ]);
      expect(h.stderr).toStrictEqual([`Switching to Acme A (${BIZ_A}) ada@a.test on staging.\n`]);
      // The expiring token was refreshed, then proven against /auth/bootstrap, before the switch.
      expect(h.fetchMock.mock.calls.map(([url]) => url as string)).toStrictEqual([
        'https://staging.kizen.com/oauth2/token',
        'https://staging.kizen.com/api/auth/bootstrap',
      ]);
      expect(await store.readSession('staging')).toMatchObject({
        ...ACCOUNT_A,
        accessToken: ROTATED_ACCESS,
        refreshToken: ROTATED_REFRESH,
      });
      // B stays saved, untouched.
      expect(await store.readAccount('staging', ACCOUNT_B)).toStrictEqual(CURRENT_B);
      expect(browserCalls).toStrictEqual([]);
      expectNoSecrets(h.all());
    });

    it('an expired --business account explains what happened, which business to pick, and opens the browser', async () => {
      await saveAAndB();

      // At a terminal (the guidance speaks to the person there).
      const h = loginHarness(kizenForA, {
        tokenEndpoint: () => jsonResponse({ error: 'invalid_grant' }, 400),
        identity: IDENTITY_A,
        printToStderr: true,
        interactive: true,
      });

      await runLogin({ env: 'staging', business: 'Acme A' }, h.deps);

      const stderr = h.stderr.join('');
      const [url] = browserCalls;

      expect(h.exitCodes).toStrictEqual([]);
      expect(browserCalls).toHaveLength(1);
      expect(h.stderr.slice(0, 2)).toStrictEqual([
        `Switching to Acme A (${BIZ_A}) ada@a.test on staging.\n`,
        `The saved sign-in for Acme A (${BIZ_A}) ada@a.test has expired and was removed.\nA browser window is opening to sign in to Kizen staging. On the consent page, choose the business "Acme A" (${BIZ_A}), signed in as ada@a.test.\n`,
      ]);
      // The URL to open by hand comes right after the guidance, said once.
      expect(h.stderr.slice(2, 4)).toStrictEqual([
        'Opening your browser to sign in to Kizen. If it does not open, visit:\n',
        `${url ?? '<none>'}\n`,
      ]);
      expect(stderr).toContain('has expired and was removed');
      expect(stderr).toContain(`choose the business "Acme A" (${BIZ_A})`);
      expect(url).toMatch(/^https:\/\/staging\.kizen\.com\/oauth2\/authorize\?/);
      // The new sign-in is account A again, so it's current.
      expect(h.stdout).toStrictEqual([
        'Signed in to staging.\n',
        `Environment: staging\nUser: Ada A <ada@a.test> (${USER_A})\nBusiness: Acme A (${BIZ_A})\n`,
      ]);
      expect(await store.readSession('staging')).toMatchObject({
        ...ACCOUNT_A,
        accessToken: ROTATED_ACCESS,
      });
      expect(await store.readAccount('staging', ACCOUNT_B)).toStrictEqual(CURRENT_B);
      expectNoSecrets(stderr);
    });

    it('a browser sign-in to a different business than --business is saved but not made current, and exits 1', async () => {
      // After an expired saved account: B stays current. No TTY, so it speaks to the agent.
      await saveAAndB();

      const expired = loginHarness(kizenForA, {
        tokenEndpoint: () => jsonResponse({ error: 'invalid_grant' }, 400),
        printToStderr: true,
      });

      await runLogin({ env: 'staging', business: BIZ_A }, expired.deps);

      expect(expired.exitCodes).toStrictEqual([1]);
      expect(expired.stdout).toStrictEqual([]);
      // The whole stderr: switch, guidance, URL line, URL, and the outcome.
      expect(expired.stderr.slice(0, -1)).toStrictEqual([
        `Switching to Acme A (${BIZ_A}) ada@a.test on staging.\n`,
        `The saved sign-in for Acme A (${BIZ_A}) ada@a.test has expired and was removed.\nWaiting for the user to sign in to Kizen staging in a browser window. Ask them to choose the business "Acme A" (${BIZ_A}), signed in as ada@a.test.\n`,
        AGENT_URL_LINE,
        `${browserCalls[0] ?? '<none>'}\n`,
      ]);
      expect(expired.stderr.at(-1)).toBe(
        `The user signed in as Acme Corp (${BIZ_9}) ada@example.com, not Acme A (${BIZ_A}) ada@a.test. It was saved, but it isn't the current staging account.\nTo use it, run \`appbuilder login --env staging --business ${BIZ_9} --user ${USER_9}\`. To have them try again, run \`appbuilder login --env staging --business ${BIZ_A} --user ${USER_A}\`.\n`,
      );
      expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);
      expect(await store.readAccount('staging', IDENTITY_9)).toMatchObject(IDENTITY_9);
      expect(await store.readAccount('staging', ACCOUNT_A)).toBeNull();
    });

    it('after an expired --business account, another user of that business is saved but not made current, and exits 1', async () => {
      const identity = { ...IDENTITY_A, userId: USER_Z, email: 'zed@a.test' };

      await saveAAndB();

      const h = loginHarness(kizenForA, {
        tokenEndpoint: () => jsonResponse({ error: 'invalid_grant' }, 400),
        identity,
        printToStderr: true,
      });

      await runLogin({ env: 'staging', business: 'Acme A' }, h.deps);

      expect(h.exitCodes).toStrictEqual([1]);
      expect(h.stdout).toStrictEqual([]);
      expect(h.stderr).toStrictEqual([
        `Switching to Acme A (${BIZ_A}) ada@a.test on staging.\n`,
        `The saved sign-in for Acme A (${BIZ_A}) ada@a.test has expired and was removed.\nWaiting for the user to sign in to Kizen staging in a browser window. Ask them to choose the business "Acme A" (${BIZ_A}), signed in as ada@a.test.\n`,
        AGENT_URL_LINE,
        `${browserCalls[0] ?? '<none>'}\n`,
        `The user signed in as Acme A (${BIZ_A}) zed@a.test, not Acme A (${BIZ_A}) ada@a.test. It was saved, but it isn't the current staging account.\nTo use it, run \`appbuilder login --env staging --business ${BIZ_A} --user ${USER_Z}\`. To have them try again, run \`appbuilder login --env staging --business ${BIZ_A} --user ${USER_A}\`.\n`,
      ]);
      expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);
      expect(await store.readAccount('staging', identity)).toMatchObject(identity);
    });

    it('a picked account that expired becomes current again when the user signs back in as it', async () => {
      await saveAAndB();

      const h = loginHarness(kizenForA, {
        tokenEndpoint: () => jsonResponse({ error: 'invalid_grant' }, 400),
        identity: IDENTITY_A,
        interactive: true,
        pickAccount: () => Promise.resolve(accountKey(ACCOUNT_A)),
      });

      await runLogin({ env: 'staging' }, h.deps);

      expect(h.exitCodes).toStrictEqual([]);
      expect(h.stderr.join('')).not.toContain('--business ""');
      expect(h.stdout).toStrictEqual([
        'Signed in to staging.\n',
        `Environment: staging\nUser: Ada A <ada@a.test> (${USER_A})\nBusiness: Acme A (${BIZ_A})\n`,
      ]);
      expect(await store.readSession('staging')).toMatchObject({
        ...ACCOUNT_A,
        accessToken: ROTATED_ACCESS,
      });
      expect(browserCalls).toHaveLength(1);
    });

    it('a browser sign-in as the account that is already current says so, and exits 1', async () => {
      await saveAAndB();

      const identityB: KizenIdentity = {
        ...ACCOUNT_B,
        businessName: 'Bravo B',
        fullName: 'Bob B',
        email: 'bob@b.test',
      };
      const h = loginHarness(kizenForA, {
        tokenEndpoint: () => jsonResponse({ error: 'invalid_grant' }, 400),
        identity: identityB,
        printToStderr: true,
      });

      await runLogin({ env: 'staging', business: BIZ_A }, h.deps);

      expect(h.exitCodes).toStrictEqual([1]);
      expect(h.stderr.slice(0, -1)).toStrictEqual([
        `Switching to Acme A (${BIZ_A}) ada@a.test on staging.\n`,
        `The saved sign-in for Acme A (${BIZ_A}) ada@a.test has expired and was removed.\nWaiting for the user to sign in to Kizen staging in a browser window. Ask them to choose the business "Acme A" (${BIZ_A}), signed in as ada@a.test.\n`,
        AGENT_URL_LINE,
        `${browserCalls[0] ?? '<none>'}\n`,
      ]);
      expect(h.stderr.at(-1)).toBe(
        `The user signed in as Bravo B (${BIZ_B}) bob@b.test, not Acme A (${BIZ_A}) ada@a.test. That's already the current staging account; its saved session was updated.\nTo have them try again, run \`appbuilder login --env staging --business ${BIZ_A} --user ${USER_A}\`.\n`,
      );
      expect(await store.readSession('staging')).toMatchObject({
        ...ACCOUNT_B,
        accessToken: ROTATED_ACCESS,
      });
    });

    it("a transient failure while switching doesn't switch: an unreachable token endpoint", async () => {
      const tokenEndpoint = (): Response => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      };

      await saveAAndB();

      const h = loginHarness(kizenForA, { tokenEndpoint });

      await runLogin({ env: 'staging', business: BIZ_A }, h.deps);

      expect(h.exitCodes).toStrictEqual([1]);
      expect(h.stdout).toStrictEqual([]);
      expect(h.stderr[0]).toBe(`Switching to Acme A (${BIZ_A}) ada@a.test on staging.\n`);
      expect(h.stderr[1]).toMatch(/^Error: /);
      expect(browserCalls).toStrictEqual([]);
      // Still B, and A's saved session as it was.
      expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);
      expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(SAVED_A);
    });

    it("a transient bootstrap failure while switching doesn't switch", async () => {
      await store.writeSession(session('staging'));
      await signIn(store, CURRENT_B);

      const h = loginHarness(() => new Response('bad gateway', { status: 502 }));

      await runLogin({ env: 'staging', business: BIZ_A }, h.deps);

      expect(h.exitCodes).toStrictEqual([1]);
      expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);
      expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(session('staging'));
      expect(browserCalls).toStrictEqual([]);
    });
  });

  describe('--business', () => {
    it('--business with an ambiguous name fails and lists the candidates with their ids', async () => {
      await saveAAndB();
      await store.writeSession(
        session('staging', { businessId: BIZ_A2, userId: USER_A2, email: 'eve@a.test' }),
      );

      const h = loginHarness(kizenForA);

      await runLogin({ env: 'staging', business: 'Acme A' }, h.deps);

      expect(h.exitCodes).toStrictEqual([1]);
      expect(h.stderr).toStrictEqual([
        `Error: --business 'Acme A' matches several saved staging accounts. Pass one of these business ids instead:\n  Acme A (${BIZ_A}) ada@a.test\n  Acme A (${BIZ_A2}) eve@a.test\n`,
      ]);
      expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(browserCalls).toStrictEqual([]);
    });

    it('a no-match --business with other accounts saved runs the guided browser flow', async () => {
      await saveAAndB();

      const h = loginHarness(kizenForA, { printToStderr: true });

      // IDENTITY_9 is Acme Corp (BIZ_9): matchesRequest accepts it by name, ignoring case.
      await runLogin({ env: 'staging', business: 'acme CORP' }, h.deps);

      expect(h.exitCodes).toStrictEqual([]);
      expect(browserCalls).toHaveLength(1);
      expect(h.stderr).toStrictEqual([
        'There\'s no saved staging account for "acme CORP".\nWaiting for the user to sign in to Kizen staging in a browser window. Ask them to choose the business "acme CORP".\n',
        AGENT_URL_LINE,
        `${browserCalls[0] ?? '<none>'}\n`,
      ]);
      expect(h.stdout).toStrictEqual(['Signed in to staging.\n', IDENTITY_LINES_9]);
      expect(await store.readSession('staging')).toMatchObject(IDENTITY_9);
      // The other saved accounts stay saved.
      expect(await store.listAccounts('staging')).toHaveLength(3);
    });

    /** The `try again` command from a mismatch message, split by a real shell. */
    const retryFlags = (
      stderr: string,
    ): {
      words: string[];
      flags: { env?: string; business?: string; user?: string };
    } => {
      const command = /try again, run `(.*)`\.\n?$/s.exec(stderr)?.[1] ?? '';
      const words = shellWords(command);
      const flags: Record<string, string> = {};

      for (let i = 0; i < words.length; i += 1) {
        const flag = /^--(env|business|user)$/.exec(words[i] ?? '')?.[1];

        if (flag !== undefined) {
          flags[flag] = words[i + 1] ?? '';
          i += 1;
        }
      }

      return { words, flags };
    };

    it('the retry command printed after a mismatch works, even for a business name holding shell syntax', async () => {
      // `$`, `$(...)`, a backtick, `!`, `'` and a space.
      const requested: KizenIdentity = {
        businessId: BIZ_Z,
        userId: USER_9,
        businessName: "R$D Corp's `x` deal!",
        fullName: 'Shelly',
        email: 'shelly@r.test',
      };

      await signIn(store, CURRENT_B);

      const first = loginHarness();

      // By name: IDENTITY_9 (Acme Corp, BIZ_9) comes back instead, and is saved, not made current.
      await runLogin({ env: 'staging', business: requested.businessName ?? '' }, first.deps);

      expect(first.exitCodes).toStrictEqual([1]);
      expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);

      const { words, flags } = retryFlags(first.stderr.at(-1) ?? '');

      // The name survives shell parsing exactly.
      expect(words.slice(0, 2)).toStrictEqual(['appbuilder', 'login']);
      expect(flags).toStrictEqual({ env: 'staging', business: requested.businessName });

      // Run the printed retry, the browser returning the requested account this time.
      browserCalls.length = 0;

      const retry = loginHarness(kizenForA, { identity: requested });

      await runLogin(flags, retry.deps);

      expect(retry.exitCodes).toStrictEqual([]);
      expect(browserCalls).toHaveLength(1);
      expect(await store.readSession('staging')).toMatchObject(requested);
      // The mismatched sign-in is still saved, and not current.
      expect(await store.readAccount('staging', IDENTITY_9)).toMatchObject(IDENTITY_9);
    });

    it('quoteArg round-trips any value through /bin/sh as one word', () => {
      for (const value of [
        '$(touch x)',
        '`touch x`',
        "it's",
        'a b',
        '*',
        '',
        '$HOME',
        '-x',
        '=x',
        'a\\b "c"',
        "R$D Corp's `x` deal!",
      ]) {
        expect(shellWords(`printf %s ${quoteArg(value)}`)).toStrictEqual(['printf', '%s', value]);
      }
    });

    it('the guidance speaks to the person at a TTY, and to the agent otherwise', async () => {
      for (const interactive of [true, false]) {
        await rm(store.dir, { recursive: true, force: true });

        browserCalls.length = 0;

        const h = loginHarness(undefined, { interactive, printToStderr: true });

        await runLogin({ env: 'staging', business: BIZ_9, user: USER_9 }, h.deps);

        const url = `${browserCalls[0] ?? '<none>'}\n`;

        // The whole stderr, URL line included.
        expect(h.stderr).toStrictEqual(
          interactive
            ? [
                `There's no saved staging account for "${BIZ_9}" with user "${USER_9}".\nA browser window is opening to sign in to Kizen staging. On the consent page, choose the business "${BIZ_9}", signed in as ${USER_9}.\n`,
                'Opening your browser to sign in to Kizen. If it does not open, visit:\n',
                url,
              ]
            : [
                `There's no saved staging account for "${BIZ_9}" with user "${USER_9}".\nWaiting for the user to sign in to Kizen staging in a browser window. Ask them to choose the business "${BIZ_9}", signed in as ${USER_9}.\n`,
                AGENT_URL_LINE,
                url,
              ],
        );

        // Either way, the URL is introduced once.
        expect(h.stderr.join('').match(/URL|visit:/g)).toHaveLength(1);

        if (!interactive) {
          // Never an instruction for the reader to work the browser.
          const all = h.stderr.join('');

          expect(all).not.toMatch(/(^|\. |\n)(open|choose|visit)\b/i);
          expect(all).not.toMatch(/\bvisit\b|open the URL/i);
          expect(all).not.toContain('A browser window is opening');
          expect(all.match(/URL/g)).toHaveLength(1);
        }

        expect(h.exitCodes).toStrictEqual([]);
      }
    });

    it.each([
      ['by name, ignoring case', { business: 'ACME corp' }],
      ['by business id and user id', { business: BIZ_9, user: USER_9 }],
    ])('a browser sign-in matching --business becomes current: %s', async (_name, request) => {
      const h = loginHarness();

      await runLogin({ env: 'staging', ...request }, h.deps);

      expect(h.exitCodes).toStrictEqual([]);
      expect(h.stdout).toStrictEqual(['Signed in to staging.\n', IDENTITY_LINES_9]);
      expect(await store.readSession('staging')).toMatchObject(IDENTITY_9);
    });

    describe('two users of one business', () => {
      const A2 = session('staging', {
        userId: USER_A2,
        fullName: 'Eve A',
        email: 'eve@a.test',
        accessToken: 'access-a2',
        refreshToken: 'refresh-a2',
      });
      const IDENTITY_A2: KizenIdentity = {
        businessId: BIZ_A,
        userId: USER_A2,
        businessName: 'Acme A',
        fullName: 'Eve A',
        email: 'eve@a.test',
      };
      const kizenForA2 = (url: string, auth: string | undefined): Response =>
        url.endsWith('/auth/bootstrap') && auth === 'Bearer access-a2'
          ? jsonResponse(bootstrapFor(IDENTITY_A2))
          : jsonResponse({ detail: 'Invalid token.' }, 401);

      const saveTwoUsers = async (): Promise<void> => {
        await store.writeSession(session('staging'));
        await store.writeSession(A2);
        await signIn(store, CURRENT_B);
      };

      it('--business with --user picks one of two users in the same business (login)', async () => {
        await saveTwoUsers();

        const h = loginHarness(kizenForA2);

        await runLogin({ env: 'staging', business: BIZ_A, user: USER_A2 }, h.deps);

        expect(h.exitCodes).toStrictEqual([]);
        expect(h.stderr).toStrictEqual([`Switching to Acme A (${BIZ_A}) eve@a.test on staging.\n`]);
        expect(await store.readSession('staging')).toStrictEqual(A2);
        expect(browserCalls).toStrictEqual([]);
      });

      it('--business with --user picks one of two users in the same business (logout)', async () => {
        await saveTwoUsers();

        const h = loginHarness();

        await runLogout({ env: 'staging', business: 'Acme A', user: USER_A2 }, h.deps);

        expect(h.stdout).toStrictEqual([
          `Removed the saved staging account Acme A (${BIZ_A}) eve@a.test from this machine.\n`,
        ]);
        expect(
          await store.readAccount('staging', { businessId: BIZ_A, userId: USER_A2 }),
        ).toBeNull();
        expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(session('staging'));
        expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);
      });

      it('two users in one business without --user fails and suggests --user', async () => {
        await saveTwoUsers();

        const h = loginHarness(kizenForA2);
        const expected = `Error: --business ${BIZ_A} matches several saved staging users of the same business. Pass --user too, for example \`--business ${BIZ_A} --user ${USER_A}\`:\n  --user ${USER_A}: Acme A (${BIZ_A}) ada@a.test\n  --user ${USER_A2}: Acme A (${BIZ_A}) eve@a.test\n`;

        await runLogin({ env: 'staging', business: BIZ_A }, h.deps);
        await runLogout({ env: 'staging', business: BIZ_A }, h.deps);

        expect(h.stderr).toStrictEqual([expected, expected]);
        expect(h.exitCodes).toStrictEqual([1, 1]);
        expect(await store.listAccounts('staging')).toHaveLength(3);
        expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);
        expect(browserCalls).toStrictEqual([]);
      });

      it('--user without --business is a usage error', async () => {
        await saveTwoUsers();

        const h = loginHarness();

        await runLogin({ env: 'staging', user: USER_A2 }, h.deps);
        await runLogout({ env: 'staging', user: USER_A2 }, h.deps);

        expect(h.stderr).toStrictEqual([
          'Error: --user only applies with --business.\n',
          'Error: --user only applies with --business.\n',
        ]);
        expect(h.exitCodes).toStrictEqual([1, 1]);
        expect(await store.listAccounts('staging')).toHaveLength(3);
        expect(browserCalls).toStrictEqual([]);
      });

      it('--user that matches none of the business users runs the guided browser flow', async () => {
        await saveTwoUsers();

        const nobody: KizenIdentity = { ...IDENTITY_A2, userId: NOBODY, email: 'no@a.test' };
        const h = loginHarness(undefined, { identity: nobody });

        await runLogin({ env: 'staging', business: BIZ_A, user: NOBODY }, h.deps);

        expect(h.stderr[0]).toBe(
          `There's no saved staging account for "${BIZ_A}" with user "${NOBODY}".\nWaiting for the user to sign in to Kizen staging in a browser window. Ask them to choose the business "${BIZ_A}", signed in as ${NOBODY}.\n`,
        );
        expect(h.exitCodes).toStrictEqual([]);
        expect(browserCalls).toHaveLength(1);
        expect(await store.readSession('staging')).toMatchObject(nobody);
        expect(await store.listAccounts('staging')).toHaveLength(4);
      });
    });

    it('matchBusiness prefers an id match over a name match', () => {
      const entry = (businessId: string, businessName: string): SavedAccount => ({
        account: { businessId, userId: 'u' },
        session: oauthSession({ businessId, userId: 'u', businessName }),
        current: false,
      });
      // A business named like another's id.
      const accounts = [entry('biz-1', 'biz-2'), entry('biz-2', 'Two')];

      expect(matchBusiness(accounts, 'biz-2')).toStrictEqual({
        kind: 'one',
        account: accounts[1],
      });
      expect(matchBusiness(accounts, 'BIZ-2')).toStrictEqual({
        kind: 'one',
        account: accounts[0],
      });
      expect(matchBusiness([], 'x')).toStrictEqual({ kind: 'none', candidates: [] });
    });
  });

  describe('the picker', () => {
    const recordingPicker = (
      answer: (keys: string[]) => string | undefined,
    ): PickAccount & { calls: { title: string; labels: string[] }[] } => {
      const calls: { title: string; labels: string[] }[] = [];
      const pick: PickAccount = (title, items) => {
        calls.push({ title, labels: items.map((item) => item.label) });

        return Promise.resolve(answer(items.map((item) => item.key)));
      };

      return Object.assign(pick, { calls });
    };

    it('no TTY skips the picker and uses the browser flow', async () => {
      await saveAAndB();

      const picker = recordingPicker(() => accountKey(ACCOUNT_A));
      const h = loginHarness(kizenForA, { interactive: false, pickAccount: picker });

      await runLogin({ env: 'staging' }, h.deps);

      expect(picker.calls).toStrictEqual([]);
      expect(h.stderr).toStrictEqual([
        'Saved accounts for staging exist; pass --business <id> to switch without the browser, or --list to see them.\n',
        'Signing in to staging.\n',
      ]);
      expect(h.stdout).toStrictEqual(['Signed in to staging.\n', IDENTITY_LINES_9]);
      expect(browserCalls).toHaveLength(1);
      // The browser sign-in became current; both saved accounts stay.
      expect(await store.readSession('staging')).toMatchObject(IDENTITY_9);
      expect(await store.listAccounts('staging')).toHaveLength(3);
    });

    it('a TTY with saved accounts shows the picker, and picking one switches to it', async () => {
      await saveAAndB();

      const picker = recordingPicker(() => accountKey(ACCOUNT_A));
      const h = loginHarness(kizenForA, { interactive: true, pickAccount: picker });

      await runLogin({ env: 'staging' }, h.deps);

      expect(picker.calls).toStrictEqual([
        {
          title: 'Sign in to staging',
          labels: [`Acme A (${BIZ_A})`, `Bravo B (${BIZ_B})`, 'Sign in with the browser'],
        },
      ]);
      expect(h.exitCodes).toStrictEqual([]);
      expect(await store.readSession('staging')).toMatchObject(ACCOUNT_A);
      expect(browserCalls).toStrictEqual([]);
    });

    it('picking the browser option runs the browser flow', async () => {
      await saveAAndB();

      const picker = recordingPicker(() => BROWSER_PICK);
      const h = loginHarness(undefined, { interactive: true, pickAccount: picker });

      await runLogin({ env: 'staging' }, h.deps);

      expect(picker.calls).toHaveLength(1);
      expect(h.stderr).toStrictEqual(['Signing in to staging.\n']);
      expect(browserCalls).toHaveLength(1);
      expect(await store.readSession('staging')).toMatchObject(IDENTITY_9);
    });

    it('cancelling the picker changes nothing', async () => {
      await saveAAndB();

      const h = loginHarness(undefined, {
        interactive: true,
        pickAccount: recordingPicker(() => undefined),
      });

      await runLogin({ env: 'staging' }, h.deps);

      expect(h.stderr).toStrictEqual(['Cancelled.\n']);
      expect(h.exitCodes).toStrictEqual([1]);
      expect(browserCalls).toStrictEqual([]);
      expect(await store.readSession('staging')).toStrictEqual(CURRENT_B);
    });

    it('--business and --list never show the picker, even at a TTY', async () => {
      await saveAAndB();

      const picker = recordingPicker(() => BROWSER_PICK);
      const h = loginHarness(kizenForA, { interactive: true, pickAccount: picker });

      await runLogin({ env: 'staging', list: true }, h.deps);
      await runLogin({ env: 'staging', business: BIZ_A }, h.deps);

      expect(picker.calls).toStrictEqual([]);
      expect(await store.readSession('staging')).toMatchObject(ACCOUNT_A);
    });

    it('the picker labels accounts by business name and email, falls back to ids, and ends with the browser', () => {
      const unlabeled: OAuthAccount = { businessId: BIZ_C, userId: USER_C };
      const accounts: SavedAccount[] = [
        { account: ACCOUNT_A, session: SAVED_A, current: false },
        { account: ACCOUNT_B, session: CURRENT_B, current: true },
        {
          account: unlabeled,
          session: session('staging', {
            ...unlabeled,
            businessName: undefined,
            email: undefined,
          }),
          current: false,
        },
        { account: { businessId: BIZ_D, userId: USER_D }, session: undefined, current: false },
      ];
      const items = accountPickerItems(accounts);

      expect(items).toStrictEqual([
        { key: accountKey(ACCOUNT_A), label: `Acme A (${BIZ_A})`, description: 'ada@a.test' },
        {
          key: accountKey(ACCOUNT_B),
          label: `Bravo B (${BIZ_B})`,
          description: 'bob@b.test (current)',
        },
        { key: accountKey(unlabeled), label: BIZ_C, description: USER_C },
        {
          key: accountKey({ businessId: BIZ_D, userId: USER_D }),
          label: BIZ_D,
          description: `${USER_D} (can't be read)`,
        },
        { key: BROWSER_PICK, label: 'Sign in with the browser' },
      ]);
      // Each key maps back to its account, the last to the browser, anything else to nothing.
      expect(items.map((item) => pickedAccount(item.key, accounts))).toStrictEqual([
        ...accounts,
        BROWSER_PICK,
      ]);
      expect(pickedAccount(undefined, accounts)).toBeUndefined();
      expect(pickedAccount('unknown', accounts)).toBeUndefined();
    });
  });
});

describe('auth-header', () => {
  const STAGING_MCP = 'https://staging.kizen.com/api/mcp';
  const noKizen = (): Response => jsonResponse({ detail: 'auth-header never calls Kizen' }, 500);
  const header = (token: string): string =>
    `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`;

  /** Two signed-in environments, with different tokens, so env resolution is observable. */
  const twoSessions = async (): Promise<void> => {
    await signIn(store, session('staging'));
    await signIn(
      store,
      session('integration', {
        accessToken: 'integration-access',
        refreshToken: 'integration-refresh',
      }),
    );
  };

  it('auth-header prints exactly one JSON line with the bearer token and nothing else on stdout', async () => {
    await signIn(store, session('staging'));

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
    await signIn(store, session('staging'));

    const other = harness(noKizen);

    await runAuthHeader({ env: 'integration' }, other.deps);

    expectHeaderFailure(none, 'Run `appbuilder login` (add `--env <env>`');
    expectHeaderFailure(other, '`appbuilder login --env integration`');

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
    await signIn(store, session('staging'));

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

  it('--env prints the token when CLAUDE_CODE_MCP_SERVER_URL agrees or is unset', async () => {
    // Two sessions: without --env, and with no server URL, this would be ambiguous.
    await twoSessions();

    for (const url of ['https://integration.kizen.dev/api/mcp', '']) {
      const h = harness(noKizen, { processEnv: { CLAUDE_CODE_MCP_SERVER_URL: url } });

      await runAuthHeader({ env: 'integration' }, h.deps);

      expect(h.stdout).toStrictEqual([header('integration-access')]);
      expect(h.exitCodes).toStrictEqual([]);
    }
  });

  it('the production deps forward auth-header timeouts to the token request', async () => {
    // Real createDefaultAuthCommandDeps wiring on a temp store; only the global fetch is replaced,
    // failing at once. These deps use the real clock, so the session expires 30s from now (inside
    // the refresh leeway).
    await signIn(store, session('staging', { expiresAt: Date.now() + 30_000 }));

    const refused = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const out = { stdout: [] as string[], stderr: [] as string[], exitCodes: [] as number[] };

    vi.stubGlobal('fetch', refused);

    try {
      await runAuthHeader(
        {},
        {
          ...createDefaultAuthCommandDeps(store),
          authHeaderTimeouts: { requestTimeoutMs: 150 },
          processEnv: { CLAUDE_CODE_MCP_SERVER_URL: STAGING_MCP },
          writeStdout: (text) => out.stdout.push(text),
          writeStderr: (text) => out.stderr.push(text),
          setExitCode: (code) => out.exitCodes.push(code),
        },
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(refused.mock.calls.map(([url]) => url)).toStrictEqual([
      'https://staging.kizen.com/oauth2/token',
    ]);
    expect(timeout.mock.calls).toStrictEqual([[150]]);
    expectHeaderFailure(out, "Couldn't reach");
    expect(await store.readSession('staging')).toMatchObject({ refreshToken: REFRESH });
  });

  it('auth-header refreshes an expiring token and prints the new one', async () => {
    await signIn(store, session('staging', { expiresAt: NOW + 30_000 }));

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

  it("auth-header uses timeouts under Claude Code's 10s helper limit", () => {
    // One full request fits inside the helper limit with room for start-up.
    expect(AUTH_HEADER_REQUEST_TIMEOUT_MS).toBeLessThan(9_000);
  });

  it('the refresh after a peer rotated gets only the time left, on the injected clock', async () => {
    const TIMEOUT_MS = 400;
    const elapsed = 300;
    let clock = NOW;

    await signIn(store, session('staging', { expiresAt: NOW + 30_000 }));

    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const h = harness(noKizen, {
      now: () => clock,
      timeouts: { requestTimeoutMs: TIMEOUT_MS },
      tokenEndpoint: async (init) => {
        if (new URLSearchParams(init?.body as string).get('refresh_token') !== REFRESH) {
          return rotatedTokens();
        }

        // Late, a peer rotates to tokens that aren't fresh, and this request is refused.
        clock += elapsed;
        await store.writeSession(
          session('staging', {
            accessToken: ROTATED_ACCESS,
            refreshToken: ROTATED_REFRESH,
            expiresAt: NOW + 30_000,
          }),
        );

        return jsonResponse({ error: 'invalid_grant' }, 400);
      },
    });

    await runAuthHeader({ env: 'staging' }, h.deps);

    // One timeout in total: the retry gets what the first request left.
    expect(timeout.mock.calls).toStrictEqual([[TIMEOUT_MS], [TIMEOUT_MS - elapsed]]);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.stdout).toStrictEqual([header(ROTATED_ACCESS)]);
    expect(await store.readSession('staging')).toMatchObject({ refreshToken: ROTATED_REFRESH });
  });

  it('auth-header prints nothing on stdout when the session is unreadable', async () => {
    await mkdir(store.dir, { recursive: true });
    await writeFile(store.sessionPath('staging'), `{"accessToken": "${ACCESS}", "trunc`);

    // Selected by the MCP server URL.
    const h = harness(noKizen, { processEnv: { CLAUDE_CODE_MCP_SERVER_URL: STAGING_MCP } });

    await runAuthHeader({}, h.deps);

    expectHeaderFailure(h);
    expect(h.stderr).toStrictEqual([
      `appbuilder auth-header: The saved staging session at ${store.sessionPath('staging')} can't be read. Run \`appbuilder login --env staging\` to sign in again.\n`,
    ]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('auth-header never writes tokens to stderr', async () => {
    // invalid_grant on refresh (the session, with its refresh token, is deleted).
    await signIn(store, session('staging', { expiresAt: NOW + 30_000 }));

    const revoked = harness(noKizen, {
      tokenEndpoint: () =>
        jsonResponse({ error: 'invalid_grant', error_description: 'Revoked' }, 400),
    });

    await runAuthHeader({}, revoked.deps);
    expect(revoked.stderr[0]).toContain('appbuilder login --env staging');

    // The token endpoint is unreachable.
    await signIn(store, session('staging', { expiresAt: NOW + 30_000 }));

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

  describe('bound to an account (--business and --user, as kizen runs it)', () => {
    const bound = { env: 'staging', business: BIZ_A, user: USER_A };
    const B_ACCESS = 'secret-b-access';

    it("serves that account's token while it is the current one", async () => {
      await signIn(store, session('staging'));

      const h = harness(noKizen);

      await runAuthHeader(bound, h.deps);

      expect(h.stdout).toStrictEqual([header(ACCESS)]);
      expect(h.stderr).toStrictEqual([]);
      expect(h.exitCodes).toStrictEqual([]);
      // The token comes from that account's own file.
      expect(h.providerOptions).toStrictEqual([
        { requestTimeoutMs: AUTH_HEADER_REQUEST_TIMEOUT_MS, account: ACCOUNT_A },
      ]);
    });

    it('fails closed, naming the mismatch, after a switch to another account', async () => {
      await signIn(store, session('staging'));
      // Another terminal switches staging to account B while kizen still holds A's ids.
      await signIn(store, session('staging', { ...ACCOUNT_B, accessToken: B_ACCESS }));

      const h = harness(noKizen);

      await runAuthHeader(bound, h.deps);

      expectHeaderFailure(h);
      expect(h.stderr).toStrictEqual([
        `appbuilder auth-header: --business ${BIZ_A} --user ${USER_A} isn't the current staging account (the current account is business ${BIZ_B}, user ${USER_B}), so auth-header won't send its token. Run the command again.\n`,
      ]);
      expect(h.all()).not.toContain(B_ACCESS);
      // It fails before reading (or refreshing) any token.
      expect(h.providerOptions).toStrictEqual([]);
      expect(h.fetchMock).not.toHaveBeenCalled();
    });

    it('fails closed after a switch that lands while the token is being read', async () => {
      await signIn(store, session('staging'));

      const h = harness(noKizen);
      const provider = h.deps.tokenProvider;

      h.deps.tokenProvider = (environment, providerOpts) => {
        const inner = provider(environment, providerOpts);

        return {
          ...inner,
          getAccessToken: async () => {
            const token = await inner.getAccessToken();

            await signIn(store, session('staging', { ...ACCOUNT_B, accessToken: B_ACCESS }));

            return token;
          },
        };
      };

      await runAuthHeader(bound, h.deps);

      expectHeaderFailure(h, "isn't the current staging account (the current account is business");
      expect(h.providerOptions).toHaveLength(1);
    });

    it('fails closed when nobody is signed in to the environment any more', async () => {
      await signIn(store, session('staging'));
      await store.signOut('staging');

      const h = harness(noKizen);

      await runAuthHeader(bound, h.deps);

      expectHeaderFailure(h, 'appbuilder auth-header: ');
    });

    it('fails closed when the account is saved but not current', async () => {
      await signIn(store, session('staging'));
      await signIn(store, session('staging', { ...ACCOUNT_B, accessToken: B_ACCESS }));

      // A's file is still saved, so its token could be read: the pointer check is what refuses.
      expect(await store.readAccount('staging', ACCOUNT_A)).not.toBeNull();

      const h = harness(noKizen);

      await runAuthHeader(bound, h.deps);

      expectHeaderFailure(h, "isn't the current staging account");
    });

    it.each([[{ business: BIZ_A }], [{ user: USER_A }]])('refuses %j alone', async (partial) => {
      await signIn(store, session('staging'));

      const h = harness(noKizen);

      await runAuthHeader({ env: 'staging', ...partial }, h.deps);

      expect(h.stderr).toStrictEqual([
        'appbuilder auth-header: auth-header takes --business and --user together.\n',
      ]);
      expectHeaderFailure(h);
      expect(h.providerOptions).toStrictEqual([]);
    });

    it('without the flags, serves the current account as before, after a switch too', async () => {
      await signIn(store, session('staging'));
      await signIn(store, session('staging', { ...ACCOUNT_B, accessToken: B_ACCESS }));

      const h = harness(noKizen);

      await runAuthHeader({ env: 'staging' }, h.deps);

      expect(h.stdout).toStrictEqual([header(B_ACCESS)]);
      expect(h.providerOptions).toStrictEqual([
        { requestTimeoutMs: AUTH_HEADER_REQUEST_TIMEOUT_MS },
      ]);
    });
  });
});
