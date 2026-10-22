import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as FsPromisesModule from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { runAdminInit, type AdminDeps } from './kizenAdmin.js';
import {
  ensureKizen,
  isReadyVenv,
  KIZEN_PIN,
  kizenWheelUrl,
  READY_MARKER,
  SCRATCH_MAX_AGE_MS,
  VENV_MAX_IDLE_MS,
  type KizenPin,
  type KizenVenvDeps,
} from './kizenVenv.js';

/** Runs once, just before `stat` of the path it names: lets a test act between two fs checks. */
const hooks = vi.hoisted(() => ({
  beforeStat: undefined as { path: string; run: () => Promise<void> } | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromisesModule>();
  const stat = async (...args: Parameters<typeof fs.stat>): Promise<unknown> => {
    const hook = hooks.beforeStat;

    if (args[0] === hook?.path) {
      hooks.beforeStat = undefined;
      await hook.run();
    }

    return fs.stat(...args);
  };

  return { ...fs, stat, default: { ...fs, stat } };
});

afterEach(() => {
  hooks.beforeStat = undefined;
});

const WHEEL_BYTES = Buffer.from('not really a wheel');
const WHEEL_SHA = createHash('sha256').update(WHEEL_BYTES).digest('hex');
const PIN: KizenPin = { version: '1.2.3', wheelUrl: kizenWheelUrl('1.2.3'), sha256: WHEEL_SHA };
const VENV_NAME = `1.2.3-${WHEEL_SHA.slice(0, 12)}`;
const DAY_MS = 24 * 60 * 60_000;

let baseDir: string;

beforeEach(async () => {
  baseDir = join(await mkdtemp(join(tmpdir(), 'appbuilder-kizen-venv-')), 'kizen');
});

afterEach(async () => {
  await rm(dirname(baseDir), { recursive: true, force: true });
});

/**
 * A fake `run`: `-m venv <dir>` creates `<dir>/bin/python`; `<venv>/bin/python -m pip install`
 * creates `<venv>/bin/kizen`. `fail` makes one of the two steps reject.
 */
type FakeRun = Mock<(bin: string, args: string[]) => Promise<void>>;

function fakeRun(
  options: { fail?: 'venv' | 'pip'; beforePip?: () => Promise<void> } = {},
): FakeRun {
  return vi.fn(async (bin: string, args: string[]): Promise<void> => {
    if (args[1] === 'venv') {
      if (options.fail === 'venv') {
        throw new Error('python3.14 exited with code 1');
      }

      const dir = args[2] ?? '';

      await mkdir(join(dir, 'bin'), { recursive: true });
      await writeFile(join(dir, 'bin', 'python'), '');

      return;
    }

    await options.beforePip?.();

    if (options.fail === 'pip') {
      throw new Error('python exited with code 1');
    }

    await writeFile(join(dirname(bin), 'kizen'), '#!/tmp/.tmp-build/venv/bin/python\n');
  });
}

interface FakeVenvDeps extends KizenVenvDeps {
  fetch: Mock<typeof fetch>;
  findPython: Mock<KizenVenvDeps['findPython']>;
  run: FakeRun;
}

function deps(overrides: Partial<KizenVenvDeps> = {}): FakeVenvDeps {
  return {
    baseDir,
    pin: PIN,
    localWheel: undefined,
    fetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response(WHEEL_BYTES))),
    findPython: vi.fn<KizenVenvDeps['findPython']>(() =>
      Promise.resolve({ bin: 'python3.14', version: [3, 14] }),
    ),
    run: fakeRun(),
    log: vi.fn(),
    now: Date.now,
    ...overrides,
  } as FakeVenvDeps;
}

const entries = async (): Promise<string[]> => (await readdir(baseDir)).sort();

describe('ensureKizen', () => {
  it('builds, marks and publishes the venv at <version>-<sha12>, running kizen through its python', async () => {
    const d = deps();
    const install = await ensureKizen(d);
    const target = join(baseDir, VENV_NAME);

    expect(install).toStrictEqual({
      version: '1.2.3',
      dir: target,
      python: join(target, 'bin', 'python'),
      kizen: join(target, 'bin', 'kizen'),
      built: true,
    });
    expect(await isReadyVenv(target, WHEEL_SHA)).toBe(true);
    expect(JSON.parse(await readFile(join(target, READY_MARKER), 'utf-8'))).toStrictEqual({
      version: '1.2.3',
      sha256: WHEEL_SHA,
    });
    expect(await entries()).toStrictEqual([VENV_NAME]);
    expect(d.fetch).toHaveBeenCalledWith(PIN.wheelUrl, expect.anything());

    const [venvCall, pipCall] = d.run.mock.calls as [string, string[]][];

    expect(venvCall?.[0]).toBe('python3.14');
    expect(venvCall?.[1].slice(0, 2)).toStrictEqual(['-m', 'venv']);
    expect(pipCall?.[1].slice(0, 4)).toStrictEqual([
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
    ]);
    expect(pipCall?.[1][4]).toMatch(/kizen_builder-1\.2\.3-py3-none-any\.whl$/);
  });

  it('(l) is idempotent: a ready venv is reused with no network, probing or subprocess', async () => {
    const d = deps();

    await ensureKizen(d);

    const second = await ensureKizen(d);

    expect(second.built).toBe(false);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.findPython).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledTimes(2);
  });

  it('(b) a sha256 mismatch aborts, deletes the download and leaves no ready venv', async () => {
    const d = deps({ pin: { ...PIN, sha256: 'f'.repeat(64) } });

    await expect(ensureKizen(d)).rejects.toThrow(
      `The kizen 1.2.3 download doesn't match its pinned sha256 (expected ${'f'.repeat(64)}, got ${WHEEL_SHA}), so nothing was installed.`,
    );
    expect(d.run).not.toHaveBeenCalled();
    // The scratch directory, wheel included, is gone, and nothing was published.
    expect(await entries()).toStrictEqual([]);
  });

  /** A venv at the target that isn't ready: no code path here leaves one, so it's damaged. */
  async function damagedTarget(marker?: object): Promise<string> {
    const target = join(baseDir, VENV_NAME);

    await mkdir(join(target, 'bin'), { recursive: true });
    await writeFile(join(target, 'bin', 'python'), '');
    await writeFile(join(target, 'bin', 'kizen'), '');
    await writeFile(join(target, 'sentinel'), '');

    if (marker !== undefined) {
      await writeFile(join(target, READY_MARKER), JSON.stringify(marker));
    }

    return target;
  }

  const DAMAGED = `kizen's install at ${join('<base>', VENV_NAME)} is damaged. Run \`appbuilder admin init --force\` to reinstall it.`;
  const damagedMessage = (): string => DAMAGED.replace('<base>', baseDir);

  it.each([
    ['no marker', undefined],
    ['a marker naming another sha', { version: '1.2.3', sha256: 'a'.repeat(64) }],
  ])(
    '(c) a damaged install (%s) is reported, naming --force, and left exactly as it is',
    async (_label, marker) => {
      const target = await damagedTarget(marker);
      const d = deps();

      await expect(ensureKizen(d)).rejects.toThrow(damagedMessage());
      expect(d.fetch).not.toHaveBeenCalled();
      expect(d.run).not.toHaveBeenCalled();
      expect(await readdir(target)).toContain('sentinel');
      expect(await entries()).toStrictEqual([VENV_NAME]);
    },
  );

  it('(c) --force rebuilds a damaged install', async () => {
    const target = await damagedTarget();
    const d = deps();
    const install = await ensureKizen(d, { force: true });

    expect(install.built).toBe(true);
    expect(await isReadyVenv(target, WHEEL_SHA)).toBe(true);
    expect(await readdir(target)).not.toContain('sentinel');
    expect(await entries()).toStrictEqual([VENV_NAME]);
  });

  it('--force rebuilds a ready install', async () => {
    const d = deps();

    await ensureKizen(d);

    const install = await ensureKizen(d, { force: true });

    expect(install.built).toBe(true);
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(d.run).toHaveBeenCalledTimes(4);
    expect(await isReadyVenv(install.dir, WHEEL_SHA)).toBe(true);
    expect(await entries()).toStrictEqual([VENV_NAME]);
  });

  it('(d) two concurrent first runs leave one ready venv and both succeed', async () => {
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothAtPip = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Both builds reach pip before either publishes, so their renames race.
    const run = fakeRun({
      beforePip: async () => {
        arrived += 1;

        if (arrived === 2) {
          release();
        }

        await bothAtPip;
      },
    });

    const [first, second] = await Promise.all([
      ensureKizen(deps({ run })),
      ensureKizen(deps({ run })),
    ]);

    expect(first.dir).toBe(second.dir);
    expect([first.built, second.built].sort()).toStrictEqual([false, true]);
    expect(run).toHaveBeenCalledTimes(4);
    expect(await isReadyVenv(first.dir, WHEEL_SHA)).toBe(true);
    expect(await entries()).toStrictEqual([VENV_NAME]);
  });

  it('pins kizen 0.3.0 at its GitHub release asset', () => {
    expect(KIZEN_PIN).toStrictEqual({
      version: '0.3.0',
      wheelUrl:
        'https://github.com/kizen/kizen-admin-cli/releases/download/v0.3.0/kizen_builder-0.3.0-py3-none-any.whl',
      sha256: '9f2017dd43bdc4554b655c87e25d1b5c754b04e0b8a32f1ed7516e30b9edf2d7',
    });
  });

  it('installs APPBUILDER_KIZEN_WHEEL without downloading, keyed by its own sha256 and filename version', async () => {
    const wheel = join(dirname(baseDir), 'kizen_builder-0.3.0.dev1-py3-none-any.whl');
    const bytes = Buffer.from('a local build');

    await writeFile(wheel, bytes);

    const sha = createHash('sha256').update(bytes).digest('hex');
    const d = deps({ pin: KIZEN_PIN, localWheel: wheel });
    const install = await ensureKizen(d);

    expect(install.version).toBe('0.3.0.dev1');
    expect(install.dir).toBe(join(baseDir, `0.3.0.dev1-${sha.slice(0, 12)}`));
    expect(d.fetch).not.toHaveBeenCalled();
    expect((d.run.mock.calls[1] as [string, string[]])[1][4]).toBe(wheel);
    expect(await isReadyVenv(install.dir, sha)).toBe(true);
  });

  it('refuses an APPBUILDER_KIZEN_WHEEL that is not named like a kizen_builder wheel', async () => {
    const wheel = join(dirname(baseDir), 'kizen.whl');

    await writeFile(wheel, 'x');

    await expect(ensureKizen(deps({ localWheel: wheel }))).rejects.toThrow(
      `APPBUILDER_KIZEN_WHEEL must name a kizen_builder wheel (kizen_builder-<version>-….whl), not ${wheel}.`,
    );
  });

  it('touches the marker each time a ready venv is used', async () => {
    await ensureKizen(deps());

    const marker = join(baseDir, VENV_NAME, READY_MARKER);
    const old = new Date(Date.now() - 10 * DAY_MS);

    await utimes(marker, old, old);
    await ensureKizen(deps());

    expect(Date.now() - (await stat(marker)).mtimeMs).toBeLessThan(DAY_MS);
  });
});

describe('publish', () => {
  const target = (): string => join(baseDir, VENV_NAME);

  /** Another run's ready venv, renamed into place as its publish does, with a file to tell it apart. */
  async function publishAnother(): Promise<void> {
    const dir = join(baseDir, '.tmp-another', 'venv');

    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'python'), '');
    await writeFile(join(dir, 'bin', 'kizen'), '');
    await writeFile(join(dir, 'theirs'), '');
    await writeFile(
      join(dir, READY_MARKER),
      JSON.stringify({ version: '1.2.3', sha256: WHEEL_SHA }),
    );
    await rename(dir, target());
    await rm(join(baseDir, '.tmp-another'), { recursive: true });
  }

  it('a ready target published during the build wins: built:false, target untouched', async () => {
    const d = deps({ run: fakeRun({ beforePip: publishAnother }) });
    const install = await ensureKizen(d);

    expect(install.built).toBe(false);
    expect(await readdir(target())).toContain('theirs');
    expect(await isReadyVenv(target(), WHEEL_SHA)).toBe(true);
    expect(await entries()).toStrictEqual([VENV_NAME]);
  });

  it('a ready venv published between the ready check and the exists check is used, not called damaged', async () => {
    // The ready check finds nothing; another run publishes just before the exists check.
    hooks.beforeStat = { path: target(), run: publishAnother };

    const d = deps();
    const install = await ensureKizen(d);

    expect(hooks.beforeStat).toBeUndefined();
    expect(install.built).toBe(false);
    expect(await readdir(target())).toContain('theirs');
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
  });

  it('a damaged target appearing during the build is reported and left alone', async () => {
    const d = deps({
      run: fakeRun({
        beforePip: async () => {
          await mkdir(join(target(), 'bin'), { recursive: true });
          await writeFile(join(target(), 'sentinel'), '');
        },
      }),
    });

    await expect(ensureKizen(d)).rejects.toThrow(
      `kizen's install at ${target()} is damaged. Run \`appbuilder admin init --force\` to reinstall it.`,
    );
    expect(await readdir(target())).toStrictEqual(['bin', 'sentinel']);
    expect(await entries()).toStrictEqual([VENV_NAME]);
  });

  it('creates the kizen directory private to the user', async () => {
    await ensureKizen(deps());

    expect((await stat(baseDir)).mode & 0o777).toBe(0o700);
  });
});

describe('(q) pruning after a publish', () => {
  async function venvSibling(name: string, ageMs: number, withMarker = true): Promise<string> {
    const dir = join(baseDir, name);
    const time = new Date(Date.now() - ageMs);

    await mkdir(join(dir, 'bin'), { recursive: true });

    if (withMarker) {
      await writeFile(join(dir, READY_MARKER), '{}');
      await utimes(join(dir, READY_MARKER), time, time);
    }

    await utimes(dir, time, time);

    return dir;
  }

  async function scratchSibling(name: string, ageMs: number): Promise<void> {
    const time = new Date(Date.now() - ageMs);

    await mkdir(join(baseDir, name), { recursive: true });
    await utimes(join(baseDir, name), time, time);
  }

  it('removes an old sibling and keeps one touched within 30 days', async () => {
    await mkdir(baseDir, { recursive: true });
    await venvSibling('0.1.0-aaaaaaaaaaaa', VENV_MAX_IDLE_MS + DAY_MS);
    await venvSibling('0.1.1-bbbbbbbbbbbb', VENV_MAX_IDLE_MS - DAY_MS);
    // The directory is old but its marker was touched recently: it's in use.
    await venvSibling('0.1.2-cccccccccccc', 1000);
    await utimes(
      join(baseDir, '0.1.2-cccccccccccc'),
      new Date(0),
      new Date(Date.now() - 2 * VENV_MAX_IDLE_MS),
    );
    await venvSibling('0.0.9-dddddddddddd', VENV_MAX_IDLE_MS + DAY_MS, false);
    await scratchSibling('.tmp-0.1.0-aaaaaaaaaaaa-1-old', SCRATCH_MAX_AGE_MS + 60_000);
    await scratchSibling('.tmp-0.1.0-aaaaaaaaaaaa-2-new', 60_000);
    // Not created by this code: never touched, however old.
    await scratchSibling('notes', VENV_MAX_IDLE_MS * 3);

    await ensureKizen(deps());

    expect(await entries()).toStrictEqual(
      [
        '.tmp-0.1.0-aaaaaaaaaaaa-2-new',
        '0.1.1-bbbbbbbbbbbb',
        '0.1.2-cccccccccccc',
        VENV_NAME,
        'notes',
      ].sort(),
    );
  });

  it('does not prune when a ready venv is reused', async () => {
    await ensureKizen(deps());
    await venvSibling('0.1.0-aaaaaaaaaaaa', VENV_MAX_IDLE_MS + DAY_MS);

    await ensureKizen(deps());

    expect(await entries()).toContain('0.1.0-aaaaaaaaaaaa');
  });
});

describe('(n) admin init failures exit 1 with their line', () => {
  function initDeps(venvDeps: KizenVenvDeps): {
    adminDeps: AdminDeps;
    stderr: string[];
    setExitCode: Mock<(code: number) => void>;
  } {
    const stderr: string[] = [];
    const setExitCode = vi.fn<(code: number) => void>();
    const adminDeps = {
      ensureKizen: (options?: { force?: boolean }) => ensureKizen(venvDeps, options),
      writeStderr: (text: string) => {
        stderr.push(text);
      },
      setExitCode,
    } as unknown as AdminDeps;

    return { adminDeps, stderr, setExitCode };
  }

  it.each<[string, Partial<KizenVenvDeps>, string]>([
    [
      'no Python',
      {
        findPython: () => Promise.reject(new Error('No Python 3.12 or newer found to run kizen.')),
      },
      'No Python 3.12 or newer found to run kizen.',
    ],
    [
      'an HTTP error',
      { fetch: () => Promise.resolve(new Response('missing', { status: 404 })) },
      `Couldn't download kizen from ${PIN.wheelUrl}: HTTP 404`,
    ],
    [
      'a network error',
      {
        fetch: () =>
          Promise.reject(
            Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
          ),
      },
      `Couldn't download kizen from ${PIN.wheelUrl}: ENOTFOUND`,
    ],
    [
      'a hash mismatch',
      { pin: { ...PIN, sha256: '0'.repeat(64) } },
      "doesn't match its pinned sha256",
    ],
    [
      'a venv failure',
      { run: fakeRun({ fail: 'venv' }) },
      "Couldn't create a virtual environment: python3.14 exited with code 1",
    ],
    [
      'a pip failure',
      { run: fakeRun({ fail: 'pip' }) },
      "Couldn't install kizen: python exited with code 1",
    ],
  ])('%s', async (_label, overrides, expected) => {
    const { adminDeps, stderr, setExitCode } = initDeps(deps(overrides));

    await runAdminInit(adminDeps);

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^appbuilder admin: .*\n$/);
    expect(stderr[0]).toContain(expected);
    // Whatever failed, nothing half-built is left published.
    expect(await isReadyVenv(join(baseDir, VENV_NAME), WHEEL_SHA)).toBe(false);
  });

  it('a damaged install, then init --force repairs it', async () => {
    await mkdir(join(baseDir, VENV_NAME, 'bin'), { recursive: true });

    const venvDeps = deps();
    const plain = initDeps(venvDeps);

    await runAdminInit(plain.adminDeps);

    expect(plain.setExitCode).toHaveBeenCalledWith(1);
    expect(plain.stderr).toStrictEqual([
      `appbuilder admin: kizen's install at ${join(baseDir, VENV_NAME)} is damaged. Run \`appbuilder admin init --force\` to reinstall it.\n`,
    ]);

    const forced = initDeps(venvDeps);

    await runAdminInit(forced.adminDeps, true);

    expect(forced.setExitCode).not.toHaveBeenCalled();
    expect(await isReadyVenv(join(baseDir, VENV_NAME), WHEEL_SHA)).toBe(true);
  });

  it('reports a ready venv on success, then again without rebuilding', async () => {
    const venvDeps = deps();
    const first = initDeps(venvDeps);

    await runAdminInit(first.adminDeps);

    const second = initDeps(venvDeps);

    await runAdminInit(second.adminDeps);

    const line = `appbuilder admin: kizen 1.2.3 is ready in ${join(baseDir, VENV_NAME)}.\n`;

    expect(first.stderr).toStrictEqual([line]);
    expect(second.stderr).toStrictEqual([line]);
    expect(first.setExitCode).not.toHaveBeenCalled();
    expect(venvDeps.fetch).toHaveBeenCalledTimes(1);
  });
});
