import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeFiles } from './createCopilotFiles.js';
import {
  CLAUDE_SKILL_PATH,
  entryDirsOf,
  isClaudeSkillStale,
  nodeClaudeFs,
  pluginClaudeFiles,
  runSetupClaude,
  STALE_CLAUDE_SKILL_WARNING,
  type ClaudeFs,
  type SetupClaudeDeps,
} from './setupClaude.js';

const DESIGN_PATH = '.claude/skills/kizen-custom-block/design.md';
const LIB_PATH = 'src/lib/kizenData.js';

const bundled = (path: string): string =>
  claudeFiles(['src']).find((file) => file.path === path)?.content ?? '';

const BUNDLED = bundled(CLAUDE_SKILL_PATH);
const BUNDLED_DESIGN = bundled(DESIGN_PATH);
const BUNDLED_LIB = bundled(LIB_PATH);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'setup-claude-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const skillFile = (): string => join(dir, CLAUDE_SKILL_PATH);

const writeSkill = async (content: string): Promise<void> => {
  await mkdir(dirname(skillFile()), { recursive: true });
  await writeFile(skillFile(), content, 'utf-8');
};

const readSkill = (): Promise<string> => readFile(skillFile(), 'utf-8');

const designFile = (): string => join(dir, DESIGN_PATH);

const writeDesign = async (content: string): Promise<void> => {
  await mkdir(dirname(designFile()), { recursive: true });
  await writeFile(designFile(), content, 'utf-8');
};

const readDesign = (): Promise<string> => readFile(designFile(), 'utf-8');

const libFile = (): string => join(dir, LIB_PATH);

const writeLib = async (content: string): Promise<void> => {
  await mkdir(dirname(libFile()), { recursive: true });
  await writeFile(libFile(), content, 'utf-8');
};

const readLib = (): Promise<string> => readFile(libFile(), 'utf-8');

const writeBundled = async (): Promise<void> => {
  await writeSkill(BUNDLED);
  await writeDesign(BUNDLED_DESIGN);
  await writeLib(BUNDLED_LIB);
};

const spyFs = (): ClaudeFs & { writeFile: ReturnType<typeof vi.fn> } => ({
  ...nodeClaudeFs,
  writeFile: vi.fn(nodeClaudeFs.writeFile),
});

interface DepsHarness {
  deps: SetupClaudeDeps;
  logs: string[];
  errors: string[];
  exitCodes: number[];
}

const makeDeps = (fs: ClaudeFs = nodeClaudeFs): DepsHarness => {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const deps: SetupClaudeDeps = {
    fs,
    log: (line) => {
      logs.push(line);
    },
    error: (line) => {
      errors.push(line);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
  };

  return { deps, logs, errors, exitCodes };
};

describe('STALE_CLAUDE_SKILL_WARNING', () => {
  it('names the managed files and the command in the stale warning, not one file', () => {
    expect(STALE_CLAUDE_SKILL_WARNING).toBe(
      'Claude files managed by appbuilder are out of date; run appbuilder setup-claude',
    );
    expect(STALE_CLAUDE_SKILL_WARNING).not.toContain('SKILL.md');
  });
});

describe('isClaudeSkillStale', () => {
  it('is false when the skill is missing', async () => {
    expect(await isClaudeSkillStale(dir)).toBe(false);
  });

  it('is false when the skill is missing even if the design guide differs', async () => {
    await writeDesign('edited locally\n');

    expect(await isClaudeSkillStale(dir)).toBe(false);
  });

  it('is false when every file matches the bundled one', async () => {
    await writeBundled();

    expect(await isClaudeSkillStale(dir)).toBe(false);
  });

  it('is true when the skill differs from the bundled one', async () => {
    await writeSkill('edited locally\n');
    await writeDesign(BUNDLED_DESIGN);

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('is true when the skill matches but the design guide is missing', async () => {
    await writeSkill(BUNDLED);

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('is true when the skill matches but the design guide differs', async () => {
    await writeSkill(BUNDLED);
    await writeDesign('edited locally\n');

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('isClaudeSkillStale ignores an absent kizenData.js', async () => {
    await writeSkill(BUNDLED);
    await writeDesign(BUNDLED_DESIGN);

    expect(await isClaudeSkillStale(dir)).toBe(false);
    await expect(stat(libFile())).rejects.toThrow();
  });

  it('isClaudeSkillStale reports a differing existing kizenData.js', async () => {
    await writeBundled();
    await writeLib('export const mine = 1;\n');

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('checks the data lib under the kizen.json entry directory', async () => {
    await writeFile(join(dir, 'kizen.json'), JSON.stringify({ entry: 'app/' }), 'utf-8');
    await writeSkill(BUNDLED);
    await writeDesign(BUNDLED_DESIGN);
    // A lib outside the entry directory is not a managed file.
    await writeLib('export const mine = 1;\n');
    await mkdir(join(dir, 'app', 'lib'), { recursive: true });
    await writeFile(join(dir, 'app', 'lib', 'kizenData.js'), 'export const mine = 1;\n', 'utf-8');

    expect(await isClaudeSkillStale(dir)).toBe(true);

    await writeFile(join(dir, 'app', 'lib', 'kizenData.js'), BUNDLED_LIB, 'utf-8');

    expect(await isClaudeSkillStale(dir)).toBe(false);
  });

  it('is false when reading the skill fails', async () => {
    const fs: ClaudeFs = {
      ...nodeClaudeFs,
      readFile: () => Promise.reject(new Error('EACCES')),
    };

    expect(await isClaudeSkillStale(dir, fs)).toBe(false);
  });
});

describe('runSetupClaude', () => {
  const inPlugin = async (): Promise<void> => {
    await writeFile(join(dir, 'kizen.json'), '{}', 'utf-8');
  };

  it('fails with exit code 1 and writes nothing outside a plugin directory', async () => {
    const { deps, logs, errors, exitCodes } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(errors).toStrictEqual([
      'Error: kizen.json not found. Run this command from a plugin directory.',
    ]);
    expect(exitCodes).toStrictEqual([1]);
    expect(logs).toStrictEqual([]);
    await expect(stat(skillFile())).rejects.toThrow();
  });

  it('setup-claude without --include-lib does not create kizenData.js', async () => {
    await inPlugin();

    const { deps, logs, errors, exitCodes } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(logs).toStrictEqual([
      `created   ${CLAUDE_SKILL_PATH}`,
      `created   ${DESIGN_PATH}`,
      'Claude files: 2 created, 0 updated, 0 unchanged (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(errors).toStrictEqual([]);
    expect(exitCodes).toStrictEqual([]);
    expect(await readSkill()).toBe(BUNDLED);
    expect(await readDesign()).toBe(BUNDLED_DESIGN);
    await expect(stat(libFile())).rejects.toThrow();
  });

  it('setup-claude without --include-lib refreshes an existing kizenData.js', async () => {
    await inPlugin();
    await writeSkill(BUNDLED);
    await writeDesign(BUNDLED_DESIGN);
    await writeLib('export const old = 1;\n');

    const { deps, logs, exitCodes } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(logs).toStrictEqual([
      `unchanged ${CLAUDE_SKILL_PATH}`,
      `unchanged ${DESIGN_PATH}`,
      `updated   ${LIB_PATH}`,
      'Claude files: 0 created, 1 updated, 2 unchanged (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(exitCodes).toStrictEqual([]);
    expect(await readLib()).toBe(BUNDLED_LIB);
  });

  it('setup-claude --include-lib creates kizenData.js under each entry dir', async () => {
    await writeFile(
      join(dir, 'kizen.json'),
      JSON.stringify([{ entry: 'src/googleAds/' }, { entry: 'src/outlookInbox/' }]),
      'utf-8',
    );

    const { deps, logs, exitCodes } = makeDeps();

    await runSetupClaude(dir, { includeLib: true }, deps);

    expect(logs).toStrictEqual([
      `created   ${CLAUDE_SKILL_PATH}`,
      `created   ${DESIGN_PATH}`,
      'created   src/googleAds/lib/kizenData.js',
      'created   src/outlookInbox/lib/kizenData.js',
      'Claude files: 4 created, 0 updated, 0 unchanged (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(exitCodes).toStrictEqual([]);

    for (const entry of ['googleAds', 'outlookInbox']) {
      expect(await readFile(join(dir, 'src', entry, 'lib', 'kizenData.js'), 'utf-8')).toBe(
        BUNDLED_LIB,
      );
    }

    await expect(stat(libFile())).rejects.toThrow();
  });

  it('writes the data lib under the kizen.json entry directory', async () => {
    await writeFile(join(dir, 'kizen.json'), JSON.stringify({ entry: './app/' }), 'utf-8');

    const { deps, logs } = makeDeps();

    await runSetupClaude(dir, { includeLib: true }, deps);

    expect(logs[2]).toBe('created   app/lib/kizenData.js');
    expect(await readFile(join(dir, 'app', 'lib', 'kizenData.js'), 'utf-8')).toBe(BUNDLED_LIB);
    await expect(stat(libFile())).rejects.toThrow();
  });

  it('reports a dry run without writing', async () => {
    await inPlugin();
    await writeSkill('edited locally\n');
    await writeDesign(BUNDLED_DESIGN);

    const fs = spyFs();
    const { deps, logs, exitCodes } = makeDeps(fs);

    await runSetupClaude(dir, { dryRun: true, includeLib: true }, deps);

    expect(logs).toStrictEqual([
      `updated   ${CLAUDE_SKILL_PATH}`,
      `unchanged ${DESIGN_PATH}`,
      `created   ${LIB_PATH}`,
      'Dry run: 1 created, 1 updated, 1 unchanged; nothing written (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(exitCodes).toStrictEqual([]);
    expect(await readSkill()).toBe('edited locally\n');
    await expect(stat(libFile())).rejects.toThrow();
  });

  it('plans no data lib in a dry run without --include-lib', async () => {
    await inPlugin();

    const fs = spyFs();
    const { deps, logs } = makeDeps(fs);

    await runSetupClaude(dir, { dryRun: true }, deps);

    expect(logs).toStrictEqual([
      `created   ${CLAUDE_SKILL_PATH}`,
      `created   ${DESIGN_PATH}`,
      'Dry run: 2 created, 0 updated, 0 unchanged; nothing written (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('fails with exit code 1 when a write fails', async () => {
    await inPlugin();

    const fs: ClaudeFs = {
      ...nodeClaudeFs,
      writeFile: () => Promise.reject(new Error('EACCES: permission denied')),
    };
    const { deps, logs, errors, exitCodes } = makeDeps(fs);

    await runSetupClaude(dir, {}, deps);

    expect(errors).toStrictEqual(['Error: EACCES: permission denied']);
    expect(exitCodes).toStrictEqual([1]);
    expect(logs).toStrictEqual([]);
  });
});

describe('entryDirsOf', () => {
  it('defaults to src when the manifest has no entry', () => {
    expect(entryDirsOf({})).toStrictEqual(['src']);
    expect(entryDirsOf(null)).toStrictEqual(['src']);
    expect(entryDirsOf({ entry: 7 })).toStrictEqual(['src']);
    expect(entryDirsOf({ entry: '  ' })).toStrictEqual(['src']);
  });

  it('normalizes leading ./ and trailing slashes', () => {
    expect(entryDirsOf({ entry: 'src/' })).toStrictEqual(['src']);
    expect(entryDirsOf({ entry: './app//' })).toStrictEqual(['app']);
    expect(entryDirsOf({ entry: 'src\\nested\\' })).toStrictEqual(['src/nested']);
  });

  it('maps a root entry to the plugin directory itself', () => {
    expect(entryDirsOf({ entry: './' })).toStrictEqual(['']);
  });

  it('ignores entries that escape the plugin directory', () => {
    expect(entryDirsOf({ entry: '../elsewhere/' })).toStrictEqual(['src']);
    expect(entryDirsOf({ entry: '/abs/src/' })).toStrictEqual(['src']);
  });

  it('collects every distinct entry of a multi-plugin manifest', () => {
    expect(
      entryDirsOf([{ entry: 'src/a/' }, { entry: 'src/b/' }, { entry: 'src/a' }, { name: 'x' }]),
    ).toStrictEqual(['src/a', 'src/b']);
  });
});

describe('pluginClaudeFiles', () => {
  it('manages only the skill and design guide when no data lib exists and none is requested', async () => {
    expect((await pluginClaudeFiles(dir)).map((file) => file.path)).toStrictEqual([
      CLAUDE_SKILL_PATH,
      DESIGN_PATH,
    ]);
  });

  it('places the data lib under src when kizen.json is missing', async () => {
    expect(
      (await pluginClaudeFiles(dir, nodeClaudeFs, { includeLib: true })).map((file) => file.path),
    ).toStrictEqual([CLAUDE_SKILL_PATH, DESIGN_PATH, LIB_PATH]);
  });

  it('places the data lib under src when kizen.json is not valid JSON', async () => {
    await writeFile(join(dir, 'kizen.json'), '{ nope', 'utf-8');

    expect(
      (await pluginClaudeFiles(dir, nodeClaudeFs, { includeLib: true })).map((file) => file.path),
    ).toContain(LIB_PATH);
  });

  it('manages only the entry directories whose data lib already exists', async () => {
    await writeFile(
      join(dir, 'kizen.json'),
      JSON.stringify([{ entry: 'src/googleAds/' }, { entry: 'src/outlookInbox/' }]),
      'utf-8',
    );
    await mkdir(join(dir, 'src', 'outlookInbox', 'lib'), { recursive: true });
    await writeFile(join(dir, 'src', 'outlookInbox', 'lib', 'kizenData.js'), 'x', 'utf-8');

    expect((await pluginClaudeFiles(dir)).map((file) => file.path)).toStrictEqual([
      CLAUDE_SKILL_PATH,
      DESIGN_PATH,
      'src/outlookInbox/lib/kizenData.js',
    ]);
  });

  it('places one data lib under each entry of a multi-plugin manifest', async () => {
    await writeFile(
      join(dir, 'kizen.json'),
      JSON.stringify([{ entry: 'src/googleAds/' }, { entry: 'src/outlookInbox/' }]),
      'utf-8',
    );

    const files = await pluginClaudeFiles(dir, nodeClaudeFs, { includeLib: true });

    expect(files.map((file) => file.path)).toStrictEqual([
      CLAUDE_SKILL_PATH,
      DESIGN_PATH,
      'src/googleAds/lib/kizenData.js',
      'src/outlookInbox/lib/kizenData.js',
    ]);
    expect(files[3]?.content).toBe(BUNDLED_LIB);
  });
});
