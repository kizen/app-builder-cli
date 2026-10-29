import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { ScaffoldedFile } from './createArtifacts.js';
import { isMissingFileError } from './guards.js';

export type ManagedFileStatus = 'created' | 'updated' | 'unchanged';

export interface ManagedFilePlan {
  path: string;
  status: ManagedFileStatus;
}

export interface ManagedFs {
  readFile: (path: string) => Promise<string | undefined>;
  writeFile: (path: string, content: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  /**
   * Throws `UnsafeManagedPathError` unless writing `path` (relative, `/`-separated) under `dir`
   * would write a regular file inside `dir`: no symlink at any level, a directory at every level
   * that exists, and a regular file (or nothing) at the path itself.
   */
  checkPath: (dir: string, path: string) => Promise<void>;
}

/**
 * A managed file can't be written safely: a symlink on the way (which would send the write
 * outside the plugin), or something other than a directory or regular file in the way.
 */
export class UnsafeManagedPathError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(
      `Refusing to write ${path}: ${detail}. appbuilder writes its managed files only as regular files inside the plugin folder, so nothing was written. Remove or replace it, then run this command again.`,
    );
    this.name = 'UnsafeManagedPathError';
  }
}

const isInsideDir = (root: string, target: string): boolean =>
  target === root || target.startsWith(root + sep);

async function checkManagedPath(dir: string, path: string): Promise<void> {
  const segments = path.split('/');

  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new UnsafeManagedPathError(path, 'it is not a plain relative path');
  }

  const root = await realpath(dir);
  let current = dir;

  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);

    const shown = segments.slice(0, index + 1).join('/');
    let stats: Awaited<ReturnType<typeof lstat>>;

    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingFileError(error)) {
        // Everything from here down is created by mkdir and writeFile, inside what was checked.
        return;
      }

      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new UnsafeManagedPathError(path, `${shown} is a symbolic link`);
    }

    const last = index === segments.length - 1;

    if (last ? !stats.isFile() : !stats.isDirectory()) {
      throw new UnsafeManagedPathError(
        path,
        `${shown} is not a ${last ? 'regular file' : 'directory'}`,
      );
    }
  }

  // No symlink below `dir`, so this holds; checked anyway in case `dir` itself moved.
  if (!isInsideDir(root, await realpath(current))) {
    throw new UnsafeManagedPathError(path, 'it resolves outside the plugin folder');
  }
}

export const nodeManagedFs: ManagedFs = {
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf-8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }

      throw error;
    }
  },
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  },
  exists: async (path) => {
    try {
      await access(path);

      return true;
    } catch {
      return false;
    }
  },
  checkPath: checkManagedPath,
};

const statusOf = (current: string | undefined, bundled: string): ManagedFileStatus => {
  if (current === undefined) {
    return 'created';
  }

  return current === bundled ? 'unchanged' : 'updated';
};

/**
 * Each file's status against what's on disk. Throws `UnsafeManagedPathError` before reading
 * anything when any file's path is unsafe to write (`ManagedFs.checkPath`), so neither a plan nor
 * an apply follows a symlink out of the plugin.
 */
export async function planManagedFiles(
  dir: string,
  files: readonly ScaffoldedFile[],
  fs: ManagedFs = nodeManagedFs,
): Promise<ManagedFilePlan[]> {
  // One at a time, in file order, so a refusal always names the first unsafe path.
  for (const file of files) {
    await fs.checkPath(dir, file.path);
  }

  return Promise.all(
    files.map(async (file) => ({
      path: file.path,
      status: statusOf(await fs.readFile(join(dir, file.path)), file.content),
    })),
  );
}

/**
 * Writes every file that is missing or differs from its bundled content, unless `dryRun`. Every
 * path is checked (`planManagedFiles`) before the first write, so an unsafe one writes nothing.
 */
export async function applyManagedFiles(
  dir: string,
  files: readonly ScaffoldedFile[],
  options: { dryRun?: boolean } = {},
  fs: ManagedFs = nodeManagedFs,
): Promise<ManagedFilePlan[]> {
  const plan = await planManagedFiles(dir, files, fs);

  if (options.dryRun === true) {
    return plan;
  }

  await Promise.all(
    files
      .filter((_file, index) => plan[index]?.status !== 'unchanged')
      .map((file) => fs.writeFile(join(dir, file.path), file.content)),
  );

  return plan;
}

export const formatManagedFileLine = (plan: ManagedFilePlan): string =>
  `${plan.status.padEnd(9)} ${plan.path}`;
