import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
};

const statusOf = (current: string | undefined, bundled: string): ManagedFileStatus => {
  if (current === undefined) {
    return 'created';
  }

  return current === bundled ? 'unchanged' : 'updated';
};

export async function planManagedFiles(
  dir: string,
  files: readonly ScaffoldedFile[],
  fs: ManagedFs = nodeManagedFs,
): Promise<ManagedFilePlan[]> {
  return Promise.all(
    files.map(async (file) => ({
      path: file.path,
      status: statusOf(await fs.readFile(join(dir, file.path)), file.content),
    })),
  );
}

/** Writes every file that is missing or differs from its bundled content, unless `dryRun`. */
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
