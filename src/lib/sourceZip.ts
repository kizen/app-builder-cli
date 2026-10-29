import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import { unzipSync, zipSync, type UnzipFileInfo, type Zippable } from 'fflate';
import ignore, { type Ignore } from 'ignore';
import { MANIFEST_FILE_NAME } from '@kizenapps/packager';
import { MANAGED_SKILL_DIRS } from './agentHarness.js';
import { errorCause, isErrnoCode } from './guards.js';

const execFileAsync = promisify(execFile);

export const SOURCE_ZIP_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.kizenapp',
  '.kizenappbuilder',
  '.copilot-docs',
  '__pycache__',
  'dist',
]);

export const SOURCE_ZIP_SKIP_FILES: ReadonlySet<string> = new Set([
  '.DS_Store',
  '.env',
  '.npmrc',
  'credentials.json',
]);

export const KIZENIGNORE_FILE = '.kizenignore';

const SAFETY_NAMES: ReadonlySet<string> = new Set(
  [...SOURCE_ZIP_SKIP_DIRS, ...SOURCE_ZIP_SKIP_FILES].map((name) => name.toLowerCase()),
);

/** Windows strips trailing dots and spaces (`.git.` opens `.git`). 8.3 names aren't handled. */
const isSafetySegment = (segment: string): boolean => {
  const name = segment.toLowerCase().replace(/[. ]+$/, '');

  return SAFETY_NAMES.has(name) || name.startsWith('.env.');
};

const foldSegment = (segment: string): string => segment.toLowerCase().replace(/[. ]+$/, '');

const MANAGED_SKILL_SEGMENTS: readonly string[][] = MANAGED_SKILL_DIRS.map((dir) =>
  dir.split('/').map(foldSegment),
);

export const isManagedSkillPath = (path: string): boolean => {
  const segments = path.replace(/\/$/, '').split('/').map(foldSegment);

  return MANAGED_SKILL_SEGMENTS.some(
    (managed) =>
      segments.length >= managed.length &&
      managed.every((segment, index) => segments[index] === segment),
  );
};

export const isSafetyExcluded = (path: string): boolean =>
  path.replace(/\/$/, '').split('/').some(isSafetySegment) || isManagedSkillPath(path);

/** DOS timestamps are local time; 1980-01-01 is the earliest a zip can hold. */
const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0);

const GIT_TIMEOUT_MS = 15_000;

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

const GIT_ENV_KEPT: ReadonlySet<string> = new Set([
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);

export function gitChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('GIT_') || GIT_ENV_KEPT.has(key)),
  );
}

/** `ls-files` runs the repository's `core.fsmonitor` command. */
export const GIT_SAFE_ARGS: readonly string[] = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

interface ExecutableLookup {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isExecutable: (path: string) => boolean;
}

const defaultIsExecutable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }

    accessSync(path, fsConstants.X_OK);

    return true;
  } catch {
    return false;
  }
};

/** On Windows, spawning a bare name can run a program from the working directory. */
export function resolveExecutable(
  name: string,
  { env, platform, isExecutable }: ExecutableLookup,
): string | undefined {
  const isWindows = platform === 'win32';
  const pathApi = isWindows ? win32 : posix;
  const lookup = (key: string): string | undefined =>
    isWindows
      ? Object.entries(env).find(([candidate]) => candidate.toUpperCase() === key)?.[1]
      : env[key];
  const extensions = isWindows
    ? (lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
    : [''];

  for (const directory of (lookup('PATH') ?? '').split(pathApi.delimiter)) {
    if (directory === '' || !pathApi.isAbsolute(directory)) {
      continue;
    }

    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${name}${extension}`);

      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

let gitPath: string | null | undefined;

export function resolveGit(): string {
  gitPath ??=
    resolveExecutable('git', {
      env: process.env,
      platform: process.platform,
      isExecutable: defaultIsExecutable,
    }) ?? null;

  if (gitPath === null) {
    throw Object.assign(new Error('git was not found on PATH'), { code: 'ENOENT' });
  }

  return gitPath;
}

export const runGit: GitRunner = async (args, cwd) =>
  (
    await execFileAsync(resolveGit(), [...GIT_SAFE_ARGS, ...args], {
      cwd,
      env: gitChildEnv(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    })
  ).stdout;

export type SourceZipMode = 'git' | 'walk';

export interface SourceFileList {
  files: string[];
  mode: SourceZipMode;
  notice?: string;
}

export interface SourceZip extends SourceFileList {
  bytes: Uint8Array;
}

export interface SourceZipOptions {
  git?: GitRunner;
  limits?: { entryBytes: number; totalBytes: number };
}

const FALLBACK_SUFFIX = 'so the source zip honors only the root .gitignore and .kizenignore.';

function gitFailureNotice(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;

  if (code === 'ENOENT') {
    return `git isn't installed, ${FALLBACK_SUFFIX}`;
  }

  // git exits 128 for "not a git repository".
  if (code === 128) {
    return `Not in a git work tree, ${FALLBACK_SUFFIX}`;
  }

  return `Couldn't list files with git (${errorCause(err)}), ${FALLBACK_SUFFIX}`;
}

export class SourceZipIgnoredDirError extends Error {
  constructor() {
    super(
      'The enclosing git repository ignores this folder, so none of its files can be picked for the source zip. Nothing was uploaded.',
    );
    this.name = 'SourceZipIgnoredDirError';
  }
}

export class SourceZipMissingManifestError extends Error {
  readonly mode: SourceZipMode;

  constructor(mode: SourceZipMode) {
    super(
      `${MANIFEST_FILE_NAME} isn't among the files picked for the source zip. Check that .gitignore${mode === 'git' ? ' (or a git exclude)' : ''} or .kizenignore doesn't exclude it.`,
    );
    this.name = 'SourceZipMissingManifestError';
    this.mode = mode;
  }
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class SourceZipIgnoreUnreadableError extends Error {
  readonly file: string;

  constructor(file: string, cause: unknown) {
    super(
      `${file} exists but couldn't be read (${errorCause(cause)}), so the files it excludes can't be left out of the source zip. Nothing was uploaded; fix its permissions and try again.`,
      { cause },
    );
    this.name = 'SourceZipIgnoreUnreadableError';
    this.file = file;
  }
}

export async function readIgnoreFile(dir: string, name: string): Promise<Ignore | undefined> {
  let text: string;

  try {
    text = await readFile(join(dir, name), 'utf-8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return undefined;
    }

    throw new SourceZipIgnoreUnreadableError(name, error);
  }

  return ignore().add(text);
}

async function isPhysicalFile(
  dir: string,
  path: string,
  isDirectory: (relative: string) => Promise<boolean>,
): Promise<boolean> {
  const segments = path.split('/');

  for (let depth = 1; depth < segments.length; depth += 1) {
    if (!(await isDirectory(segments.slice(0, depth).join('/')))) {
      return false;
    }
  }

  try {
    return (await lstat(join(dir, ...segments))).isFile();
  } catch {
    return false;
  }
}

function directoryChecker(dir: string): (relative: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();

  return (relative) => {
    let answer = cache.get(relative);

    if (answer === undefined) {
      answer = lstat(join(dir, ...relative.split('/'))).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
      cache.set(relative, answer);
    }

    return answer;
  };
}

async function gitFiles(
  dir: string,
  git: GitRunner,
): Promise<{ files: string[] } | { notice: string } | { ignored: true }> {
  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree'], dir);

    if (inside.trim() !== 'true') {
      return { notice: `Not in a git work tree, ${FALLBACK_SUFFIX}` };
    }

    const listed = await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], dir);
    const unique = [...new Set(listed.split('\0'))].filter(isSafeEntryName);

    if (unique.length === 0) {
      return { ignored: true };
    }

    const isDirectory = directoryChecker(dir);
    const physical = await Promise.all(
      unique.map((path) => isPhysicalFile(dir, path, isDirectory)),
    );
    const files = unique.filter((_, index) => physical[index]);

    return { files };
  } catch (err) {
    return { notice: gitFailureNotice(err) };
  }
}

async function walkFiles(root: string, gitignore: Ignore | undefined): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const path = `${prefix}${entry.name}`;

      if (entry.isDirectory()) {
        if (!isSafetySegment(entry.name) && gitignore?.ignores(`${path}/`) !== true) {
          await walk(join(dir, entry.name), `${path}/`);
        }
      } else if (entry.isFile() && gitignore?.ignores(path) !== true) {
        out.push(path);
      }
    }
  };

  await walk(root, '');

  return out;
}

export async function collectSourceFiles(
  dir: string,
  opts: SourceZipOptions = {},
): Promise<SourceFileList> {
  const fromGit = await gitFiles(dir, opts.git ?? runGit);

  if ('ignored' in fromGit) {
    throw new SourceZipIgnoredDirError();
  }

  const kizenignore = await readIgnoreFile(dir, KIZENIGNORE_FILE);
  const listing: SourceFileList =
    'files' in fromGit
      ? { files: fromGit.files, mode: 'git' }
      : {
          files: await walkFiles(dir, await readIgnoreFile(dir, '.gitignore')),
          mode: 'walk',
          notice: fromGit.notice,
        };

  listing.files = listing.files
    .filter(
      (path) =>
        isSafeEntryName(path) && kizenignore?.ignores(path) !== true && !isSafetyExcluded(path),
    )
    .sort(byCodeUnit);

  if (!listing.files.includes(MANIFEST_FILE_NAME)) {
    throw new SourceZipMissingManifestError(listing.mode);
  }

  return listing;
}

export class SourceZipTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceZipTooLargeError';
  }
}

async function assertWithinReadLimits(
  dir: string,
  files: readonly string[],
  limits: { entryBytes: number; totalBytes: number },
): Promise<void> {
  let total = 0;

  for (const path of files) {
    const { size } = await lstat(join(dir, ...path.split('/')));

    if (size > limits.entryBytes) {
      throw new SourceZipTooLargeError(
        `${path} is ${String(size)} bytes, over the ${String(limits.entryBytes)}-byte limit for one file in an app's source. Exclude it with .kizenignore.`,
      );
    }

    total += size;

    if (total > limits.totalBytes) {
      throw new SourceZipTooLargeError(
        `The app's source is over the ${String(limits.totalBytes)}-byte limit. Exclude large files with .kizenignore.`,
      );
    }
  }
}

export async function zipSourceDir(dir: string, opts: SourceZipOptions = {}): Promise<SourceZip> {
  const listing = await collectSourceFiles(dir, opts);

  await assertWithinReadLimits(
    dir,
    listing.files,
    opts.limits ?? { entryBytes: MAX_ZIP_ENTRY_BYTES, totalBytes: MAX_ZIP_TOTAL_BYTES },
  );

  const contents = await Promise.all(
    listing.files.map((path) => readFile(join(dir, ...path.split('/')))),
  );
  const zippable: Zippable = {};

  listing.files.forEach((path, index) => {
    zippable[path] = [new Uint8Array(contents[index] as Buffer), { mtime: FIXED_MTIME }];
  });

  return { ...listing, bytes: zipSync(zippable, { level: 6, mtime: FIXED_MTIME }) };
}

export class UnsafeZipEntryError extends Error {
  readonly entry: string;

  constructor(entry: string, reason = 'is unsafe') {
    super(`The source zip entry "${entry}" ${reason}; nothing was extracted.`);
    this.name = 'UnsafeZipEntryError';
    this.entry = entry;
  }
}

export class ZipDestinationExistsError extends Error {
  readonly destination: string;

  constructor(destination: string) {
    super(`${destination} already exists; the source zip is only extracted into a new directory.`);
    this.name = 'ZipDestinationExistsError';
    this.destination = destination;
  }
}

export function isSafeEntryName(name: string): boolean {
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');

  return !(
    name === '' ||
    name.includes('\\') ||
    name.includes('\0') ||
    isAbsolute(name) ||
    /^[A-Za-z]:/.test(name) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

function assertSafeEntryName(name: string): void {
  if (!isSafeEntryName(name)) {
    throw new UnsafeZipEntryError(name);
  }
}

export const foldPath = (path: string): string => path.normalize('NFC').toLowerCase();

function assertNoCollisions(names: readonly string[]): void {
  const files = new Map<string, string>();
  const directories = new Map<string, string>();

  for (const name of names) {
    const isDirectory = name.endsWith('/');
    const path = foldPath(isDirectory ? name.slice(0, -1) : name);
    const segments = path.split('/');

    if (files.has(path) || (!isDirectory && directories.has(path))) {
      throw new UnsafeZipEntryError(name, 'collides with another entry');
    }

    (isDirectory ? directories : files).set(path, name);

    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.set(segments.slice(0, depth).join('/'), name);
    }
  }

  for (const [path, name] of files) {
    if (directories.has(path)) {
      throw new UnsafeZipEntryError(name, 'is a file where another entry needs a directory');
    }
  }
}

export interface ZipEntries {
  files: Map<string, Uint8Array>;
  skipped: string[];
}

export const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024;

export class ZipLimitError extends Error {
  readonly entry: string | undefined;

  constructor(message: string, entry?: string) {
    super(message);
    this.name = 'ZipLimitError';
    this.entry = entry;
  }
}

const readU16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

const readU32 = (bytes: Uint8Array, at: number): number =>
  (readU16(bytes, at) | (readU16(bytes, at + 2) << 16)) >>> 0;

function centralDirectoryCrcs(bytes: Uint8Array): number[] {
  let end = bytes.length - 22;

  while (end >= 0 && readU32(bytes, end) !== 0x06054b50) {
    end -= 1;
  }

  if (end < 0) {
    throw new ZipLimitError("The source zip isn't a valid zip file; nothing was extracted.");
  }

  if (end >= 20 && readU32(bytes, end - 20) === 0x07064b50) {
    throw new ZipLimitError(
      'The source zip uses ZIP64, which a source zip never needs; nothing was extracted.',
    );
  }

  const crcs: number[] = [];
  let offset = readU32(bytes, end + 16);

  for (let index = readU16(bytes, end + 8); index > 0; index -= 1) {
    if (readU32(bytes, offset) !== 0x02014b50) {
      throw new ZipLimitError("The source zip isn't a valid zip file; nothing was extracted.");
    }

    crcs.push(readU32(bytes, offset + 16));
    offset +=
      46 + readU16(bytes, offset + 28) + readU16(bytes, offset + 30) + readU16(bytes, offset + 32);
  }

  return crcs;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }

  return crc >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function readZipEntries(bytes: Uint8Array): ZipEntries {
  const crcs = centralDirectoryCrcs(bytes);
  const infos: UnzipFileInfo[] = [];

  // First pass: headers only; the filter declines everything.
  unzipSync(bytes, {
    filter: (info) => {
      infos.push(info);

      return false;
    },
  });

  if (infos.length !== crcs.length) {
    throw new ZipLimitError("The source zip isn't a valid zip file; nothing was extracted.");
  }

  const names = infos.map((info) => info.name);

  names.forEach(assertSafeEntryName);
  assertNoCollisions(names);

  const skipped: string[] = [];
  const kept = new Map<number, UnzipFileInfo>();
  let total = 0;

  infos.forEach((info, index) => {
    if (info.name.endsWith('/')) {
      return;
    }

    if (isSafetyExcluded(info.name)) {
      skipped.push(info.name);

      return;
    }

    if (info.originalSize > MAX_ZIP_ENTRY_BYTES) {
      throw new ZipLimitError(
        `The source zip entry "${info.name}" expands to ${String(info.originalSize)} bytes, over the ${String(MAX_ZIP_ENTRY_BYTES)}-byte limit; nothing was extracted.`,
        info.name,
      );
    }

    total += info.originalSize;

    if (total > MAX_ZIP_TOTAL_BYTES) {
      throw new ZipLimitError(
        `The source zip expands to more than ${String(MAX_ZIP_TOTAL_BYTES)} bytes; nothing was extracted.`,
      );
    }

    kept.set(index, info);
  });

  let position = 0;
  const entries = unzipSync(bytes, { filter: () => kept.has(position++) });
  const files = new Map<string, Uint8Array>();

  for (const [index, info] of kept) {
    const data = entries[info.name];

    if (data?.length !== info.originalSize || crc32(data) !== crcs[index]) {
      throw new UnsafeZipEntryError(info.name, "doesn't match its recorded size or checksum");
    }

    files.set(info.name, data);
  }

  const listed = skipped.filter((name) => name !== SOURCE_LINEAGE_PATH).sort(byCodeUnit);

  return { files: new Map([...files].sort(([a], [b]) => byCodeUnit(a, b))), skipped: listed };
}

export const SOURCE_LINEAGE_PATH = '.kizenapp/lineage.json';

export const SOURCE_LINEAGE_FORMAT = 1;

const MAX_LINEAGE_BYTES = 4096;

export type SourceLineage =
  | { baseLiveVersion: null; baseSourcePackageId: null }
  | { baseLiveVersion: string; baseSourcePackageId: string };

const isReleaseNumber = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d*$/.test(value);

function lineageOf(value: unknown): SourceLineage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const base = record.baseLiveVersion;
  const packageId = record.baseSourcePackageId;

  if (record.format !== SOURCE_LINEAGE_FORMAT) {
    return null;
  }

  if (base === null && packageId === null) {
    return { baseLiveVersion: null, baseSourcePackageId: null };
  }

  return isReleaseNumber(base) && typeof packageId === 'string' && packageId !== ''
    ? { baseLiveVersion: base, baseSourcePackageId: packageId }
    : null;
}

export function readSourceLineage(bytes: Uint8Array): SourceLineage | null {
  try {
    let declared = -1;
    const entries = unzipSync(bytes, {
      filter: (info) => {
        if (info.name !== SOURCE_LINEAGE_PATH || info.originalSize > MAX_LINEAGE_BYTES) {
          return false;
        }

        declared = info.originalSize;

        return true;
      },
    });
    const data = entries[SOURCE_LINEAGE_PATH];

    if (data?.length !== declared) {
      return null;
    }

    return lineageOf(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
  } catch {
    return null;
  }
}

export function withSourceLineage(bytes: Uint8Array, lineage: SourceLineage): Uint8Array {
  const { files } = readZipEntries(bytes);
  const zippable: Zippable = {};

  for (const [path, data] of files) {
    zippable[path] = [data, { mtime: FIXED_MTIME }];
  }

  const record = { format: SOURCE_LINEAGE_FORMAT, ...lineage };

  zippable[SOURCE_LINEAGE_PATH] = [
    new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
    { mtime: FIXED_MTIME },
  ];

  return zipSync(zippable, { level: 6, mtime: FIXED_MTIME });
}

export interface UnzipResult {
  written: string[];
  skipped: string[];
}

export async function unzipToDir(bytes: Uint8Array, destDir: string): Promise<UnzipResult> {
  const root = resolve(destDir);
  const { files, skipped } = readZipEntries(bytes);
  const targets: [string, string, Uint8Array][] = [];

  for (const [name, data] of files) {
    const target = resolve(root, ...name.split('/'));

    if (!target.startsWith(root + sep)) {
      throw new UnsafeZipEntryError(name);
    }

    targets.push([name, target, data]);
  }

  await mkdir(dirname(root), { recursive: true });

  try {
    await mkdir(root);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'EEXIST') {
      throw new ZipDestinationExistsError(destDir);
    }

    throw err;
  }

  for (const [, target, data] of targets) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }

  return { written: targets.map(([name]) => name), skipped };
}
