import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Environment } from './credentials.js';
import {
  kizenAuthHelper,
  kizenChildEnv,
  parseAdminArgs,
  runAdmin,
  type AdminDeps,
  type SpawnKizen,
} from './kizenAdmin.js';
import type { KizenInstall } from './kizenVenv.js';
import {
  createOAuthStore,
  type OAuthAccount,
  type OAuthSession,
  type SavedAccount,
} from './oauthStore.js';
import { ACCOUNT_A, ACCOUNT_B, oauthSession, signIn } from '../test/oauth.js';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACCESS_TOKEN = 'access-token-secret';
const REFRESH_TOKEN = 'refresh-token-secret';

const session = (environment: Environment): OAuthSession => ({
  environment,
  businessId: BUSINESS_ID,
  userId: USER_ID,
  businessName: 'Example',
  fullName: undefined,
  email: undefined,
  issuer: 'https://staging.kizen.com',
  clientId: 'client',
  tokenEndpoint: 'https://staging.kizen.com/oauth/token',
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresAt: 0,
});

const INSTALL: KizenInstall = {
  version: '1.2.3',
  dir: '/venvs/1.2.3-abc',
  python: '/venvs/1.2.3-abc/bin/python',
  kizen: '/venvs/1.2.3-abc/bin/kizen',
  built: false,
};

type FakeChild = EventEmitter & { kill: Mock<(signal: NodeJS.Signals) => boolean> };

interface FakeAdminDeps extends AdminDeps {
  store: {
    listSessions: Mock<() => Promise<Environment[]>>;
    readSession: Mock<(environment: Environment) => Promise<OAuthSession | null>>;
    readAccount: Mock<
      (environment: Environment, account: OAuthAccount) => Promise<OAuthSession | null>
    >;
    listAccounts: Mock<(environment: Environment) => Promise<SavedAccount[]>>;
  };
  ensureKizen: Mock<AdminDeps['ensureKizen']>;
  spawn: Mock<SpawnKizen>;
  outputHelp: Mock<() => void>;
  outputInitHelp: Mock<() => void>;
  setExitCode: Mock<(code: number) => void>;
}

interface Fake {
  deps: FakeAdminDeps;
  children: FakeChild[];
  stderr: string[];
  signals: EventEmitter;
}

/** Deps whose child closes with `exit` (or never, when `exit` is 'hold'). */
function fakeDeps(
  options: {
    sessions?: Environment[];
    signedIn?: boolean;
    exit?: [code: number | null, signal: NodeJS.Signals | null] | 'hold' | 'spawn-error';
    processEnv?: Record<string, string>;
    interactive?: boolean;
  } = {},
): Fake {
  const sessions = options.sessions ?? ['staging'];
  const children: FakeChild[] = [];
  const stderr: string[] = [];
  const signals = new EventEmitter();
  const spawn = vi.fn<SpawnKizen>(() => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      kill: vi.fn<(signal: NodeJS.Signals) => boolean>(() => true),
    });

    children.push(child);

    setImmediate(() => {
      if (options.exit === 'spawn-error') {
        child.emit('error', new Error('spawn /venvs/1.2.3-abc/bin/python ENOENT'));
        child.emit('close', -2, null);
      } else if (options.exit !== 'hold') {
        const [code, signal] = options.exit ?? [0, null];

        child.emit('close', code, signal);
      }
    });

    return child as unknown as ChildProcess;
  });
  const deps: FakeAdminDeps = {
    store: {
      listSessions: vi.fn(() => Promise.resolve(sessions)),
      readSession: vi.fn((environment: Environment) =>
        Promise.resolve(options.signedIn === false ? null : session(environment)),
      ),
      readAccount: vi.fn(() => Promise.resolve(null)),
      listAccounts: vi.fn(() => Promise.resolve([])),
    },
    ensureKizen: vi.fn(() => Promise.resolve(INSTALL)),
    spawn,
    signals: {
      on: (signal: NodeJS.Signals, listener: () => void) => signals.on(signal, listener),
      off: (signal: NodeJS.Signals, listener: () => void) => signals.off(signal, listener),
    },
    interactive: options.interactive ?? true,
    processEnv: options.processEnv ?? { PATH: '/usr/bin' },
    execPath: '/usr/local/bin/node',
    scriptPath: '/opt/appbuilder/dist/index.js',
    outputHelp: vi.fn(),
    outputInitHelp: vi.fn(),
    writeStderr: (text: string) => {
      stderr.push(text);
    },
    setExitCode: vi.fn(),
  };

  return { deps, children, stderr, signals };
}

const spawnCall = (
  deps: FakeAdminDeps,
): { command: string; args: string[]; options: { env: Record<string, string>; stdio: string } } => {
  const [command, args, options] = deps.spawn.mock.calls[0] as unknown as [
    string,
    string[],
    { env: Record<string, string>; stdio: string },
  ];

  return { command, args, options };
};

describe('parseAdminArgs', () => {
  it.each<[string[], ReturnType<typeof parseAdminArgs>]>([
    [[], { kind: 'run', env: undefined, args: [] }],
    [['--help'], { kind: 'help' }],
    [['-h'], { kind: 'help' }],
    [['--env', 'staging', '--help'], { kind: 'help' }],
    [['--env', 'staging', 'status'], { kind: 'run', env: 'staging', args: ['status'] }],
    [['--env=go', 'status'], { kind: 'run', env: 'go', args: ['status'] }],
    // Wrapper options end at the first other token: everything after is kizen's.
    [
      ['status', '--help', '--env', 'go', '--version', '--', '-h'],
      {
        kind: 'run',
        env: undefined,
        args: ['status', '--help', '--env', 'go', '--version', '--', '-h'],
      },
    ],
    [['--version'], { kind: 'run', env: undefined, args: ['--version'] }],
    [['--dry-run', 'apply'], { kind: 'run', env: undefined, args: ['--dry-run', 'apply'] }],
    // ... or at `--`, which is dropped; anything after it is kizen's, even `--` again.
    [['--', '--help'], { kind: 'run', env: undefined, args: ['--help'] }],
    [['--env', 'go', '--', '--', 'x'], { kind: 'run', env: 'go', args: ['--', 'x'] }],
    [['init'], { kind: 'init', force: false }],
    [['init', '--force'], { kind: 'init', force: true }],
    [['--env', 'go', 'init'], { kind: 'init', force: false }],
    // --force is init's, only after it.
    [['--force', 'init'], { kind: 'run', env: undefined, args: ['--force', 'init'] }],
    [['--', 'init', '--force'], { kind: 'run', env: undefined, args: ['init', '--force'] }],
    [
      ['init', '--force', 'x'],
      { kind: 'error', message: 'admin init takes only --force, but got: --force x' },
    ],
    [['init', '--help'], { kind: 'init-help' }],
    [['init', '-h'], { kind: 'init-help' }],
    // (o) `-- init` is kizen's init, which kizen refuses under this mode.
    [['--', 'init'], { kind: 'run', env: undefined, args: ['init'] }],
    [['status', 'init'], { kind: 'run', env: undefined, args: ['status', 'init'] }],
    [
      ['init', 'extra'],
      { kind: 'error', message: 'admin init takes only --force, but got: extra' },
    ],
    [
      ['init', '--help', 'x'],
      { kind: 'error', message: 'admin init takes only --force, but got: --help x' },
    ],
    [['--env'], { kind: 'error', message: "option '--env <env>' argument missing" }],
    [['--env='], { kind: 'error', message: "option '--env <env>' argument missing" }],
    [
      ['--business', 'Acme', '--user', USER_ID, 'status'],
      { kind: 'run', env: undefined, business: 'Acme', user: USER_ID, args: ['status'] },
    ],
    [
      ['--user=u', '--env=go', '--business=b', '--', '--business', 'x'],
      { kind: 'run', env: 'go', business: 'b', user: 'u', args: ['--business', 'x'] },
    ],
    [['--business', 'b', 'init'], { kind: 'init', force: false }],
    // After the first kizen argument, --business and --user are kizen's, verbatim.
    [
      ['status', '--business', 'x', '--user', 'y'],
      { kind: 'run', env: undefined, args: ['status', '--business', 'x', '--user', 'y'] },
    ],
    [
      ['--business'],
      { kind: 'error', message: "option '--business <id-or-name>' argument missing" },
    ],
    [
      ['--business=', 'status'],
      { kind: 'error', message: "option '--business <id-or-name>' argument missing" },
    ],
    [['--user'], { kind: 'error', message: "option '--user <userId>' argument missing" }],
    [['--user='], { kind: 'error', message: "option '--user <userId>' argument missing" }],
  ])('%j', (args, expected) => {
    expect(parseAdminArgs(args)).toStrictEqual(expected);
  });
});

describe('(f) KIZEN_AUTH_HELPER', () => {
  it("round-trips through Python's shlex.split, with spaces and quotes", () => {
    const execPath = "/Users/o'brien/my node/bin/node";
    const scriptPath = '/opt/app "builder"/$HOME/dist/index.js';
    const helper = kizenAuthHelper(execPath, scriptPath, 'staging', {
      businessId: BUSINESS_ID,
      userId: USER_ID,
    });
    const split = JSON.parse(
      execFileSync(
        'python3',
        ['-I', '-c', 'import shlex,sys,json; print(json.dumps(shlex.split(sys.argv[1])))', helper],
        { encoding: 'utf-8' },
      ),
    ) as unknown;

    expect(split).toStrictEqual([
      execPath,
      scriptPath,
      'auth-header',
      '--env',
      'staging',
      '--business',
      BUSINESS_ID,
      '--user',
      USER_ID,
    ]);
  });

  it('leaves plain paths bare', () => {
    expect(
      kizenAuthHelper('/usr/bin/node', '/opt/cli/index.js', 'go', {
        businessId: BUSINESS_ID,
        userId: USER_ID,
      }),
    ).toBe(
      `/usr/bin/node /opt/cli/index.js auth-header --env go --business ${BUSINESS_ID} --user ${USER_ID}`,
    );
  });
});

describe('kizenChildEnv', () => {
  it('(j) strips KIZEN_PROFILE and CLAUDE_CODE_MCP_SERVER_URL and keeps the rest', () => {
    expect(
      kizenChildEnv(
        {
          PATH: '/usr/bin',
          KIZEN_PROFILE: 'prod',
          CLAUDE_CODE_MCP_SERVER_URL: 'https://app.go.kizen.com/api/mcp',
          KIZEN_BASE_URL: 'https://elsewhere.example',
          UNSET: undefined,
        },
        {
          KIZEN_AUTH_HELPER: 'helper',
          KIZEN_BASE_URL: 'https://staging.kizen.com',
          KIZEN_BUSINESS_ID: BUSINESS_ID,
          KIZEN_USER_ID: USER_ID,
        },
      ),
    ).toStrictEqual({
      PATH: '/usr/bin',
      KIZEN_AUTH_HELPER: 'helper',
      KIZEN_BASE_URL: 'https://staging.kizen.com',
      KIZEN_BUSINESS_ID: BUSINESS_ID,
      KIZEN_USER_ID: USER_ID,
    });
  });
});

describe('runAdmin', () => {
  it('runs <venv>/bin/python <venv>/bin/kizen with the session variables and inherited stdio', async () => {
    const { deps } = fakeDeps({
      processEnv: { PATH: '/usr/bin', KIZEN_PROFILE: 'x', CLAUDE_CODE_MCP_SERVER_URL: 'y' },
    });

    await runAdmin(['--env', 'staging', 'envs', 'show'], deps);

    const { command, args, options } = spawnCall(deps);

    expect(command).toBe(INSTALL.python);
    expect(args).toStrictEqual([INSTALL.kizen, 'envs', 'show']);
    expect(options.stdio).toBe('inherit');
    expect(options.env).toStrictEqual({
      PATH: '/usr/bin',
      KIZEN_AUTH_HELPER: `/usr/local/bin/node /opt/appbuilder/dist/index.js auth-header --env staging --business ${BUSINESS_ID} --user ${USER_ID}`,
      KIZEN_BASE_URL: 'https://staging.kizen.com',
      KIZEN_BUSINESS_ID: BUSINESS_ID,
      KIZEN_USER_ID: USER_ID,
    });
    expect(deps.setExitCode).toHaveBeenCalledWith(0);
  });

  it('defaults to the only signed-in environment', async () => {
    const { deps } = fakeDeps({ sessions: ['integration'] });

    await runAdmin(['status'], deps);

    expect(spawnCall(deps).options.env.KIZEN_BASE_URL).toBe('https://integration.kizen.dev');
    expect(deps.store.readSession).toHaveBeenCalledWith('integration');
  });

  it('(a) puts no token, Bearer or refresh token in the child env or argv', async () => {
    const { deps } = fakeDeps({ processEnv: { PATH: '/usr/bin' } });

    await runAdmin(['status'], deps);

    const serialized = JSON.stringify(deps.spawn.mock.calls);

    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toMatch(/bearer/i);
  });

  it.each<[string, Parameters<typeof fakeDeps>[0], string[], string]>([
    [
      'not signed in anywhere',
      { sessions: [] },
      ['status'],
      "appbuilder admin: You're not signed in. Run `appbuilder login` (add `--env <env>` to sign in to an environment other than go).\n",
    ],
    [
      'signed in to several environments',
      { sessions: ['go', 'staging'] },
      ['status'],
      "appbuilder admin: You're signed in to several environments; pass --env <env>: go, staging\n",
    ],
    [
      'an unknown --env',
      {},
      ['--env', 'nope', 'status'],
      'appbuilder admin: Unknown --env "nope". Use one of: go, fmo, staging, integration, test1.\n',
    ],
    [
      'no session for the chosen --env',
      { signedIn: false },
      ['--env', 'staging', 'status'],
      "appbuilder admin: You're not signed in to staging. Run `appbuilder login --env staging` to sign in.\n",
    ],
  ])('(g) %s: no provisioning, no spawn, the hint, exit 1', async (_label, options, args, line) => {
    const { deps, stderr } = fakeDeps(options);

    await runAdmin(args, deps);

    expect(deps.ensureKizen).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(stderr).toStrictEqual([line]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
  });

  it('reports an unreadable session file without provisioning', async () => {
    const { deps, stderr } = fakeDeps();

    deps.store.readSession.mockRejectedValueOnce(new Error('The saved session can’t be read.'));

    await runAdmin(['status'], deps);

    expect(deps.ensureKizen).not.toHaveBeenCalled();
    expect(stderr).toStrictEqual(['appbuilder admin: The saved session can’t be read.\n']);
  });

  it('reports a provisioning failure without spawning', async () => {
    const { deps, stderr } = fakeDeps();

    deps.ensureKizen.mockRejectedValueOnce(
      new Error('No Python 3.12 or newer found to run kizen.'),
    );

    await runAdmin(['status'], deps);

    expect(deps.spawn).not.toHaveBeenCalled();
    expect(stderr).toStrictEqual([
      'appbuilder admin: No Python 3.12 or newer found to run kizen.\n',
    ]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
  });

  it("(i) exits with kizen's exit code", async () => {
    const { deps } = fakeDeps({ exit: [3, null] });

    await runAdmin(['status'], deps);

    expect(deps.setExitCode).toHaveBeenCalledWith(3);
  });

  it('(i) exits with 128 + the signal number when a signal ended kizen', async () => {
    const { deps } = fakeDeps({ exit: [null, 'SIGTERM'] });

    await runAdmin(['status'], deps);

    expect(deps.setExitCode).toHaveBeenCalledWith(143);
  });

  it('(i) interactive: swallows SIGINT without forwarding it, and still exits with the child code', async () => {
    const { deps, children, signals } = fakeDeps({ interactive: true, exit: 'hold' });
    const running = runAdmin(['status'], deps);

    await vi.waitFor(() => {
      expect(children).toHaveLength(1);
    });

    // A listener is what keeps node alive on Ctrl-C; the terminal already sent kizen its own.
    expect(signals.listenerCount('SIGINT')).toBe(1);

    signals.emit('SIGINT');
    signals.emit('SIGINT');

    const [child] = children;

    expect(child?.kill).not.toHaveBeenCalled();

    child?.emit('close', 130, null);
    await running;

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      expect(signals.listenerCount(signal)).toBe(0);
    }

    expect(deps.setExitCode).toHaveBeenCalledWith(130);
  });

  it('(i) non-interactive: forwards each SIGINT to kizen once, then removes its listeners', async () => {
    const { deps, children, signals } = fakeDeps({ interactive: false, exit: 'hold' });
    const running = runAdmin(['status'], deps);

    await vi.waitFor(() => {
      expect(children).toHaveLength(1);
    });

    expect(signals.listenerCount('SIGINT')).toBe(1);

    signals.emit('SIGINT');

    const [child] = children;

    expect(child?.kill.mock.calls).toStrictEqual([['SIGINT']]);

    signals.emit('SIGINT');

    expect(child?.kill.mock.calls).toStrictEqual([['SIGINT'], ['SIGINT']]);

    child?.emit('close', null, 'SIGINT');
    await running;

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      expect(signals.listenerCount(signal)).toBe(0);
    }

    expect(deps.setExitCode).toHaveBeenCalledWith(130);
  });

  it.each([
    ['interactive', true],
    ['non-interactive', false],
  ])(
    '(i) %s: forwards SIGTERM and SIGHUP to kizen, then removes its listeners',
    async (_, interactive) => {
      const { deps, children, signals } = fakeDeps({ interactive, exit: 'hold' });
      const running = runAdmin(['status'], deps);

      await vi.waitFor(() => {
        expect(children).toHaveLength(1);
      });

      signals.emit('SIGTERM');
      signals.emit('SIGHUP');

      const [child] = children;

      expect(child?.kill.mock.calls).toStrictEqual([['SIGTERM'], ['SIGHUP']]);

      child?.emit('close', null, 'SIGTERM');
      await running;

      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        expect(signals.listenerCount(signal)).toBe(0);
      }

      expect(deps.setExitCode).toHaveBeenCalledWith(143);
    },
  );

  it.each([
    ['interactive', true],
    ['non-interactive', false],
  ])(
    '(i) %s: a spawn error prints one line, exits 1 and removes its listeners',
    async (_, interactive) => {
      const { deps, stderr, signals } = fakeDeps({ interactive, exit: 'spawn-error' });

      await runAdmin(['status'], deps);

      expect(stderr).toStrictEqual([
        "appbuilder admin: couldn't start kizen: spawn /venvs/1.2.3-abc/bin/python ENOENT\n",
      ]);
      expect(deps.setExitCode.mock.calls).toStrictEqual([[1]]);

      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        expect(signals.listenerCount(signal)).toBe(0);
      }
    },
  );

  it('passes --force to the provisioner only from admin init --force', async () => {
    const { deps } = fakeDeps();

    await runAdmin(['init', '--force'], deps);
    await runAdmin(['init'], deps);
    await runAdmin(['status'], deps);

    expect(deps.ensureKizen.mock.calls).toStrictEqual([[{ force: true }], [undefined], []]);
  });

  it('(m) init and the auto path share the provisioner; init needs no session', async () => {
    const { deps, stderr } = fakeDeps({ sessions: [] });

    await runAdmin(['init'], deps);

    expect(deps.ensureKizen).toHaveBeenCalledTimes(1);
    expect(deps.store.listSessions).not.toHaveBeenCalled();
    expect(stderr).toStrictEqual(['appbuilder admin: kizen 1.2.3 is ready in /venvs/1.2.3-abc.\n']);

    const auto = fakeDeps();

    auto.deps.ensureKizen = deps.ensureKizen;

    await runAdmin(['status'], auto.deps);

    expect(deps.ensureKizen).toHaveBeenCalledTimes(2);
    expect(auto.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('shows help for --help and init --help without provisioning', async () => {
    const { deps } = fakeDeps();

    await runAdmin(['--help'], deps);
    await runAdmin(['init', '--help'], deps);

    expect(deps.outputHelp).toHaveBeenCalledTimes(1);
    expect(deps.outputInitHelp).toHaveBeenCalledTimes(1);
    expect(deps.ensureKizen).not.toHaveBeenCalled();
  });

  it('rejects init with extra arguments', async () => {
    const { deps, stderr } = fakeDeps();

    await runAdmin(['init', 'now'], deps);

    expect(stderr).toStrictEqual([
      'appbuilder admin: admin init takes only --force, but got: now\n',
    ]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.ensureKizen).not.toHaveBeenCalled();
  });
});

describe('runAdmin with a named saved account', () => {
  /**
   * A real store with account A current and B ("Bravo") saved but not current; `run` gets deps
   * whose store is it.
   */
  const withAccounts = async (
    run: (
      deps: AdminDeps & FakeAdminDeps,
      stderr: string[],
      store: ReturnType<typeof createOAuthStore>,
    ) => Promise<void>,
    processEnv: Record<string, string> = { PATH: '/usr/bin' },
  ): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'appbuilder-admin-'));

    try {
      const store = createOAuthStore(dir);

      await store.writeSession(oauthSession({ ...ACCOUNT_B, businessName: 'Bravo' }));
      await signIn(store, oauthSession());

      const { deps, stderr } = fakeDeps({ processEnv });

      await run({ ...deps, store } as unknown as AdminDeps & FakeAdminDeps, stderr, store);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const boundTo = (account: OAuthAccount): Record<string, string> => ({
    KIZEN_AUTH_HELPER: `/usr/local/bin/node /opt/appbuilder/dist/index.js auth-header --env staging --business ${account.businessId} --user ${account.userId}`,
    KIZEN_BASE_URL: 'https://staging.kizen.com',
    KIZEN_BUSINESS_ID: account.businessId,
    KIZEN_USER_ID: account.userId,
  });

  it("--business binds kizen to that account while another is current, and later --business is kizen's", async () => {
    await withAccounts(async (deps, stderr, store) => {
      await runAdmin(['--business', 'bravo', '--', 'status', '--business', 'x'], deps);

      expect(stderr).toStrictEqual([]);

      const { args, options } = spawnCall(deps);

      expect(args).toStrictEqual([INSTALL.kizen, 'status', '--business', 'x']);
      expect(options.env).toStrictEqual({ PATH: '/usr/bin', ...boundTo(ACCOUNT_B) });
      // The pointer never moves.
      expect(await store.readSession('staging')).toMatchObject(ACCOUNT_A);
    });
  });

  it('without --env, --business finds its environment when nothing is current', async () => {
    await withAccounts(async (deps, stderr, store) => {
      await store.signOut('staging');

      await runAdmin(['--business', 'bravo', 'status'], deps);

      expect(stderr).toStrictEqual([]);
      expect(spawnCall(deps).options.env).toStrictEqual({
        PATH: '/usr/bin',
        ...boundTo(ACCOUNT_B),
      });
      expect(await store.listSessions()).toStrictEqual([]);
    });
  });

  it('with --env, --business binds kizen to that account when nothing is current', async () => {
    await withAccounts(async (deps, stderr, store) => {
      await store.signOut('staging');

      await runAdmin(['--env', 'staging', '--business', 'bravo', 'status'], deps);

      expect(stderr).toStrictEqual([]);
      expect(spawnCall(deps).options.env).toStrictEqual({
        PATH: '/usr/bin',
        ...boundTo(ACCOUNT_B),
      });
      expect(await store.listSessions()).toStrictEqual([]);
    });
  });

  it('without --env, a name saved in staging and go asks for --env', async () => {
    await withAccounts(async (deps, stderr, store) => {
      await store.writeSession(
        oauthSession({ ...ACCOUNT_B, environment: 'go', businessName: 'Bravo' }),
      );

      await runAdmin(['--business', 'bravo', 'status'], deps);

      expect(stderr).toStrictEqual([
        'appbuilder admin: --business bravo matches saved accounts in several environments; pass --env <env>: go, staging\n',
      ]);
      expect(deps.ensureKizen).not.toHaveBeenCalled();
      expect(deps.spawn).not.toHaveBeenCalled();
    });
  });

  it('--business after the first kizen argument leaves kizen on the current account', async () => {
    await withAccounts(async (deps) => {
      await runAdmin(['status', '--business', 'bravo'], deps);

      const { args, options } = spawnCall(deps);

      expect(args).toStrictEqual([INSTALL.kizen, 'status', '--business', 'bravo']);
      expect(options.env).toMatchObject(boundTo(ACCOUNT_A));
    });
  });

  it.each<[string, Record<string, string>, string[], OAuthAccount]>([
    ['APPBUILDER_BUSINESS names it', { APPBUILDER_BUSINESS: 'Bravo' }, ['status'], ACCOUNT_B],
    [
      '--business beats APPBUILDER_BUSINESS',
      { APPBUILDER_BUSINESS: 'Bravo', APPBUILDER_USER: ACCOUNT_B.userId },
      ['--business', ACCOUNT_A.businessId, 'status'],
      ACCOUNT_A,
    ],
    [
      'an empty APPBUILDER_BUSINESS counts as unset',
      { APPBUILDER_BUSINESS: '' },
      ['status'],
      ACCOUNT_A,
    ],
  ])('%s', async (_name, env, args, expected) => {
    await withAccounts(
      async (deps) => {
        await runAdmin(args, deps);

        expect(spawnCall(deps).options.env).toMatchObject(boundTo(expected));
      },
      { PATH: '/usr/bin', ...env },
    );
  });

  it.each<[string, Record<string, string>, string[], string]>([
    [
      'a name no saved account matches',
      {},
      ['--business', 'Nope', 'status'],
      `appbuilder admin: No saved staging account matches --business Nope. Saved accounts:\n  Acme A (${ACCOUNT_A.businessId}) ada@a.test\n  Bravo (${ACCOUNT_B.businessId}) ada@a.test\n`,
    ],
    [
      'APPBUILDER_USER without APPBUILDER_BUSINESS',
      { APPBUILDER_USER: ACCOUNT_B.userId },
      ['status'],
      'appbuilder admin: APPBUILDER_USER only applies with APPBUILDER_BUSINESS.\n',
    ],
    [
      '--user without --business',
      {},
      ['--user', ACCOUNT_B.userId, 'status'],
      'appbuilder admin: --user only applies with --business.\n',
    ],
  ])('%s: no provisioning, no spawn, exit 1', async (_name, env, args, line) => {
    await withAccounts(
      async (deps, stderr) => {
        await runAdmin(args, deps);

        expect(stderr).toStrictEqual([line]);
        expect(deps.ensureKizen).not.toHaveBeenCalled();
        expect(deps.spawn).not.toHaveBeenCalled();
        expect(deps.setExitCode).toHaveBeenCalledWith(1);
      },
      { PATH: '/usr/bin', ...env },
    );
  });
});
