import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexFiles } from './createCopilotFiles.js';
import { nodeManagedFs, type ManagedFs } from './managedFiles.js';
import {
  CODEX_SKILL_PATH,
  isCodexSkillStale,
  runSetupCodex,
  STALE_CODEX_SKILL_WARNING,
  type SetupCodexDeps,
} from './setupCodex.js';

const DESIGN_PATH = '.agents/skills/kizen-custom-block/design.md';
const BUSINESS_PATH = '.agents/skills/kizen-business-apps/SKILL.md';
const LIB_PATH = 'src/lib/kizenData.js';
const SUMMARY_TAIL =
  '(these files are managed by appbuilder, so local edits to them are replaced).';

const bundled = (path: string): string =>
  codexFiles(['src']).find((file) => file.path === path)?.content ?? '';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'setup-codex-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content, 'utf-8');
};

const read = (path: string): Promise<string> => readFile(join(dir, path), 'utf-8');

const inPlugin = (): Promise<void> => put('kizen.json', '{}');

const makeDeps = (
  fs: ManagedFs = nodeManagedFs,
): { deps: SetupCodexDeps; logs: string[]; errors: string[]; exitCodes: number[] } => {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];

  return {
    deps: {
      fs,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
      setExitCode: (code) => exitCodes.push(code),
    },
    logs,
    errors,
    exitCodes,
  };
};

describe('runSetupCodex', () => {
  it('writes both skills to .agents/skills, rendered for Codex', async () => {
    await inPlugin();

    const { deps, logs, errors, exitCodes } = makeDeps();

    await runSetupCodex(dir, {}, deps);

    expect(logs).toStrictEqual([
      `created   ${CODEX_SKILL_PATH}`,
      `created   ${DESIGN_PATH}`,
      `created   ${BUSINESS_PATH}`,
      `Codex files: 3 created, 0 updated, 0 unchanged ${SUMMARY_TAIL}`,
    ]);
    expect(errors).toStrictEqual([]);
    expect(exitCodes).toStrictEqual([]);

    for (const path of [CODEX_SKILL_PATH, DESIGN_PATH, BUSINESS_PATH]) {
      expect(await read(path)).toBe(bundled(path));
    }

    expect(await read(BUSINESS_PATH)).toContain('appbuilder setup-codex');
    await expect(stat(join(dir, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dir, LIB_PATH))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes the data lib under the entry directory with --include-lib', async () => {
    await put('kizen.json', JSON.stringify({ entry: './app/' }));

    const { deps, logs } = makeDeps();

    await runSetupCodex(dir, { includeLib: true }, deps);

    expect(logs[3]).toBe('created   app/lib/kizenData.js');
    expect(await read('app/lib/kizenData.js')).toBe(bundled(LIB_PATH));
  });

  it('replaces a locally edited managed file without any --force', async () => {
    await inPlugin();

    for (const file of codexFiles()) {
      await put(file.path, file.content);
    }

    await put(BUSINESS_PATH, 'edited locally\n');

    const { deps, logs, exitCodes } = makeDeps();

    await runSetupCodex(dir, {}, deps);

    expect(logs).toStrictEqual([
      `unchanged ${CODEX_SKILL_PATH}`,
      `unchanged ${DESIGN_PATH}`,
      `updated   ${BUSINESS_PATH}`,
      `Codex files: 0 created, 1 updated, 2 unchanged ${SUMMARY_TAIL}`,
    ]);
    expect(exitCodes).toStrictEqual([]);
    expect(await read(BUSINESS_PATH)).toBe(bundled(BUSINESS_PATH));
  });

  it('reports a dry run without writing', async () => {
    await inPlugin();
    await put(CODEX_SKILL_PATH, 'edited locally\n');

    const fs = { ...nodeManagedFs, writeFile: vi.fn(nodeManagedFs.writeFile) };
    const { deps, logs } = makeDeps(fs);

    await runSetupCodex(dir, { dryRun: true }, deps);

    expect(logs).toStrictEqual([
      `updated   ${CODEX_SKILL_PATH}`,
      `created   ${DESIGN_PATH}`,
      `created   ${BUSINESS_PATH}`,
      `Dry run: 2 created, 1 updated, 0 unchanged; nothing written ${SUMMARY_TAIL}`,
    ]);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(await read(CODEX_SKILL_PATH)).toBe('edited locally\n');
  });

  it('fails with exit code 1 and writes nothing outside a plugin directory', async () => {
    const { deps, logs, errors, exitCodes } = makeDeps();

    await runSetupCodex(dir, {}, deps);

    expect(errors).toStrictEqual([
      'Error: kizen.json not found. Run this command from a plugin directory.',
    ]);
    expect(exitCodes).toStrictEqual([1]);
    expect(logs).toStrictEqual([]);
    await expect(stat(join(dir, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to follow a symlinked .agents out of the plugin, writing nothing', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'setup-codex-outside-'));

    try {
      await inPlugin();
      await mkdir(join(outside, 'skills', 'kizen-custom-block'), { recursive: true });
      await writeFile(join(outside, 'skills', 'kizen-custom-block', 'SKILL.md'), 'mine\n');
      await symlink(outside, join(dir, '.agents'));

      const { deps, logs, errors, exitCodes } = makeDeps();

      await runSetupCodex(dir, { includeLib: true }, deps);

      expect(exitCodes).toStrictEqual([1]);
      expect(logs).toStrictEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Refusing to write .agents/skills/kizen-custom-block/SKILL.md');
      expect(errors[0]).toContain('.agents is a symbolic link');
      expect(
        await readFile(join(outside, 'skills', 'kizen-custom-block', 'SKILL.md'), 'utf-8'),
      ).toBe('mine\n');
      expect((await readdir(join(outside, 'skills'))).sort()).toStrictEqual(['kizen-custom-block']);
      await expect(stat(join(dir, LIB_PATH))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails with exit code 1 when a write fails, as under a read-only sandbox', async () => {
    await inPlugin();

    const { deps, errors, exitCodes } = makeDeps({
      ...nodeManagedFs,
      writeFile: () => Promise.reject(new Error('EPERM: operation not permitted')),
    });

    await runSetupCodex(dir, {}, deps);

    expect(errors).toStrictEqual(['Error: EPERM: operation not permitted']);
    expect(exitCodes).toStrictEqual([1]);
  });
});

describe('isCodexSkillStale', () => {
  it('is false until a Codex skill is installed, then tracks every managed file', async () => {
    expect(await isCodexSkillStale(dir)).toBe(false);

    await put(CODEX_SKILL_PATH, bundled(CODEX_SKILL_PATH));

    expect(await isCodexSkillStale(dir)).toBe(true);

    await inPlugin();
    await runSetupCodex(dir, {}, makeDeps().deps);

    expect(await isCodexSkillStale(dir)).toBe(false);
  });

  it('pairs with the warning that names setup-codex', () => {
    expect(STALE_CODEX_SKILL_WARNING).toBe(
      'Codex files managed by appbuilder are out of date; run appbuilder setup-codex',
    );
  });
});
