import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitignore } from './gitignore.js';

let root: string;
let gitignorePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'appbuilder-gitignore-'));
  gitignorePath = join(root, '.gitignore');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function read(): Promise<string> {
  return readFile(gitignorePath, 'utf-8');
}

function entries(contents: string): string[] {
  return contents.split('\n').map((line) => line.trim());
}

describe('ensureGitignore', () => {
  it('creates the file with the .kizenapp/ entry when none exists', async () => {
    ensureGitignore(root);

    expect(entries(await read())).toContain('.kizenapp/');
  });

  it('appends to an existing gitignore without dropping its entries', async () => {
    await writeFile(gitignorePath, 'node_modules/\ndist/\n', 'utf-8');

    ensureGitignore(root);

    const lines = entries(await read());

    expect(lines).toContain('node_modules/');
    expect(lines).toContain('dist/');
    expect(lines).toContain('.kizenapp/');
  });

  it('separates the entry from a file that does not end in a newline', async () => {
    await writeFile(gitignorePath, 'dist/', 'utf-8');

    ensureGitignore(root);

    const contents = await read();

    expect(contents.startsWith('dist/')).toBe(true);
    expect(entries(contents)).toContain('.kizenapp/');
    expect(contents).not.toContain('dist/.kizenapp/');
  });

  it('is idempotent — a second call leaves the file byte-identical', async () => {
    await writeFile(gitignorePath, 'node_modules/\n', 'utf-8');

    ensureGitignore(root);

    const after = await read();

    ensureGitignore(root);

    expect(await read()).toBe(after);
  });

  it('is idempotent when it created the file itself', async () => {
    ensureGitignore(root);

    const after = await read();

    ensureGitignore(root);
    ensureGitignore(root);

    expect(await read()).toBe(after);
    expect(entries(await read()).filter((line) => line === '.kizenapp/')).toHaveLength(1);
  });

  it('accepts the unslashed .kizenapp form as already-ignored', async () => {
    await writeFile(gitignorePath, '.kizenapp\n', 'utf-8');

    ensureGitignore(root);

    expect(await read()).toBe('.kizenapp\n');
  });

  it('matches an entry surrounded by whitespace', async () => {
    await writeFile(gitignorePath, '  .kizenapp/  \n', 'utf-8');

    ensureGitignore(root);

    expect(await read()).toBe('  .kizenapp/  \n');
  });

  it('does not treat a longer path containing the entry as a match', async () => {
    await writeFile(gitignorePath, 'packages/app/.kizenapp/\n', 'utf-8');

    ensureGitignore(root);

    expect(entries(await read())).toContain('.kizenapp/');
  });
});
