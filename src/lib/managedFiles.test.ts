import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyManagedFiles,
  formatManagedFileLine,
  nodeManagedFs,
  planManagedFiles,
  UnsafeManagedPathError,
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

describe('managed files never write outside the plugin', () => {
  let outside: string;

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'managed-outside-'));
    await writeFile(join(outside, 'victim.md'), 'outside\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  const SKILL = '.agents/skills/kizen-custom-block/SKILL.md';
  const files = [
    { path: 'first.md', content: 'bundled first\n' },
    { path: SKILL, content: 'bundled skill\n' },
  ];

  /** Nothing new in the plugin folder but `kept`, and the outside file untouched. */
  const expectNothingWritten = async (kept: string[]): Promise<void> => {
    expect((await readdir(dir)).sort()).toStrictEqual(kept.sort());
    expect(await readFile(join(outside, 'victim.md'), 'utf-8')).toBe('outside\n');
    expect((await readdir(outside)).sort()).toStrictEqual(['victim.md']);
  };

  it('refuses a managed file that is a symlink, writing nothing', async () => {
    await mkdir(join(dir, dirname(SKILL)), { recursive: true });
    await symlink(join(outside, 'victim.md'), join(dir, SKILL));

    const fs = spyFs();

    await expect(applyManagedFiles(dir, files, {}, fs)).rejects.toThrow(
      new UnsafeManagedPathError(SKILL, `${SKILL} is a symbolic link`),
    );
    expect(fs.writeFile).not.toHaveBeenCalled();
    await expectNothingWritten(['.agents']);
  });

  it('refuses a symlinked parent directory, writing nothing', async () => {
    await symlink(outside, join(dir, '.agents'));

    const fs = spyFs();

    await expect(applyManagedFiles(dir, files, {}, fs)).rejects.toThrow(
      '.agents is a symbolic link',
    );
    expect(fs.writeFile).not.toHaveBeenCalled();
    await expectNothingWritten(['.agents']);
  });

  it('refuses in a dry run too', async () => {
    await symlink(outside, join(dir, '.agents'));

    await expect(planManagedFiles(dir, files)).rejects.toBeInstanceOf(UnsafeManagedPathError);
  });

  it('refuses a directory where a managed file goes', async () => {
    await mkdir(join(dir, SKILL), { recursive: true });

    await expect(applyManagedFiles(dir, files)).rejects.toThrow(`${SKILL} is not a regular file`);
    await expect(stat(join(dir, 'first.md'))).rejects.toThrow();
  });

  it('refuses a file where a managed directory goes', async () => {
    await writeFile(join(dir, '.agents'), 'a file\n', 'utf-8');

    await expect(applyManagedFiles(dir, files)).rejects.toThrow('.agents is not a directory');
    await expect(stat(join(dir, 'first.md'))).rejects.toThrow();
  });

  it('refuses a path that climbs out of the plugin', async () => {
    await expect(
      applyManagedFiles(dir, [{ path: '../victim.md', content: 'x' }]),
    ).rejects.toBeInstanceOf(UnsafeManagedPathError);
  });

  it('still writes through a plugin folder that is itself reached by a symlink', async () => {
    const link = `${dir}-link`;

    await symlink(dir, link);

    try {
      await applyManagedFiles(link, files);

      expect(await read(SKILL)).toBe('bundled skill\n');
    } finally {
      await rm(link, { force: true });
    }
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
