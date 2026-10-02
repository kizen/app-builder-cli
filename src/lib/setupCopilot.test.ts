import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copilotFiles } from './createCopilotFiles.js';
import { setupCopilot } from './setupCopilot.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'appbuilder-setup-copilot-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeManifest(): Promise<void> {
  await writeFile(join(root, 'kizen.json'), '{}\n', 'utf-8');
}

function fullPath(relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

async function read(relativePath: string): Promise<string> {
  return readFile(fullPath(relativePath), 'utf-8');
}

function statuses(files: { path: string; status: string }[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, file.status]));
}

const MANAGED_PATHS = [
  '.github/copilot-instructions.md',
  '.github/instructions/security.instructions.md',
  '.github/instructions/version-discipline.instructions.md',
  '.github/workflows/copilot-code-review.yml',
];

describe('setupCopilot', () => {
  it('creates every managed file in a plugin repo that has none', async () => {
    await writeManifest();

    const result = await setupCopilot(root);

    expect(result.files.map((file) => file.path)).toStrictEqual(MANAGED_PATHS);
    expect(result.files.every((file) => file.status === 'created')).toBe(true);
  });

  it('writes the same bytes `create` scaffolds', async () => {
    await writeManifest();

    await setupCopilot(root);

    for (const file of copilotFiles()) {
      expect(await read(file.path)).toBe(file.content);
    }
  });

  it('adds the managed gitignore entries', async () => {
    await writeManifest();

    await setupCopilot(root);

    const lines = (await read('.gitignore')).split('\n').map((line) => line.trim());

    expect(lines).toContain('.copilot-docs/');
    expect(lines).toContain('.kizenapp/');
  });

  it('reports everything unchanged on a second run and rewrites nothing', async () => {
    await writeManifest();

    await setupCopilot(root);

    const before = await Promise.all(MANAGED_PATHS.map((path) => read(path)));
    const gitignoreBefore = await read('.gitignore');

    const result = await setupCopilot(root);

    expect(result.files.every((file) => file.status === 'unchanged')).toBe(true);
    expect(await Promise.all(MANAGED_PATHS.map((path) => read(path)))).toStrictEqual(before);
    expect(await read('.gitignore')).toBe(gitignoreBefore);
  });

  it('overwrites a customized instructions file and reports it as updated', async () => {
    await writeManifest();

    const customized = '.github/copilot-instructions.md';

    await mkdir(dirname(fullPath(customized)), { recursive: true });

    await writeFile(fullPath(customized), '# stale local rules\n', 'utf-8');

    const result = await setupCopilot(root);

    const template = copilotFiles().find((file) => file.path === customized);

    expect(statuses(result.files)[customized]).toBe('updated');
    expect(await read(customized)).toBe(template?.content);
  });

  it('refuses to run outside a plugin repo', async () => {
    await expect(setupCopilot(root)).rejects.toThrow(/kizen\.json/);

    await expect(read('.github/copilot-instructions.md')).rejects.toThrow();
  });

  it('reports a mixed dry run without touching the drifted file', async () => {
    await writeManifest();

    await setupCopilot(root);

    const customized = '.github/copilot-instructions.md';

    await writeFile(fullPath(customized), '# stale local rules\n', 'utf-8');

    const result = await setupCopilot(root, { dryRun: true });

    expect(statuses(result.files)).toStrictEqual({
      '.github/copilot-instructions.md': 'updated',
      '.github/instructions/security.instructions.md': 'unchanged',
      '.github/instructions/version-discipline.instructions.md': 'unchanged',
      '.github/workflows/copilot-code-review.yml': 'unchanged',
    });
    expect(await read(customized)).toBe('# stale local rules\n');
  });

  it('reports the statuses without writing anything on a dry run', async () => {
    await writeManifest();

    const result = await setupCopilot(root, { dryRun: true });

    expect(result.files.every((file) => file.status === 'created')).toBe(true);

    await expect(read('.github/copilot-instructions.md')).rejects.toThrow();

    await expect(read('.gitignore')).rejects.toThrow();
  });
});
