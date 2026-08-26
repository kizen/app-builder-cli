import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileContent } from '@kizenapps/packager';
import { readLocalFiles, SKIP_DIRS } from './readFiles.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'appbuilder-readfiles-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relPath: string, contents: string | Buffer): Promise<void> {
  const absPath = join(root, relPath);

  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents);
}

function byPath(files: FileContent[]): Map<string, FileContent> {
  return new Map(files.map((file) => [file.path, file]));
}

function paths(files: FileContent[]): string[] {
  return files.map((file) => file.path).sort();
}

describe('readLocalFiles skip lists', () => {
  it('skips every directory in SKIP_DIRS at any depth', async () => {
    await write('kizen.json', '{}');

    for (const dir of SKIP_DIRS) {
      await write(join(dir, 'ignored.txt'), 'no');
      await write(join('src', dir, 'ignored.txt'), 'no');
    }

    expect(paths(await readLocalFiles(root))).toEqual(['kizen.json']);
  });

  it('names the expected skip directories', () => {
    expect([...SKIP_DIRS].sort()).toEqual([
      '.claude',
      '.git',
      '.github',
      '.kizenapp',
      '__pycache__',
      'node_modules',
    ]);
  });

  it('skips .DS_Store files but keeps other dotfiles', async () => {
    await write('.DS_Store', 'junk');
    await write('src/.DS_Store', 'junk');
    await write('.env.example', 'KEY=value');
    await write('.prettierrc', '{}');

    expect(paths(await readLocalFiles(root))).toEqual(['.env.example', '.prettierrc']);
  });

  it('keeps a directory whose name merely resembles a skipped one', async () => {
    await write('node_modules_backup/keep.txt', 'keep');
    await write('.gitignore', '.kizenapp/');

    expect(paths(await readLocalFiles(root))).toEqual([
      '.gitignore',
      'node_modules_backup/keep.txt',
    ]);
  });

  it('returns an empty array for an empty tree', async () => {
    await mkdir(join(root, 'src'), { recursive: true });

    expect(await readLocalFiles(root)).toEqual([]);
  });
});

describe('readLocalFiles path normalization', () => {
  it('returns POSIX-style paths relative to the root', async () => {
    await write(join('src', 'pages', 'index.js'), 'export default 1;');

    const [file] = await readLocalFiles(root);

    expect(file?.path).toBe('src/pages/index.js');
  });

  it('does not prefix paths with ./ or the root', async () => {
    await write('kizen.json', '{}');

    const [file] = await readLocalFiles(root);

    expect(file?.path).toBe('kizen.json');
  });

  it('walks nested directories', async () => {
    await write('a/b/c/deep.txt', 'deep');
    await write('a/shallow.txt', 'shallow');

    expect(paths(await readLocalFiles(root))).toEqual(['a/b/c/deep.txt', 'a/shallow.txt']);
  });
});

describe('readLocalFiles content handling', () => {
  it('reads text files as utf-8', async () => {
    await write('src/main.js', 'const x = "héllo";\n');

    const file = byPath(await readLocalFiles(root)).get('src/main.js');

    expect(file?.content).toBe('const x = "héllo";\n');
    expect(file?.base64Image).toBeUndefined();
    expect(file?.binaryData).toBeUndefined();
  });

  it('base64-encodes png and svg files', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await write('icon.png', png);
    await write('logo.svg', '<svg/>');

    const files = byPath(await readLocalFiles(root));

    expect(files.get('icon.png')?.base64Image).toBe(png.toString('base64'));
    expect(files.get('icon.png')?.content).toBe('');
    expect(files.get('logo.svg')?.base64Image).toBe(
      Buffer.from('<svg/>', 'utf-8').toString('base64'),
    );
  });

  it('matches image extensions case-insensitively', async () => {
    await write('Icon.PNG', 'x');

    const file = byPath(await readLocalFiles(root)).get('Icon.PNG');

    expect(file?.base64Image).toBe(Buffer.from('x', 'utf-8').toString('base64'));
  });

  it('returns .kzn files as raw binary data regardless of options', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);

    await write('bundle.kzn', bytes);

    const file = byPath(await readLocalFiles(root)).get('bundle.kzn');

    expect(file?.binaryData?.equals(bytes)).toBe(true);
    expect(file?.content).toBe('');
  });

  it('treats extensionless files as text', async () => {
    await write('LICENSE', 'GPL-3.0');

    const file = byPath(await readLocalFiles(root)).get('LICENSE');

    expect(file?.content).toBe('GPL-3.0');
  });
});

describe('readLocalFiles binary sniffing', () => {
  const withNul = Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]);

  it('does not sniff content by default', async () => {
    await write('data.bin', withNul);

    const file = byPath(await readLocalFiles(root)).get('data.bin');

    expect(file?.binaryData).toBeUndefined();
    expect(file?.content).toContain('\u0000');
  });

  it('flags a NUL-containing file as binary when detectBinaryByContent is on', async () => {
    await write('data.bin', withNul);

    const file = byPath(await readLocalFiles(root, { detectBinaryByContent: true })).get(
      'data.bin',
    );

    expect(file?.binaryData?.equals(withNul)).toBe(true);
    expect(file?.content).toBe('');
  });

  it('leaves NUL-free files as text when sniffing is on', async () => {
    await write('big.txt', 'a'.repeat(20_000));

    const file = byPath(await readLocalFiles(root, { detectBinaryByContent: true })).get('big.txt');

    expect(file?.binaryData).toBeUndefined();
    expect(file?.content).toHaveLength(20_000);
  });

  it('still base64-encodes images when sniffing is on', async () => {
    const png = Buffer.from([0x89, 0x50, 0x00, 0x47]);

    await write('icon.png', png);

    const file = byPath(await readLocalFiles(root, { detectBinaryByContent: true })).get(
      'icon.png',
    );

    expect(file?.base64Image).toBe(png.toString('base64'));
    expect(file?.binaryData).toBeUndefined();
  });
});
