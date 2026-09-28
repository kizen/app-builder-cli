import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeFiles } from './createCopilotFiles.js';
import {
  applyClaudeFiles,
  CLAUDE_SKILL_PATH,
  entryDirsOf,
  isClaudeSkillStale,
  nodeClaudeFs,
  planClaudeFiles,
  pluginClaudeFiles,
  runSetupClaude,
  STALE_CLAUDE_SKILL_WARNING,
  type ClaudeFs,
  type SetupClaudeDeps,
} from './setupClaude.js';

const DESIGN_PATH = '.claude/skills/kizen-custom-block/design.md';
const LIB_PATH = 'src/lib/kizenData.js';

const bundled = (path: string): string =>
  claudeFiles().find((file) => file.path === path)?.content ?? '';

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

describe('claudeFiles contract', () => {
  it('bundles the skill, its design guide and the data lib at the paths setup-claude manages', () => {
    expect(claudeFiles().map((file) => file.path)).toStrictEqual([
      CLAUDE_SKILL_PATH,
      DESIGN_PATH,
      LIB_PATH,
    ]);
    expect(BUNDLED.length).toBeGreaterThan(0);
    expect(BUNDLED_DESIGN.length).toBeGreaterThan(0);
    expect(BUNDLED_LIB).toContain('export const searchRecords = ');
  });

  it('points the skill at the design guide', () => {
    expect(BUNDLED).toContain(
      'Before writing any markup or styles, read `design.md` in this skill directory and follow it exactly.',
    );
  });

  it('names the managed files and the command in the stale warning, not one file', () => {
    expect(STALE_CLAUDE_SKILL_WARNING).toBe(
      'Claude files managed by appbuilder are out of date; run appbuilder setup-claude',
    );
    expect(STALE_CLAUDE_SKILL_WARNING).not.toContain('SKILL.md');
  });

  it('tells the agent to look for the exact stale warning the push emits', () => {
    expect(BUNDLED).toContain(`\`${STALE_CLAUDE_SKILL_WARNING}\``);
    expect(BUNDLED).toContain('## Keep this skill current');
    expect(BUNDLED).toContain('appbuilder setup-claude');
  });
});

describe('planClaudeFiles', () => {
  it('plans created when every file is missing', async () => {
    expect(await planClaudeFiles(dir)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'created' },
      { path: DESIGN_PATH, status: 'created' },
      { path: LIB_PATH, status: 'created' },
    ]);
  });

  it('plans each file on its own status', async () => {
    await writeSkill('edited locally\n');

    expect(await planClaudeFiles(dir)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'updated' },
      { path: DESIGN_PATH, status: 'created' },
      { path: LIB_PATH, status: 'created' },
    ]);
  });

  it('plans updated for a design guide that differs while the skill matches', async () => {
    await writeSkill(BUNDLED);
    await writeDesign('edited locally\n');

    expect(await planClaudeFiles(dir)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'unchanged' },
      { path: DESIGN_PATH, status: 'updated' },
      { path: LIB_PATH, status: 'created' },
    ]);
  });

  it('plans unchanged when every file matches the bundled one', async () => {
    await writeBundled();

    expect(await planClaudeFiles(dir)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'unchanged' },
      { path: DESIGN_PATH, status: 'unchanged' },
      { path: LIB_PATH, status: 'unchanged' },
    ]);
  });

  it('plans updated for a locally edited data lib', async () => {
    await writeBundled();
    await writeLib('export const mine = 1;\n');

    expect(await planClaudeFiles(dir)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'unchanged' },
      { path: DESIGN_PATH, status: 'unchanged' },
      { path: LIB_PATH, status: 'updated' },
    ]);
  });

  it('never writes', async () => {
    const fs = spyFs();

    await planClaudeFiles(dir, fs);

    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('applyClaudeFiles', () => {
  it('creates missing files with the bundled content', async () => {
    expect(await applyClaudeFiles(dir)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'created' },
      { path: DESIGN_PATH, status: 'created' },
      { path: LIB_PATH, status: 'created' },
    ]);
    expect(await readSkill()).toBe(BUNDLED);
    expect(await readDesign()).toBe(BUNDLED_DESIGN);
    expect(await readLib()).toBe(BUNDLED_LIB);
  });

  it('overwrites a locally edited skill with the bundled content', async () => {
    await writeSkill('edited locally\n');
    await writeDesign(BUNDLED_DESIGN);
    await writeLib(BUNDLED_LIB);

    expect(await applyClaudeFiles(dir)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'updated' },
      { path: DESIGN_PATH, status: 'unchanged' },
      { path: LIB_PATH, status: 'unchanged' },
    ]);
    expect(await readSkill()).toBe(BUNDLED);
  });

  it('writes only the design guide when only it differs', async () => {
    await writeSkill(BUNDLED);
    await writeDesign('edited locally\n');
    await writeLib(BUNDLED_LIB);

    const fs = spyFs();

    expect(await applyClaudeFiles(dir, {}, fs)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'unchanged' },
      { path: DESIGN_PATH, status: 'updated' },
      { path: LIB_PATH, status: 'unchanged' },
    ]);
    expect(fs.writeFile.mock.calls.map((call) => String(call[0]))).toStrictEqual([designFile()]);
    expect(await readDesign()).toBe(BUNDLED_DESIGN);
  });

  it('does not rewrite unchanged files', async () => {
    await writeBundled();

    const fs = spyFs();

    expect(await applyClaudeFiles(dir, {}, fs)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'unchanged' },
      { path: DESIGN_PATH, status: 'unchanged' },
      { path: LIB_PATH, status: 'unchanged' },
    ]);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('replaces a locally edited data lib with the bundled one', async () => {
    await writeBundled();
    await writeLib('export const mine = 1;\n');

    const fs = spyFs();

    await applyClaudeFiles(dir, {}, fs);

    expect(fs.writeFile.mock.calls.map((call) => String(call[0]))).toStrictEqual([libFile()]);
    expect(await readLib()).toBe(BUNDLED_LIB);
  });

  it('makes no writes on a dry run with an outdated skill', async () => {
    await writeSkill('edited locally\n');

    const fs = spyFs();

    expect(await applyClaudeFiles(dir, { dryRun: true }, fs)).toStrictEqual([
      { path: CLAUDE_SKILL_PATH, status: 'updated' },
      { path: DESIGN_PATH, status: 'created' },
      { path: LIB_PATH, status: 'created' },
    ]);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(await readSkill()).toBe('edited locally\n');
  });

  it('makes no writes on a dry run with a missing skill', async () => {
    await applyClaudeFiles(dir, { dryRun: true });

    await expect(stat(skillFile())).rejects.toThrow();
    await expect(stat(designFile())).rejects.toThrow();
    await expect(stat(libFile())).rejects.toThrow();
  });

  it('only writes the managed skill files and the data lib', async () => {
    const fs = spyFs();

    await applyClaudeFiles(dir, {}, fs);

    const written = fs.writeFile.mock.calls.map((call) => String(call[0]));

    expect(written).toStrictEqual([skillFile(), designFile(), libFile()]);
    expect(written.some((path) => path.includes('.github'))).toBe(false);
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

  it('is true when the skill and design guide match but the data lib is missing', async () => {
    await writeSkill(BUNDLED);
    await writeDesign(BUNDLED_DESIGN);

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('is true when the data lib differs from the bundled one', async () => {
    await writeBundled();
    await writeLib('export const mine = 1;\n');

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('checks the data lib under the kizen.json entry directory', async () => {
    await writeFile(join(dir, 'kizen.json'), JSON.stringify({ entry: 'app/' }), 'utf-8');
    await writeSkill(BUNDLED);
    await writeDesign(BUNDLED_DESIGN);
    await writeLib(BUNDLED_LIB);

    expect(await isClaudeSkillStale(dir)).toBe(true);

    await mkdir(join(dir, 'app', 'lib'), { recursive: true });
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

  it('reports created and writes the skill, the design guide and the data lib', async () => {
    await inPlugin();

    const { deps, logs, errors, exitCodes } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(logs).toStrictEqual([
      `created   ${CLAUDE_SKILL_PATH}`,
      `created   ${DESIGN_PATH}`,
      `created   ${LIB_PATH}`,
      'Claude files: 3 created, 0 updated, 0 unchanged (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(errors).toStrictEqual([]);
    expect(exitCodes).toStrictEqual([]);
    expect(await readSkill()).toBe(BUNDLED);
    expect(await readDesign()).toBe(BUNDLED_DESIGN);
    expect(await readLib()).toBe(BUNDLED_LIB);
  });

  it('writes the data lib under the kizen.json entry directory', async () => {
    await writeFile(join(dir, 'kizen.json'), JSON.stringify({ entry: './app/' }), 'utf-8');

    const { deps, logs } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(logs[2]).toBe('created   app/lib/kizenData.js');
    expect(await readFile(join(dir, 'app', 'lib', 'kizenData.js'), 'utf-8')).toBe(BUNDLED_LIB);
    await expect(stat(libFile())).rejects.toThrow();
  });

  it('reports updated and restores the bundled skill', async () => {
    await inPlugin();
    await writeSkill('edited locally\n');
    await writeDesign(BUNDLED_DESIGN);
    await writeLib(BUNDLED_LIB);

    const { deps, logs } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(logs[0]).toBe(`updated   ${CLAUDE_SKILL_PATH}`);
    expect(logs[1]).toBe(`unchanged ${DESIGN_PATH}`);
    expect(logs[2]).toBe(`unchanged ${LIB_PATH}`);
    expect(logs[3]).toContain('0 created, 1 updated, 2 unchanged');
    expect(await readSkill()).toBe(BUNDLED);
  });

  it('reports a missing design guide as created next to an unchanged skill', async () => {
    await inPlugin();
    await writeSkill(BUNDLED);
    await writeLib(BUNDLED_LIB);

    const { deps, logs } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(logs[0]).toBe(`unchanged ${CLAUDE_SKILL_PATH}`);
    expect(logs[1]).toBe(`created   ${DESIGN_PATH}`);
    expect(logs[2]).toBe(`unchanged ${LIB_PATH}`);
    expect(logs[3]).toContain('1 created, 0 updated, 2 unchanged');
    expect(await readDesign()).toBe(BUNDLED_DESIGN);
  });

  it('reports unchanged', async () => {
    await inPlugin();
    await writeBundled();

    const { deps, logs, exitCodes } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(logs[0]).toBe(`unchanged ${CLAUDE_SKILL_PATH}`);
    expect(logs[1]).toBe(`unchanged ${DESIGN_PATH}`);
    expect(logs[2]).toBe(`unchanged ${LIB_PATH}`);
    expect(logs[3]).toContain('0 created, 0 updated, 3 unchanged');
    expect(exitCodes).toStrictEqual([]);
  });

  it('reports a dry run without writing', async () => {
    await inPlugin();
    await writeSkill('edited locally\n');
    await writeDesign(BUNDLED_DESIGN);

    const fs = spyFs();
    const { deps, logs, exitCodes } = makeDeps(fs);

    await runSetupClaude(dir, { dryRun: true }, deps);

    expect(logs).toStrictEqual([
      `updated   ${CLAUDE_SKILL_PATH}`,
      `unchanged ${DESIGN_PATH}`,
      `created   ${LIB_PATH}`,
      'Dry run: 1 created, 1 updated, 1 unchanged; nothing written (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(exitCodes).toStrictEqual([]);
    expect(await readSkill()).toBe('edited locally\n');
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
  it('places the data lib under src when kizen.json is missing', async () => {
    expect((await pluginClaudeFiles(dir)).map((file) => file.path)).toStrictEqual([
      CLAUDE_SKILL_PATH,
      DESIGN_PATH,
      LIB_PATH,
    ]);
  });

  it('places the data lib under src when kizen.json is not valid JSON', async () => {
    await writeFile(join(dir, 'kizen.json'), '{ nope', 'utf-8');

    expect((await pluginClaudeFiles(dir)).map((file) => file.path)).toContain(LIB_PATH);
  });

  it('places one data lib under each entry of a multi-plugin manifest', async () => {
    await writeFile(
      join(dir, 'kizen.json'),
      JSON.stringify([{ entry: 'src/googleAds/' }, { entry: 'src/outlookInbox/' }]),
      'utf-8',
    );

    const files = await pluginClaudeFiles(dir);

    expect(files.map((file) => file.path)).toStrictEqual([
      CLAUDE_SKILL_PATH,
      DESIGN_PATH,
      'src/googleAds/lib/kizenData.js',
      'src/outlookInbox/lib/kizenData.js',
    ]);
    expect(files[3]?.content).toBe(BUNDLED_LIB);
  });

  it('places the data lib at lib/ for a root entry', async () => {
    await writeFile(join(dir, 'kizen.json'), JSON.stringify({ entry: './' }), 'utf-8');

    expect((await pluginClaudeFiles(dir)).map((file) => file.path)).toContain('lib/kizenData.js');
  });
});
