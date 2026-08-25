import { describe, expect, it, vi } from 'vitest';
import type { Credentials } from './credentials.js';
import type { EncryptionContext } from './encryptionClient.js';
import type { ManifestDefaults } from './encryptHelpers.js';
import { runHeadless, type HeadlessEncryptDeps } from './encryptHeadless.js';

const CREDENTIALS: Credentials = {
  apiKey: 'test-key',
  userId: 'test-user',
  businessId: 'test-business',
  environment: 'go',
};

const PROD_CTX: EncryptionContext = { isRemote: false, stage: 'prod' };

interface Harness {
  deps: HeadlessEncryptDeps;
  stdout: string[];
  stderr: string[];
  /** Ordered record of the side effects that write data out, for ordering checks. */
  calls: string[];
  exitCodes: number[];
  written: { path: string; value: string }[];
}

/** A fully injected deps object: no TTY, no credentials on disk, no network. */
function harness(overrides: Partial<HeadlessEncryptDeps> = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[] = [];
  const exitCodes: number[] = [];
  const written: { path: string; value: string }[] = [];

  const deps: HeadlessEncryptDeps = {
    loadCredentialsFromFile: vi.fn(() => Promise.resolve(CREDENTIALS)),
    loadGlobalCredentials: vi.fn(() => Promise.resolve<Credentials | null>(CREDENTIALS)),
    encryptSecret: vi.fn(
      (_ctx: EncryptionContext, _creds: Credentials, apiName: string, value: string) =>
        Promise.resolve(`enc(${apiName}:${value})`),
    ),
    readStdin: vi.fn(() => Promise.resolve('')),
    stdinIsTTY: () => false,
    writeStdout: (text) => {
      stdout.push(text);
      calls.push('stdout');
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
    writeEnvelopeFile: vi.fn((path: string, value: string) => {
      written.push({ path, value });
      calls.push('writeEnvelopeFile');

      return Promise.resolve();
    }),
    setExitCode: (code) => {
      exitCodes.push(code);
    },
    ...overrides,
  };

  return { deps, stdout, stderr, calls, exitCodes, written };
}

const NO_DEFAULTS: ManifestDefaults = {};

describe('runHeadless credential loading', () => {
  it('loads the global credentials when --credentials is not given', async () => {
    const h = harness();

    await runHeadless(PROD_CTX, { apiName: 'acme', value: 'v' }, NO_DEFAULTS, false, h.deps);

    expect(h.deps.loadGlobalCredentials).toHaveBeenCalledOnce();
    expect(h.deps.loadCredentialsFromFile).not.toHaveBeenCalled();
  });

  it('loads the given file when --credentials is passed', async () => {
    const h = harness();

    await runHeadless(
      PROD_CTX,
      { apiName: 'acme', value: 'v', credentials: '/tmp/creds.json' },
      NO_DEFAULTS,
      false,
      h.deps,
    );

    expect(h.deps.loadCredentialsFromFile).toHaveBeenCalledWith('/tmp/creds.json');
    expect(h.deps.loadGlobalCredentials).not.toHaveBeenCalled();
  });

  it('throws with setup guidance when no global credentials exist', async () => {
    const h = harness({ loadGlobalCredentials: () => Promise.resolve(null) });

    await expect(
      runHeadless(PROD_CTX, { apiName: 'acme', value: 'v' }, NO_DEFAULTS, false, h.deps),
    ).rejects.toThrow(/No credentials found\. Pass --credentials/);

    expect(h.stdout).toEqual([]);
  });

  it('propagates a credentials-file read failure', async () => {
    const h = harness({
      loadCredentialsFromFile: () => Promise.reject(new Error('ENOENT: no such file')),
    });

    await expect(
      runHeadless(
        PROD_CTX,
        { apiName: 'acme', value: 'v', credentials: '/nope.json' },
        NO_DEFAULTS,
        false,
        h.deps,
      ),
    ).rejects.toThrow('ENOENT: no such file');
  });
});

describe('runHeadless api_name resolution', () => {
  it('prefers --api-name over the kizen.json default', async () => {
    const h = harness();

    await runHeadless(
      PROD_CTX,
      { apiName: 'from_flag', value: 'v' },
      { apiName: 'from_manifest' },
      false,
      h.deps,
    );

    expect(h.deps.encryptSecret).toHaveBeenCalledWith(PROD_CTX, CREDENTIALS, 'from_flag', 'v');
  });

  it('falls back to the kizen.json default', async () => {
    const h = harness();

    await runHeadless(PROD_CTX, { value: 'v' }, { apiName: 'from_manifest' }, false, h.deps);

    expect(h.deps.encryptSecret).toHaveBeenCalledWith(PROD_CTX, CREDENTIALS, 'from_manifest', 'v');
  });

  it('trims the api_name before encrypting', async () => {
    const h = harness();

    await runHeadless(PROD_CTX, { apiName: '  acme  ', value: 'v' }, NO_DEFAULTS, false, h.deps);

    expect(h.deps.encryptSecret).toHaveBeenCalledWith(PROD_CTX, CREDENTIALS, 'acme', 'v');
  });

  it('throws when no api_name is available from either source', async () => {
    const h = harness();

    await expect(runHeadless(PROD_CTX, { value: 'v' }, NO_DEFAULTS, false, h.deps)).rejects.toThrow(
      /api_name is required in non-interactive mode/,
    );
  });

  it('throws when the api_name is only whitespace', async () => {
    const h = harness();

    await expect(
      runHeadless(PROD_CTX, { apiName: '   ', value: 'v' }, NO_DEFAULTS, false, h.deps),
    ).rejects.toThrow(/api_name is required in non-interactive mode/);
  });
});

describe('runHeadless stage notice', () => {
  it('warns on stderr when the stage was defaulted', async () => {
    const h = harness();

    await runHeadless(PROD_CTX, { apiName: 'acme', value: 'v' }, NO_DEFAULTS, true, h.deps);

    expect(h.stderr).toContain(
      'No --stage given; defaulting to prod encryption keys (pass --stage dev to override)\n',
    );
  });

  it('names the stage actually in use', async () => {
    const h = harness();

    await runHeadless(
      { isRemote: false, stage: 'dev' },
      { apiName: 'acme', value: 'v' },
      NO_DEFAULTS,
      true,
      h.deps,
    );

    expect(h.stderr[0]).toContain('defaulting to dev encryption keys');
  });

  it('stays silent when --stage was given explicitly', async () => {
    const h = harness();

    await runHeadless(PROD_CTX, { apiName: 'acme', value: 'v' }, NO_DEFAULTS, false, h.deps);

    expect(h.stderr.join('')).not.toContain('No --stage given');
  });
});

describe('runHeadless secret sourcing', () => {
  it('uses --value without touching stdin', async () => {
    const h = harness();

    await runHeadless(
      PROD_CTX,
      { apiName: 'acme', value: 'from-flag' },
      NO_DEFAULTS,
      false,
      h.deps,
    );

    expect(h.deps.readStdin).not.toHaveBeenCalled();
    expect(h.stdout).toEqual(['{"encrypted":true,"value":"enc(acme:from-flag)"}\n']);
  });

  it('reads the secret from stdin and announces the read', async () => {
    const h = harness({ readStdin: () => Promise.resolve('piped-secret') });

    await runHeadless(PROD_CTX, { apiName: 'acme' }, NO_DEFAULTS, false, h.deps);

    expect(h.stderr).toContain('Reading secret from stdin (pass --value to skip)…\n');
    expect(h.stdout).toEqual(['{"encrypted":true,"value":"enc(acme:piped-secret)"}\n']);
  });

  it('strips a trailing LF, CRLF, or lone CR from the piped secret', async () => {
    for (const [piped, expected] of [
      ['secret\n', 'secret'],
      ['secret\r\n', 'secret'],
      ['secret\r', 'secret'],
      ['secret\n\n', 'secret'],
    ] as const) {
      const h = harness({ readStdin: () => Promise.resolve(piped) });

      await runHeadless(PROD_CTX, { apiName: 'acme' }, NO_DEFAULTS, false, h.deps);

      expect(h.deps.encryptSecret).toHaveBeenCalledWith(PROD_CTX, CREDENTIALS, 'acme', expected);
    }
  });

  it('keeps interior newlines in a multi-line piped secret', async () => {
    const h = harness({
      readStdin: () => Promise.resolve('-----BEGIN-----\nbody\n-----END-----\n'),
    });

    await runHeadless(PROD_CTX, { apiName: 'acme' }, NO_DEFAULTS, false, h.deps);

    expect(h.deps.encryptSecret).toHaveBeenCalledWith(
      PROD_CTX,
      CREDENTIALS,
      'acme',
      '-----BEGIN-----\nbody\n-----END-----',
    );
  });

  it('fails fast instead of hanging when stdin is a terminal', async () => {
    const h = harness({ stdinIsTTY: () => true });

    await expect(
      runHeadless(PROD_CTX, { apiName: 'acme' }, NO_DEFAULTS, false, h.deps),
    ).rejects.toThrow(/stdin is a terminal/);

    expect(h.deps.readStdin).not.toHaveBeenCalled();
  });

  it('rejects an empty secret from stdin', async () => {
    const h = harness({ readStdin: () => Promise.resolve('\n') });

    await expect(
      runHeadless(PROD_CTX, { apiName: 'acme' }, NO_DEFAULTS, false, h.deps),
    ).rejects.toThrow(/A secret value is required/);

    expect(h.deps.encryptSecret).not.toHaveBeenCalled();
  });

  it('rejects an empty --value', async () => {
    const h = harness();

    await expect(
      runHeadless(PROD_CTX, { apiName: 'acme', value: '' }, NO_DEFAULTS, false, h.deps),
    ).rejects.toThrow(/A secret value is required/);
  });
});

describe('runHeadless stdout contract', () => {
  it('writes exactly one compact JSON line terminated by a newline', async () => {
    const h = harness();

    await runHeadless(PROD_CTX, { apiName: 'acme', value: 'v' }, NO_DEFAULTS, false, h.deps);

    expect(h.stdout).toHaveLength(1);

    const line = h.stdout[0] ?? '';

    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line) as unknown).toEqual({ encrypted: true, value: 'enc(acme:v)' });
  });

  it('emits nothing on stdout when encryption fails', async () => {
    const h = harness({ encryptSecret: () => Promise.reject(new Error('wizard unreachable')) });

    await expect(
      runHeadless(PROD_CTX, { apiName: 'acme', value: 'v' }, NO_DEFAULTS, false, h.deps),
    ).rejects.toThrow('wizard unreachable');

    expect(h.stdout).toEqual([]);
  });
});

describe('runHeadless --out handling', () => {
  it('writes the envelope file and confirms it on stderr', async () => {
    const h = harness();

    await runHeadless(
      PROD_CTX,
      { apiName: 'acme', value: 'v', out: '/tmp/out.json' },
      NO_DEFAULTS,
      false,
      h.deps,
    );

    expect(h.written).toEqual([{ path: '/tmp/out.json', value: 'enc(acme:v)' }]);
    expect(h.stderr).toContain('Wrote encrypted envelope to /tmp/out.json\n');
    expect(h.exitCodes).toEqual([]);
  });

  it('writes stdout before the --out file so the pipe contract always holds', async () => {
    const h = harness();

    await runHeadless(
      PROD_CTX,
      { apiName: 'acme', value: 'v', out: '/tmp/out.json' },
      NO_DEFAULTS,
      false,
      h.deps,
    );

    expect(h.calls).toEqual(['stdout', 'writeEnvelopeFile']);
  });

  it('skips the file write entirely when --out is absent', async () => {
    const h = harness();

    await runHeadless(PROD_CTX, { apiName: 'acme', value: 'v' }, NO_DEFAULTS, false, h.deps);

    expect(h.deps.writeEnvelopeFile).not.toHaveBeenCalled();
    expect(h.exitCodes).toEqual([]);
  });

  it('keeps the stdout envelope and exits 1 when the --out write fails', async () => {
    const h = harness({
      writeEnvelopeFile: () => Promise.reject(new Error('EACCES: permission denied')),
    });

    await runHeadless(
      PROD_CTX,
      { apiName: 'acme', value: 'v', out: '/root/out.json' },
      NO_DEFAULTS,
      false,
      h.deps,
    );

    expect(h.stdout).toEqual(['{"encrypted":true,"value":"enc(acme:v)"}\n']);
    expect(h.stderr).toContain('Error writing /root/out.json: EACCES: permission denied\n');
    expect(h.exitCodes).toEqual([1]);
  });

  it('does not re-throw a failed --out write', async () => {
    const h = harness({ writeEnvelopeFile: () => Promise.reject(new Error('nope')) });

    await expect(
      runHeadless(
        PROD_CTX,
        { apiName: 'acme', value: 'v', out: '/root/out.json' },
        NO_DEFAULTS,
        false,
        h.deps,
      ),
    ).resolves.toBeUndefined();
  });

  it('stringifies a non-Error --out failure', async () => {
    const h = harness({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      writeEnvelopeFile: () => Promise.reject('disk on fire'),
    });

    await runHeadless(
      PROD_CTX,
      { apiName: 'acme', value: 'v', out: '/tmp/out.json' },
      NO_DEFAULTS,
      false,
      h.deps,
    );

    expect(h.stderr).toContain('Error writing /tmp/out.json: disk on fire\n');
    expect(h.exitCodes).toEqual([1]);
  });
});
