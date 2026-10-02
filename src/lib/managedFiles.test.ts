import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyManagedFiles,
  formatManagedFileLine,
  nodeManagedFs,
  planManagedFiles,
  type ManagedFs,
} from './managedFiles.js';

const FILES = [
  { path: 'missing.md', content: 'bundled missing\n' },
  { path: 'docs/edited.md', content: 'bundled edited\n' },
  { path: 'same.md', content: 'bundled same\n' },
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'managed-files-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content, 'utf-8');
};

const read = (path: string): Promise<string> => readFile(join(dir, path), 'utf-8');

/** One missing file, one edited locally, one matching its bundled content. */
const writeMixed = async (): Promise<void> => {
  await write('docs/edited.md', 'edited locally\n');
  await write('same.md', 'bundled same\n');
};

const MIXED_PLAN = [
  { path: 'missing.md', status: 'created' },
  { path: 'docs/edited.md', status: 'updated' },
  { path: 'same.md', status: 'unchanged' },
];

const spyFs = (): ManagedFs & { writeFile: ReturnType<typeof vi.fn> } => ({
  ...nodeManagedFs,
  writeFile: vi.fn(nodeManagedFs.writeFile),
});

describe('planManagedFiles', () => {
  it("planManagedFiles reports each file's status", async () => {
    await writeMixed();

    const fs = spyFs();

    expect(await planManagedFiles(dir, FILES, fs)).toStrictEqual(MIXED_PLAN);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('applyManagedFiles', () => {
  it('writes the bundled content of only the created and updated files', async () => {
    await writeMixed();

    const fs = spyFs();

    expect(await applyManagedFiles(dir, FILES, {}, fs)).toStrictEqual(MIXED_PLAN);
    expect(fs.writeFile.mock.calls.map((call) => String(call[0]))).toStrictEqual([
      join(dir, 'missing.md'),
      join(dir, 'docs/edited.md'),
    ]);
    expect(await read('missing.md')).toBe('bundled missing\n');
    expect(await read('docs/edited.md')).toBe('bundled edited\n');
    expect(await read('same.md')).toBe('bundled same\n');
  });

  it('applyManagedFiles dry run writes nothing', async () => {
    await writeMixed();

    const fs = spyFs();

    expect(await applyManagedFiles(dir, FILES, { dryRun: true }, fs)).toStrictEqual(MIXED_PLAN);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(await read('docs/edited.md')).toBe('edited locally\n');
    await expect(stat(join(dir, 'missing.md'))).rejects.toThrow();
  });

  it('applyManagedFiles creates nested parent directories', async () => {
    const files = [{ path: 'a/b/c/deep.md', content: 'deep\n' }];

    expect(await applyManagedFiles(dir, files)).toStrictEqual([
      { path: 'a/b/c/deep.md', status: 'created' },
    ]);
    expect(await read('a/b/c/deep.md')).toBe('deep\n');
  });
});

describe('nodeManagedFs', () => {
  it('reads a missing file as undefined and rethrows any other read error', async () => {
    await mkdir(join(dir, 'a-directory'));

    expect(await nodeManagedFs.readFile(join(dir, 'missing.md'))).toBeUndefined();
    await expect(nodeManagedFs.readFile(join(dir, 'a-directory'))).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });
});

describe('formatManagedFileLine', () => {
  it('formatManagedFileLine pads status to 9', () => {
    expect(formatManagedFileLine({ path: 'a.md', status: 'created' })).toBe('created   a.md');
    expect(formatManagedFileLine({ path: 'a.md', status: 'updated' })).toBe('updated   a.md');
    expect(formatManagedFileLine({ path: 'a.md', status: 'unchanged' })).toBe('unchanged a.md');
  });
});
