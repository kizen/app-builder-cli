/**
 * The private venv `appbuilder admin` runs the Python `kizen` CLI from, so nobody has to install
 * kizen themselves: one venv per pinned kizen-builder wheel, under
 * `~/.kizenappbuilder/kizen/<version>-<sha256[0:12]>/`.
 *
 *   kizen/
 *     <version>-<sha12>/            a published venv; ready once `.appbuilder-ready.json` names its sha
 *     .tmp-<version>-<sha12>-…/     a build in progress: `venv/` plus the downloaded wheel
 *
 * A venv is built in a `.tmp-` sibling, gets its marker last, and is published with one atomic
 * rename, so a half-built venv is never at the published path with a marker. Nothing is locked:
 * two first runs both build, the first rename wins and the other discards its copy. Nothing ever
 * moves or deletes a published venv except `appbuilder admin init --force`: a rename can't
 * replace a non-empty directory, so publishing is race-free without a lock. A venv at the path
 * that isn't ready (no code path here leaves one) is reported as damaged, for `--force` to fix.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { GLOBAL_CREDENTIALS_DIR } from './credentials.js';
import { errorCause, errorMessage, isErrnoCode, isRecord } from './guards.js';
import { findPython, formatVersion, type FoundPython, type PythonVersion } from './pythonProbe.js';

export interface KizenPin {
  version: string;
  wheelUrl: string;
  sha256: string;
}

/** The URL `.github/workflows/release.yml` in kizen-admin-cli attaches a release's wheel at. */
export const kizenWheelUrl = (version: string): string =>
  `https://github.com/kizen/kizen-admin-cli/releases/download/v${version}/kizen_builder-${version}-py3-none-any.whl`;

// To bump: new tag, then the wheel's sha256 from the GitHub release digest, confirmed by shasum.
export const KIZEN_PIN: KizenPin = {
  version: '0.3.0',
  wheelUrl: kizenWheelUrl('0.3.0'),
  sha256: '9f2017dd43bdc4554b655c87e25d1b5c754b04e0b8a32f1ed7516e30b9edf2d7',
};

/** Dev override: a local wheel to install instead of the pinned release. */
export const LOCAL_WHEEL_ENV = 'APPBUILDER_KIZEN_WHEEL';

export const KIZEN_VENVS_DIR = join(GLOBAL_CREDENTIALS_DIR, 'kizen');
export const READY_MARKER = '.appbuilder-ready.json';

/** kizen-builder's `requires-python`. No upper cap: any newer Python is fine. */
export const KIZEN_MIN_PYTHON: PythonVersion = [3, 12];
/** Probed in this order; the newest one that meets the minimum wins. */
export const KIZEN_PYTHON_CANDIDATES: readonly string[] = [
  'python3.14',
  'python3.13',
  'python3.12',
  'python3',
];

/** Another version's venv is removed once its marker hasn't been touched for this long. */
export const VENV_MAX_IDLE_MS = 30 * 24 * 60 * 60_000;
/** A `.tmp-` directory is removed once it's older than this. */
export const SCRATCH_MAX_AGE_MS = 60 * 60_000;
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** `<version>-<sha12>`: only directories with this shape are ever pruned as venvs. */
const VENV_DIR_NAME = /^[0-9][\w.+!]*-[0-9a-f]{12}$/;
const WHEEL_VERSION = /^kizen_builder-([^-]+)-.*\.whl$/;

export interface KizenInstall {
  version: string;
  dir: string;
  python: string;
  kizen: string;
  /** Whether this call built it; false when a ready venv was reused. */
  built: boolean;
}

export interface KizenVenvDeps {
  baseDir: string;
  pin: KizenPin;
  /** `APPBUILDER_KIZEN_WHEEL`, if set. */
  localWheel: string | undefined;
  fetch: typeof fetch;
  /** A Python new enough for kizen; throws when there's none. */
  findPython: () => Promise<FoundPython>;
  /** Runs a command to completion; rejects with a one-line error when it fails. */
  run: (bin: string, args: string[]) => Promise<void>;
  /** One progress line, for stderr. */
  log: (line: string) => void;
  now: () => number;
}

/** The newest Python ≥ 3.12 among `KIZEN_PYTHON_CANDIDATES`. */
export async function findKizenPython(
  probe?: (bin: string) => Promise<PythonVersion | null>,
): Promise<FoundPython> {
  const { found, tried } = await findPython(
    KIZEN_PYTHON_CANDIDATES,
    KIZEN_MIN_PYTHON,
    'newest',
    probe,
  );

  if (found === undefined) {
    throw new Error(
      `No Python ${formatVersion(KIZEN_MIN_PYTHON)} or newer found to run kizen. ` +
        `Tried ${tried.join(', ')}. Install Python ${formatVersion(KIZEN_MIN_PYTHON)} or newer and retry.`,
    );
  }

  return found;
}

/** Keeps the last lines a failed command printed, so its error can be shown. */
const OUTPUT_TAIL_LINES = 20;

/**
 * Runs `bin args` with its output captured. On failure the captured output's tail goes to
 * `writeStderr` and the promise rejects with one line.
 */
export const runQuietly =
  (writeStderr: (text: string) => void) =>
  (bin: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = (chunk: Buffer): void => {
        output += chunk.toString('utf-8');
      };

      proc.stdout.on('data', collect);
      proc.stderr.on('data', collect);
      proc.on('error', (error) => {
        reject(new Error(`couldn't run ${bin}: ${error.message}`));
      });
      proc.on('close', (code, signal) => {
        if (code === 0) {
          resolve();

          return;
        }

        const tail = output.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');

        if (tail !== '') {
          writeStderr(`${tail}\n`);
        }

        reject(
          new Error(
            `${basename(bin)} exited with ${code === null ? String(signal) : `code ${String(code)}`}`,
          ),
        );
      });
    });

export function createDefaultKizenVenvDeps(
  log: (line: string) => void,
  writeStderr: (text: string) => void,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): KizenVenvDeps {
  const localWheel = processEnv[LOCAL_WHEEL_ENV];

  return {
    baseDir: KIZEN_VENVS_DIR,
    pin: KIZEN_PIN,
    localWheel: localWheel === '' ? undefined : localWheel,
    fetch: (...args) => fetch(...args),
    findPython: () => findKizenPython(),
    run: runQuietly(writeStderr),
    log,
    now: Date.now,
  };
}

const sha256OfFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256');

  await pipeline(createReadStream(path), hash);

  return hash.digest('hex');
};

const markerPath = (dir: string): string => join(dir, READY_MARKER);
const venvBin = (dir: string, name: string): string => join(dir, 'bin', name);

/** Ready: the marker names `sha256`, and both `bin/python` and `bin/kizen` exist. */
export async function isReadyVenv(dir: string, sha256: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(markerPath(dir), 'utf-8')) as unknown;

    if (!isRecord(marker) || marker.sha256 !== sha256) {
      return false;
    }

    await access(venvBin(dir, 'python'));
    await access(venvBin(dir, 'kizen'));

    return true;
  } catch {
    return false;
  }
}

/** Records a use of the venv in its marker's mtime, which pruning reads. Best-effort. */
async function touchMarker(dir: string, now: number): Promise<void> {
  const time = new Date(now);

  await utimes(markerPath(dir), time, time).catch(() => undefined);
}

interface WheelSource {
  version: string;
  sha256: string;
  /** A local file, or undefined to download `pin.wheelUrl`. */
  localPath: string | undefined;
}

async function wheelSource(deps: KizenVenvDeps): Promise<WheelSource> {
  if (deps.localWheel !== undefined) {
    const path = deps.localWheel;
    const version = WHEEL_VERSION.exec(basename(path))?.[1];

    if (version === undefined) {
      throw new Error(
        `${LOCAL_WHEEL_ENV} must name a kizen_builder wheel (kizen_builder-<version>-….whl), not ${path}.`,
      );
    }

    let sha256: string;

    try {
      sha256 = await sha256OfFile(path);
    } catch (error) {
      throw new Error(`Couldn't read ${LOCAL_WHEEL_ENV} ${path}: ${errorCause(error)}`);
    }

    return { version, sha256, localPath: path };
  }

  return { version: deps.pin.version, sha256: deps.pin.sha256, localPath: undefined };
}

/** Streams `url` to `dest`, hashing as it goes; returns the sha256. */
async function download(deps: KizenVenvDeps, url: string, dest: string): Promise<string> {
  const hash = createHash('sha256');

  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

    if (!res.ok || res.body === null) {
      throw new Error(`HTTP ${String(res.status)}`);
    }

    await pipeline(
      Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(dest),
    );
  } catch (error) {
    throw new Error(`Couldn't download kizen from ${url}: ${errorCause(error)}`);
  }

  return hash.digest('hex');
}

const scratchName = (venvName: string): string =>
  `.tmp-${venvName}-${String(process.pid)}-${randomBytes(4).toString('hex')}`;

/**
 * Removes what this code created and nobody is using: other versions' venvs whose marker (or, with
 * none, the directory) hasn't been touched for 30 days, and `.tmp-` directories older than an hour.
 * Best-effort: every failure is ignored.
 */
export async function pruneKizenVenvs(baseDir: string, keep: string, now: number): Promise<void> {
  let entries: string[];

  try {
    entries = await readdir(baseDir);
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (name) => {
      if (name === keep) {
        return;
      }

      const path = join(baseDir, name);

      try {
        if (VENV_DIR_NAME.test(name)) {
          const { mtimeMs } = await stat(markerPath(path)).catch(() => stat(path));

          if (now - mtimeMs > VENV_MAX_IDLE_MS) {
            await rm(path, { recursive: true, force: true });
          }
        } else if (name.startsWith('.tmp-')) {
          const { mtimeMs } = await stat(path);

          if (now - mtimeMs > SCRATCH_MAX_AGE_MS) {
            await rm(path, { recursive: true, force: true });
          }
        }
      } catch {
        // Best-effort.
      }
    }),
  );
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const damaged = (target: string): Error =>
  new Error(
    `kizen's install at ${target} is damaged. Run \`appbuilder admin init --force\` to reinstall it.`,
  );

/**
 * Moves the venv at `built` to `target`; returns whether `built` is the one published. A taken
 * `target` is never touched: a ready one means a concurrent build won and `built` is discarded,
 * anything else is reported as damaged.
 */
async function publish(built: string, target: string, sha256: string): Promise<boolean> {
  try {
    await rename(built, target);

    return true;
  } catch (error) {
    if (!isErrnoCode(error, 'ENOTEMPTY') && !isErrnoCode(error, 'EEXIST')) {
      throw error;
    }
  }

  if (await isReadyVenv(target, sha256)) {
    return false;
  }

  throw damaged(target);
}

/**
 * The kizen venv for the pinned wheel (or `APPBUILDER_KIZEN_WHEEL`), built on first use. A ready
 * venv is reused without network, probing or subprocesses. Used by `admin init` and by every
 * `admin` run.
 */
export async function ensureKizen(
  deps: KizenVenvDeps,
  options: { force?: boolean } = {},
): Promise<KizenInstall> {
  const source = await wheelSource(deps);
  const venvName = `${source.version}-${source.sha256.slice(0, 12)}`;
  const target = join(deps.baseDir, venvName);
  const install = (built: boolean): KizenInstall => ({
    version: source.version,
    dir: target,
    python: venvBin(target, 'python'),
    kizen: venvBin(target, 'kizen'),
    built,
  });

  if (options.force === true) {
    // User-initiated (`admin init --force`), and documented as not for while kizen runs.
    deps.log(`Removing ${target}.`);

    await rm(target, { recursive: true, force: true });
  } else if (await isReadyVenv(target, source.sha256)) {
    await touchMarker(target, deps.now());

    return install(false);
  } else if (await exists(target)) {
    // A concurrent run may have published between the two checks; a ready venv only becomes
    // unready through --force, so one re-check settles it.
    if (await isReadyVenv(target, source.sha256)) {
      await touchMarker(target, deps.now());

      return install(false);
    }

    // Not something this code leaves behind, so not something it should guess how to replace.
    throw damaged(target);
  }

  deps.log(`Installing kizen ${source.version} into ${target} (first run only).`);

  const python = await deps.findPython();

  deps.log(`Using ${python.bin} (Python ${formatVersion(python.version)}).`);

  await mkdir(deps.baseDir, { recursive: true, mode: 0o700 });

  const scratch = join(deps.baseDir, scratchName(venvName));
  const venv = join(scratch, 'venv');
  let published: boolean;

  try {
    await mkdir(scratch);

    let wheel: string;

    if (source.localPath === undefined) {
      wheel = join(scratch, basename(new URL(deps.pin.wheelUrl).pathname));

      deps.log(`Downloading ${deps.pin.wheelUrl}`);

      const actual = await download(deps, deps.pin.wheelUrl, wheel);

      if (actual !== source.sha256) {
        await rm(wheel, { force: true });

        throw new Error(
          `The kizen ${source.version} download doesn't match its pinned sha256 ` +
            `(expected ${source.sha256}, got ${actual}), so nothing was installed.`,
        );
      }
    } else {
      wheel = source.localPath;

      deps.log(`Using the local wheel ${wheel} (${LOCAL_WHEEL_ENV}).`);
    }

    deps.log('Creating a virtual environment.');

    try {
      await deps.run(python.bin, ['-m', 'venv', venv]);
    } catch (error) {
      throw new Error(`Couldn't create a virtual environment: ${errorMessage(error)}`);
    }

    deps.log(`Installing kizen ${source.version} from the wheel and its dependencies from PyPI.`);

    try {
      await deps.run(venvBin(venv, 'python'), [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        wheel,
      ]);
    } catch (error) {
      throw new Error(`Couldn't install kizen: ${errorMessage(error)}`);
    }

    await writeFile(
      markerPath(venv),
      `${JSON.stringify({ version: source.version, sha256: source.sha256 }, null, 2)}\n`,
    );

    published = await publish(venv, target, source.sha256);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }

  const now = deps.now();

  await touchMarker(target, now);

  if (published) {
    deps.log(`kizen ${source.version} is installed.`);

    await pruneKizenVenvs(deps.baseDir, venvName, now);
  }

  return install(published);
}
