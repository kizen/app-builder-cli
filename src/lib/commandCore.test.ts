import { describe, expect, it, vi } from 'vitest';
import {
  exitCodeFor,
  failure,
  headlessWriteGate,
  resolveCredentials,
  writeFailure,
  type CommandDeps,
  type CommandErrorCode,
  type OAuthCommandDeps,
} from './commandCore.js';
import {
  ENVIRONMENTS,
  type Credentials,
  type DetailedCredentials,
  type Environment,
} from './credentials.js';
import type { KizenClient } from './kizenTypes.js';

const CREDENTIALS_PATH = '/tmp/credentials.json';

/** The API-key file's ids; every one differs from the session identity's. */
const FILE_CREDENTIALS: Credentials = {
  apiKey: 'file-key',
  userId: 'file-user',
  businessId: 'file-biz',
  environment: 'staging',
};

/** The sign-in session's identity; its user and business differ from the file's and each other. */
const IDENTITY = {
  userId: 'session-user',
  businessId: 'session-biz',
  businessName: 'Acme',
  fullName: 'Ada L',
  email: 'ada@example.com',
};

const apiKeyClient = {} as KizenClient;
const sessionClient = {} as KizenClient;

const makeDeps = (
  options: {
    environmentSource?: DetailedCredentials['environmentSource'];
    /** What the file loads as; FILE_CREDENTIALS unless given. */
    credentials?: Credentials;
    /** The environments signed in to. */
    sessions?: Environment[];
  } = {},
): CommandDeps & {
  createClient: ReturnType<typeof vi.fn<CommandDeps['createClient']>>;
  oauth: { connect: ReturnType<typeof vi.fn<OAuthCommandDeps['connect']>> };
} => ({
  cwd: '/work',
  loadCredentialsDetailed: vi.fn(() =>
    Promise.resolve({
      credentials: options.credentials ?? FILE_CREDENTIALS,
      environmentSource: options.environmentSource ?? 'explicit',
    }),
  ),
  listLoadableCredentialProfiles: vi.fn(() => Promise.resolve([])),
  loadConfig: vi.fn(() => Promise.resolve({})),
  createClient: vi.fn<CommandDeps['createClient']>(() => apiKeyClient),
  now: () => new Date('2026-10-27T12:00:00.000Z'),
  writeStdout: vi.fn(),
  writeStderr: vi.fn(),
  setExitCode: vi.fn(),
  processEnv: {},
  oauth: {
    listSessions: vi.fn(() => Promise.resolve(options.sessions ?? ['staging' as const])),
    listAccounts: vi.fn(() => Promise.resolve([])),
    connect: vi.fn<OAuthCommandDeps['connect']>(() =>
      Promise.resolve({ identity: IDENTITY, client: sessionClient }),
    ),
  },
});

describe('resolveCredentials', () => {
  it.each([
    ['missing', 'has no "environment"'],
    ['invalid', 'has an invalid "environment"'],
  ] as const)(
    'resolveCredentials refuses a credential file with a %s environment',
    async (environmentSource, problem) => {
      // The real loader falls back to production when the environment is missing or invalid.
      const deps = makeDeps({
        environmentSource,
        credentials: { ...FILE_CREDENTIALS, environment: 'go' },
      });
      const step = await resolveCredentials({ credentials: CREDENTIALS_PATH }, deps);

      expect(step).toStrictEqual({
        ok: false,
        code: 'credentials_invalid',
        message: `${CREDENTIALS_PATH} ${problem}. Set it to one of: ${ENVIRONMENTS.join(', ')}. The CLI won't default to production.`,
      });
      // Nothing that could reach an environment was built from the file.
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(deps.oauth.connect).not.toHaveBeenCalled();
    },
  );

  it('the not_signed_in hint matches the harness', async () => {
    const hintUnder = async (processEnv: CommandDeps['processEnv']): Promise<unknown> => {
      const step = await resolveCredentials({}, { ...makeDeps({ sessions: [] }), processEnv });

      expect(step).toMatchObject({
        ok: false,
        code: 'not_signed_in',
        login: { argv: ['appbuilder', 'login'] },
      });

      return (step as { hint?: unknown }).hint;
    };

    const CLAUDE =
      'Ask the user to sign in: they type `! appbuilder login` in this Claude Code session, or you run it in the background and give them the URL it prints. Then run this command again.';
    const CODEX =
      'Ask the user to sign in: they run `appbuilder login` in their own terminal, where it opens a browser and waits for the sign-in. Then run this command again.';
    const NEUTRAL =
      'Ask the user to sign in: they run `appbuilder login` in a terminal, or you run it in the background and give them the URL it prints. Then run this command again.';

    expect(await hintUnder({ CLAUDECODE: '1' })).toBe(CLAUDE);
    // The Codex plugin for Claude Code sets CODEX_COMPANION_*; that's still Claude Code.
    expect(await hintUnder({ CLAUDECODE: '1', CODEX_COMPANION_SESSION_ID: 'x' })).toBe(CLAUDE);
    expect(await hintUnder({ CODEX_CI: '1' })).toBe(CODEX);
    expect(await hintUnder({ CODEX_CI: '1', CLAUDECODE: '1' })).toBe(CODEX);
    expect(await hintUnder({})).toBe(NEUTRAL);
    expect(await hintUnder({ CODEX_COMPANION_SESSION_ID: 'x', CODEX_HOME: '/x' })).toBe(NEUTRAL);
  });

  it('resolveCredentials returns identity userId in bearer mode', async () => {
    const deps = makeDeps();
    const step = await resolveCredentials({}, deps);

    expect(step).toStrictEqual({
      ok: true,
      value: {
        credentials: { environment: 'staging', businessId: 'session-biz', userId: 'session-user' },
        client: sessionClient,
        notices: [],
      },
    });
    expect(deps.loadCredentialsDetailed).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('resolveCredentials returns credential-file userId in api-key mode', async () => {
    const deps = makeDeps();
    const step = await resolveCredentials({ credentials: CREDENTIALS_PATH }, deps);

    if (!step.ok) {
      throw new Error(`expected credentials, got ${step.code}`);
    }

    expect(step.value.credentials).toStrictEqual({
      environment: 'staging',
      businessId: 'file-biz',
      userId: 'file-user',
    });
    expect(step.value.client).toBe(apiKeyClient);
    expect(deps.oauth.connect).not.toHaveBeenCalled();
  });

  it('resolveCredentials never returns apiKey in api-key mode', async () => {
    const deps = makeDeps();
    const step = await resolveCredentials({ credentials: CREDENTIALS_PATH }, deps);

    if (!step.ok) {
      throw new Error(`expected credentials, got ${step.code}`);
    }

    expect('apiKey' in step.value.credentials).toBe(false);
    expect(JSON.stringify(step.value.credentials)).not.toContain('file-key');
    // The client alone gets the key.
    expect(deps.createClient).toHaveBeenCalledWith(FILE_CREDENTIALS);
  });

  it('resolveCredentials returns needs_choice with --env args when several environments are signed in', async () => {
    const deps = makeDeps({ sessions: ['go', 'staging'] });
    const step = await resolveCredentials({}, deps);

    expect(step).toStrictEqual({
      ok: false,
      code: 'needs_choice',
      message: "You're signed in to several environments; pass --env <env>: go, staging",
      choice: 'environment',
      choices: [
        { value: 'go', label: 'go', args: ['--env', 'go'] },
        { value: 'staging', label: 'staging', args: ['--env', 'staging'] },
      ],
    });
    expect(deps.oauth.connect).not.toHaveBeenCalled();
  });
});

describe('headlessWriteGate', () => {
  it.each(ENVIRONMENTS)('headlessWriteGate requires --yes for any write (%s)', (environment) => {
    for (const options of [{}, { allowProduction: true }, { yes: false, allowProduction: true }]) {
      expect(headlessWriteGate(options, environment)).toStrictEqual({
        ok: true,
        value: { kind: 'dry-run', reason: 'no_yes' },
      });
    }
  });

  it('headlessWriteGate requires --allow-production on go and fmo but not integration', () => {
    for (const environment of ['go', 'fmo'] as const) {
      expect(headlessWriteGate({ yes: true }, environment)).toStrictEqual({
        ok: false,
        code: 'production_requires_flag',
        message: `${environment} is a production environment. Pass --allow-production with --yes to write to it.`,
      });
      expect(headlessWriteGate({ yes: true, allowProduction: true }, environment)).toStrictEqual({
        ok: true,
        value: { kind: 'apply' },
      });
    }

    for (const environment of ['integration', 'staging', 'test1'] as const) {
      expect(headlessWriteGate({ yes: true }, environment)).toStrictEqual({
        ok: true,
        value: { kind: 'apply' },
      });
    }
  });
});

describe('writeFailure', () => {
  it('needs_choice and base_required exit 2; other failures exit 1', () => {
    const exitFor = (code: CommandErrorCode): number | undefined => {
      const deps = makeDeps();

      writeFailure({ json: true, deps }, failure(code, 'x'), () => []);

      return (deps.setExitCode as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as number;
    };

    expect(exitFor('needs_choice')).toBe(2);
    expect(exitFor('base_required')).toBe(2);

    for (const code of [
      'not_signed_in',
      'credentials_invalid',
      'session_store_unwritable',
      'network_error',
      'publish_conflict',
      'unresolved_conflicts',
      'production_requires_flag',
      'drift_detected',
      'not_found',
    ] satisfies CommandErrorCode[]) {
      expect(exitFor(code)).toBe(1);
      expect(exitCodeFor(code)).toBe(1);
    }
  });

  it('gives every choice the argv the runner builds, and keeps args as they were', () => {
    const deps = makeDeps();

    writeFailure(
      { json: true, deps },
      failure<'environment'>('needs_choice', 'pick', {
        choice: 'environment',
        choices: [{ value: 'go', label: 'go', args: ['--env', 'go'] }],
      }),
      (choice, kind) => ['appbuilder', 'x', String(kind), ...choice.args, '--json'],
    );

    expect(
      JSON.parse(String((deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])),
    ).toStrictEqual({
      ok: false,
      code: 'needs_choice',
      message: 'pick',
      choice: 'environment',
      choices: [
        {
          value: 'go',
          label: 'go',
          args: ['--env', 'go'],
          argv: ['appbuilder', 'x', 'environment', '--env', 'go', '--json'],
        },
      ],
    });
  });
});
