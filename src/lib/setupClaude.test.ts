import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeFiles } from './createCopilotFiles.js';
import {
  CLAUDE_SKILL_PATH,
  CLI_PACKAGE_NAME,
  entryDirsOf,
  isClaudeSkillStale,
  nodeClaudeFs,
  pluginClaudeFiles,
  runCommand,
  runSetupClaude,
  STALE_CLAUDE_SKILL_WARNING,
  type ClaudeFs,
  type CommandResult,
  type RunCommand,
  type SetupClaudeDeps,
} from './setupClaude.js';

const DESIGN_PATH = '.claude/skills/kizen-custom-block/design.md';
const BUSINESS_PATH = '.claude/skills/kizen-business-apps/SKILL.md';
const LIB_PATH = 'src/lib/kizenData.js';

const bundled = (path: string): string =>
  claudeFiles(['src']).find((file) => file.path === path)?.content ?? '';

const BUNDLED = bundled(CLAUDE_SKILL_PATH);
const BUNDLED_DESIGN = bundled(DESIGN_PATH);
const BUNDLED_LIB = bundled(LIB_PATH);
const BUNDLED_BUSINESS = bundled(BUSINESS_PATH);

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

const writeBusiness = async (content: string): Promise<void> => {
  await mkdir(dirname(join(dir, BUSINESS_PATH)), { recursive: true });
  await writeFile(join(dir, BUSINESS_PATH), content, 'utf-8');
};

const writeBundledSkills = async (): Promise<void> => {
  await writeSkill(BUNDLED);
  await writeDesign(BUNDLED_DESIGN);
  await writeBusiness(BUNDLED_BUSINESS);
};

const writeBundled = async (): Promise<void> => {
  await writeBundledSkills();
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

/** Deliberately not the package's version, so a passing test proves deps.cliVersion is used. */
const TEST_CLI_VERSION = '9.9.9-test.1';

/** A runner that fails the test if anything tries to run `claude`. */
const forbiddenRun: RunCommand = () => Promise.reject(new Error('claude must not run here'));

const makeDeps = (
  fs: ClaudeFs = nodeClaudeFs,
  extra: Partial<Pick<SetupClaudeDeps, 'run' | 'hasOAuthSession'>> = {},
): DepsHarness => {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const deps: SetupClaudeDeps = {
    fs,
    run: extra.run ?? forbiddenRun,
    cliVersion: TEST_CLI_VERSION,
    hasOAuthSession: extra.hasOAuthSession ?? (() => Promise.resolve(true)),
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
    await writeBundledSkills();
    await writeSkill('edited locally\n');

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('is true when the skill matches but the design guide is missing', async () => {
    await writeSkill(BUNDLED);
    await writeBusiness(BUNDLED_BUSINESS);

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('is true when the skill matches but the design guide differs', async () => {
    await writeBundledSkills();
    await writeDesign('edited locally\n');

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('is true for an install from before the business-apps skill existed', async () => {
    await writeSkill(BUNDLED);
    await writeDesign(BUNDLED_DESIGN);

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('counts the business-apps skill alone as installed', async () => {
    await writeBusiness('edited locally\n');

    expect(await isClaudeSkillStale(dir)).toBe(true);
  });

  it('isClaudeSkillStale ignores an absent kizenData.js', async () => {
    await writeBundledSkills();

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
    await writeBundledSkills();
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
      'Error: kizen.json not found. Run this command from a plugin directory, or pass --mcp to only register the MCP server.',
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
      `created   ${BUSINESS_PATH}`,
      'Claude files: 3 created, 0 updated, 0 unchanged (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(errors).toStrictEqual([]);
    expect(exitCodes).toStrictEqual([]);
    expect(await readSkill()).toBe(BUNDLED);
    expect(await readDesign()).toBe(BUNDLED_DESIGN);
    await expect(stat(libFile())).rejects.toThrow();
  });

  it('setup-claude without --include-lib refreshes an existing kizenData.js', async () => {
    await inPlugin();
    await writeBundledSkills();
    await writeLib('export const old = 1;\n');

    const { deps, logs, exitCodes } = makeDeps();

    await runSetupClaude(dir, {}, deps);

    expect(logs).toStrictEqual([
      `unchanged ${CLAUDE_SKILL_PATH}`,
      `unchanged ${DESIGN_PATH}`,
      `unchanged ${BUSINESS_PATH}`,
      `updated   ${LIB_PATH}`,
      'Claude files: 0 created, 1 updated, 3 unchanged (these files are managed by appbuilder, so local edits to them are replaced).',
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
      `created   ${BUSINESS_PATH}`,
      'created   src/googleAds/lib/kizenData.js',
      'created   src/outlookInbox/lib/kizenData.js',
      'Claude files: 5 created, 0 updated, 0 unchanged (these files are managed by appbuilder, so local edits to them are replaced).',
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

    expect(logs[3]).toBe('created   app/lib/kizenData.js');
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
      `created   ${BUSINESS_PATH}`,
      `created   ${LIB_PATH}`,
      'Dry run: 2 created, 1 updated, 1 unchanged; nothing written (these files are managed by appbuilder, so local edits to them are replaced).',
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
      `created   ${BUSINESS_PATH}`,
      'Dry run: 3 created, 0 updated, 0 unchanged; nothing written (these files are managed by appbuilder, so local edits to them are replaced).',
    ]);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a managed file that is a symlink out of the plugin', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'setup-claude-outside-'));

    try {
      await inPlugin();
      await writeFile(join(outside, 'victim.md'), 'outside\n', 'utf-8');
      await mkdir(dirname(skillFile()), { recursive: true });
      await symlink(join(outside, 'victim.md'), skillFile());

      const { deps, logs, errors, exitCodes } = makeDeps();

      await runSetupClaude(dir, {}, deps);

      expect(exitCodes).toStrictEqual([1]);
      expect(logs).toStrictEqual([]);
      expect(errors[0]).toContain(`${CLAUDE_SKILL_PATH} is a symbolic link`);
      expect(await readFile(join(outside, 'victim.md'), 'utf-8')).toBe('outside\n');
      await expect(stat(designFile())).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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
  it('manages only the skills when no data lib exists and none is requested', async () => {
    expect((await pluginClaudeFiles(dir)).map((file) => file.path)).toStrictEqual([
      CLAUDE_SKILL_PATH,
      DESIGN_PATH,
      BUSINESS_PATH,
    ]);
  });

  it('places the data lib under src when kizen.json is missing', async () => {
    expect(
      (await pluginClaudeFiles(dir, nodeClaudeFs, { includeLib: true })).map((file) => file.path),
    ).toStrictEqual([CLAUDE_SKILL_PATH, DESIGN_PATH, BUSINESS_PATH, LIB_PATH]);
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
      BUSINESS_PATH,
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
      BUSINESS_PATH,
      'src/googleAds/lib/kizenData.js',
      'src/outlookInbox/lib/kizenData.js',
    ]);
    expect(files[4]?.content).toBe(BUNDLED_LIB);
  });
});

describe('setup-claude --mcp', () => {
  const inPlugin = async (): Promise<void> => {
    await writeFile(join(dir, 'kizen.json'), '{}', 'utf-8');
  };

  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

  /** --mcp never writes: no managed file or .claude directory appears. */
  const expectNoFiles = async (): Promise<void> => {
    await expect(stat(skillFile())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(designFile())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(libFile())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dir, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  };

  interface FakeClaude {
    run: ReturnType<typeof vi.fn<RunCommand>>;
    calls: () => string[][];
  }

  /**
   * A fake `claude` CLI, matching what the real one does (observed with a throwaway
   * CLAUDE_CONFIG_DIR): `add-json --scope user` fails with "MCP server <name> already
   * exists in user config" only when a user-scope server has that name; a local one
   * doesn't block it. `remove --scope user` removes the user-scope one. `get` is never
   * expected.
   */
  const fakeClaude = (
    options: {
      existsAt?: 'user' | 'local';
      notInstalled?: boolean;
      /** Overrides every add-json result. */
      add?: CommandResult;
      /** Overrides every remove result. */
      remove?: CommandResult;
    } = {},
  ): FakeClaude => {
    let userExists = options.existsAt === 'user';
    const run = vi.fn<RunCommand>((command, args) => {
      expect(command).toBe('claude');

      if (options.notInstalled) {
        return Promise.reject(
          Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', errno: -2 }),
        );
      }

      // Both add-json and remove take: mcp <sub> --scope user <name> …
      const sub = args[1];
      const name = args[4] ?? '';

      expect(args.slice(2, 4)).toStrictEqual(['--scope', 'user']);

      if (sub === 'add-json') {
        if (options.add) {
          return Promise.resolve(options.add);
        }

        if (userExists) {
          return Promise.resolve({
            code: 1,
            stdout: '',
            stderr: `MCP server ${name} already exists in user config`,
          });
        }

        userExists = true;

        return Promise.resolve(ok(`Added http MCP server ${name} to user config`));
      }

      if (sub === 'remove') {
        if (options.remove) {
          return Promise.resolve(options.remove);
        }

        if (userExists) {
          userExists = false;

          return Promise.resolve(ok(`Removed MCP server ${name} from user config`));
        }

        return Promise.resolve({
          code: 1,
          stdout: '',
          stderr: `No user-scoped MCP server found with name: ${name}`,
        });
      }

      throw new Error(`unexpected claude call: ${args.join(' ')}`);
    });

    return { run, calls: () => run.mock.calls.map(([, args]) => [...args]) };
  };

  const STAGING_CONFIG = {
    type: 'http',
    url: 'https://staging.kizen.com/api/mcp',
    headersHelper: `npx -y @kizenapps/cli@${TEST_CLI_VERSION} auth-header`,
  };
  const ADD_STAGING = [
    'mcp',
    'add-json',
    '--scope',
    'user',
    'kizen-staging',
    JSON.stringify(STAGING_CONFIG),
  ];
  const REMOVE_STAGING = ['mcp', 'remove', '--scope', 'user', 'kizen-staging'];

  it('setup-claude --mcp registers kizen-<env> at user scope with the npx auth-header helper', async () => {
    await inPlugin();

    const claude = fakeClaude();
    const { deps, logs, errors, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

    await runSetupClaude(dir, { mcp: true, env: 'staging' }, deps);

    expect(claude.calls()).toStrictEqual([ADD_STAGING]);
    expect(JSON.parse(claude.calls()[0]?.[5] ?? '')).toStrictEqual(STAGING_CONFIG);
    // Only the registration runs; nothing is written in the plugin.
    await expectNoFiles();
    expect(logs).toStrictEqual([
      'Registered the MCP server kizen-staging (https://staging.kizen.com/api/mcp) in Claude Code at user scope.',
    ]);
    expect(errors).toStrictEqual([]);
    expect(exitCodes).toStrictEqual([]);
  });

  it('registers go by default, on the production API host', async () => {
    await inPlugin();

    const claude = fakeClaude();

    await runSetupClaude(dir, { mcp: true }, makeDeps(nodeClaudeFs, { run: claude.run }).deps);

    const config = JSON.parse(claude.calls()[0]?.[5] ?? '') as Record<string, string>;

    expect(claude.calls()[0]?.[4]).toBe('kizen-go');
    expect(config.url).toBe('https://app.go.kizen.com/api/mcp');
  });

  it('uses the published package name in the helper', async () => {
    const pkg = JSON.parse(
      await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8'),
    ) as { name: string };

    expect(CLI_PACKAGE_NAME).toBe(pkg.name);
  });

  it('setup-claude --mcp leaves an existing server alone without --force', async () => {
    await inPlugin();

    const claude = fakeClaude({ existsAt: 'user' });
    const { deps, logs, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

    await runSetupClaude(dir, { mcp: true, env: 'staging' }, deps);

    expect(claude.calls()).toStrictEqual([ADD_STAGING]);
    expect(logs.at(-1)).toBe(
      'MCP server kizen-staging already exists in Claude Code; left unchanged. Pass --force to replace it.',
    );
    expect(exitCodes).toStrictEqual([]);
  });

  it('--force replaces it (remove then add)', async () => {
    await inPlugin();

    const claude = fakeClaude({ existsAt: 'user' });
    const { deps, logs, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

    await runSetupClaude(dir, { mcp: true, env: 'staging', force: true }, deps);

    expect(claude.calls()).toStrictEqual([ADD_STAGING, REMOVE_STAGING, ADD_STAGING]);
    expect(logs.at(-1)).toContain('Registered the MCP server kizen-staging');
    expect(exitCodes).toStrictEqual([]);
  });

  it('--force reports a failed remove with its output', async () => {
    await inPlugin();

    const claude = fakeClaude({
      existsAt: 'user',
      remove: { code: 1, stdout: '', stderr: 'EACCES: permission denied, open ~/.claude.json' },
    });
    const { deps, logs, errors, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

    await runSetupClaude(dir, { mcp: true, env: 'staging', force: true }, deps);

    expect(claude.calls()).toStrictEqual([ADD_STAGING, REMOVE_STAGING]);
    expect(exitCodes).toStrictEqual([1]);
    expect(errors).toStrictEqual([
      "Error: couldn't register the MCP server kizen-staging: claude mcp remove --scope user exited 1: EACCES: permission denied, open ~/.claude.json",
    ]);
    expect(logs.some((line) => line.includes('Registered'))).toBe(false);
    await expectNoFiles();
  });

  it('--force reports when the re-add fails after removing the old server', async () => {
    await inPlugin();

    let adds = 0;
    const claude = fakeClaude({ existsAt: 'user' });
    const run = vi.fn<RunCommand>((command, args) => {
      // The second add-json (after the remove) fails; everything else is the fake's.
      if (args[1] === 'add-json' && ++adds === 2) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'Failed to write config' });
      }

      return claude.run(command, args);
    });
    const { deps, logs, errors, exitCodes } = makeDeps(nodeClaudeFs, { run });

    await runSetupClaude(dir, { mcp: true, env: 'staging', force: true }, deps);

    expect(run.mock.calls.map(([, args]) => [...args])).toStrictEqual([
      ADD_STAGING,
      REMOVE_STAGING,
      ADD_STAGING,
    ]);
    expect(exitCodes).toStrictEqual([1]);
    expect(errors).toStrictEqual([
      "Error: couldn't register the MCP server kizen-staging: claude mcp add-json exited 1: Failed to write config",
      'The old kizen-staging registration was already removed, so Claude Code has no kizen-staging server now. Re-run `appbuilder setup-claude --mcp --env staging`, or run:',
      `  claude mcp add-json --scope user kizen-staging '${JSON.stringify(STAGING_CONFIG)}'`,
    ]);
    expect(logs.some((line) => line.includes('Registered'))).toBe(false);
  });

  it('setup-claude --mcp prints the command when claude is not installed and still exits 0', async () => {
    await inPlugin();

    const claude = fakeClaude({ notInstalled: true });
    const { deps, logs, errors, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

    await runSetupClaude(dir, { mcp: true, env: 'staging' }, deps);

    expect(logs.slice(-2)).toStrictEqual([
      "Claude Code's `claude` command wasn't found. To register the MCP server, run (in a POSIX shell such as bash or zsh):",
      `  claude mcp add-json --scope user kizen-staging '${JSON.stringify(STAGING_CONFIG)}'`,
    ]);
    expect(errors).toStrictEqual([]);
    expect(exitCodes).toStrictEqual([]);
    await expectNoFiles();
  });

  it('setup-claude --mcp --dry-run runs nothing and prints the command', async () => {
    await inPlugin();

    const claude = fakeClaude();
    const { deps, logs, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

    await runSetupClaude(dir, { mcp: true, env: 'staging', dryRun: true }, deps);

    expect(claude.run).not.toHaveBeenCalled();
    expect(logs.at(-1)).toBe(
      `Dry run: would register the MCP server kizen-staging with: claude mcp add-json --scope user kizen-staging '${JSON.stringify(STAGING_CONFIG)}'`,
    );
    await expect(stat(skillFile())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(exitCodes).toStrictEqual([]);
  });

  it('setup-claude without --mcp never invokes claude', async () => {
    await inPlugin();

    const claude = fakeClaude();
    const hasOAuthSession = vi.fn(() => Promise.resolve(false));
    const { deps, logs } = makeDeps(nodeClaudeFs, { run: claude.run, hasOAuthSession });

    await runSetupClaude(dir, {}, deps);
    await runSetupClaude(dir, { dryRun: true, includeLib: true }, deps);

    expect(claude.run).not.toHaveBeenCalled();
    expect(hasOAuthSession).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('MCP'))).toBe(false);
  });

  it('setup-claude --mcp hints login when no session exists for the env', async () => {
    await inPlugin();

    const signedOut = vi.fn(() => Promise.resolve(false));
    const without = makeDeps(nodeClaudeFs, { run: fakeClaude().run, hasOAuthSession: signedOut });

    await runSetupClaude(dir, { mcp: true, env: 'integration' }, without.deps);

    expect(signedOut).toHaveBeenCalledWith('integration');
    expect(without.logs.at(-1)).toBe(
      "You're not signed in to integration yet. Run `appbuilder login --env integration` before using kizen-integration.",
    );
    expect(without.exitCodes).toStrictEqual([]);

    const signedIn = makeDeps(nodeClaudeFs, {
      run: fakeClaude().run,
      hasOAuthSession: () => Promise.resolve(true),
    });

    await runSetupClaude(dir, { mcp: true, env: 'integration' }, signedIn.deps);
    expect(signedIn.logs.some((line) => line.includes('appbuilder login'))).toBe(false);
  });

  it('--mcp in a plugin leaves out-of-date managed files untouched', async () => {
    await writeFile(join(dir, 'kizen.json'), JSON.stringify({ entry: 'src' }), 'utf-8');
    await writeSkill('edited locally\n');
    await writeDesign('edited locally\n');
    await writeLib('export const mine = 1;\n');

    for (const options of [
      { mcp: true, env: 'staging' },
      { mcp: true, env: 'staging', force: true },
      { mcp: true, env: 'staging', dryRun: true },
    ]) {
      const claude = fakeClaude({ existsAt: 'user' });
      const fs = spyFs();
      const { deps, logs, exitCodes } = makeDeps(fs, { run: claude.run });

      await runSetupClaude(dir, options, deps);

      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(
        logs.some((line) =>
          /^(created|updated|unchanged) |Claude files|nothing written/.test(line),
        ),
      ).toBe(false);
      expect(exitCodes).toStrictEqual([]);
    }

    expect(await readSkill()).toBe('edited locally\n');
    expect(await readDesign()).toBe('edited locally\n');
    expect(await readLib()).toBe('export const mine = 1;\n');
  });

  it('--mcp with --include-lib is a usage error, in or out of a plugin', async () => {
    for (const plugin of [false, true]) {
      if (plugin) {
        await inPlugin();
      }

      for (const options of [
        { mcp: true, includeLib: true },
        { mcp: true, includeLib: true, dryRun: true, env: 'staging' },
      ]) {
        const claude = fakeClaude();
        const hasOAuthSession = vi.fn(() => Promise.resolve(true));
        const fs = spyFs();
        const { deps, logs, errors, exitCodes } = makeDeps(fs, {
          run: claude.run,
          hasOAuthSession,
        });

        await runSetupClaude(dir, options, deps);

        expect(errors).toStrictEqual([
          "Error: --mcp and --include-lib can't be combined. Run `appbuilder setup-claude --include-lib` and `appbuilder setup-claude --mcp` separately.",
        ]);
        expect(exitCodes).toStrictEqual([1]);
        expect(logs).toStrictEqual([]);
        expect(claude.run).not.toHaveBeenCalled();
        expect(hasOAuthSession).not.toHaveBeenCalled();
        expect(fs.writeFile).not.toHaveBeenCalled();
        await expectNoFiles();
      }
    }
  });

  describe('without kizen.json', () => {
    it('--mcp registers the server only, writing no files, and exits 0', async () => {
      const claude = fakeClaude();
      const fs = spyFs();
      const { deps, logs, errors, exitCodes } = makeDeps(fs, { run: claude.run });

      await runSetupClaude(dir, { mcp: true, env: 'staging' }, deps);

      expect(claude.calls()).toStrictEqual([ADD_STAGING]);
      expect(logs).toStrictEqual([
        'Registered the MCP server kizen-staging (https://staging.kizen.com/api/mcp) in Claude Code at user scope.',
      ]);
      expect(errors).toStrictEqual([]);
      expect(exitCodes).toStrictEqual([]);
      expect(fs.writeFile).not.toHaveBeenCalled();
      await expectNoFiles();
    });

    it('--mcp registers go by default', async () => {
      const claude = fakeClaude();

      await runSetupClaude(dir, { mcp: true }, makeDeps(nodeClaudeFs, { run: claude.run }).deps);

      expect(claude.calls()[0]?.[4]).toBe('kizen-go');
    });

    it('--mcp --dry-run runs nothing, writes nothing and prints the command', async () => {
      const claude = fakeClaude();
      const hasOAuthSession = vi.fn(() => Promise.resolve(false));
      const { deps, logs, errors, exitCodes } = makeDeps(nodeClaudeFs, {
        run: claude.run,
        hasOAuthSession,
      });

      await runSetupClaude(dir, { mcp: true, env: 'staging', dryRun: true }, deps);

      expect(claude.run).not.toHaveBeenCalled();
      expect(hasOAuthSession).not.toHaveBeenCalled();
      expect(logs).toStrictEqual([
        `Dry run: would register the MCP server kizen-staging with: claude mcp add-json --scope user kizen-staging '${JSON.stringify(STAGING_CONFIG)}'`,
      ]);
      expect(errors).toStrictEqual([]);
      expect(exitCodes).toStrictEqual([]);
      await expectNoFiles();
    });

    it('--mcp leaves an existing server alone without --force and replaces it with --force', async () => {
      const kept = fakeClaude({ existsAt: 'user' });
      const keep = makeDeps(nodeClaudeFs, { run: kept.run });

      await runSetupClaude(dir, { mcp: true, env: 'staging' }, keep.deps);

      expect(kept.calls()).toStrictEqual([ADD_STAGING]);
      expect(keep.logs.at(-1)).toBe(
        'MCP server kizen-staging already exists in Claude Code; left unchanged. Pass --force to replace it.',
      );
      expect(keep.exitCodes).toStrictEqual([]);

      const replaced = fakeClaude({ existsAt: 'user' });
      const replace = makeDeps(nodeClaudeFs, { run: replaced.run });

      await runSetupClaude(dir, { mcp: true, env: 'staging', force: true }, replace.deps);

      expect(replaced.calls()).toStrictEqual([ADD_STAGING, REMOVE_STAGING, ADD_STAGING]);
      expect(replace.logs.at(-1)).toContain('Registered the MCP server kizen-staging');
      expect(replace.exitCodes).toStrictEqual([]);
      await expectNoFiles();
    });

    it('--mcp prints the command when claude is not installed and still exits 0', async () => {
      const claude = fakeClaude({ notInstalled: true });
      const { deps, logs, errors, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

      await runSetupClaude(dir, { mcp: true, env: 'staging' }, deps);

      expect(logs).toStrictEqual([
        "Claude Code's `claude` command wasn't found. To register the MCP server, run (in a POSIX shell such as bash or zsh):",
        `  claude mcp add-json --scope user kizen-staging '${JSON.stringify(STAGING_CONFIG)}'`,
      ]);
      expect(errors).toStrictEqual([]);
      expect(exitCodes).toStrictEqual([]);
    });

    it('--mcp hints login when no session exists for the env', async () => {
      const signedOut = vi.fn(() => Promise.resolve(false));
      const { deps, logs, exitCodes } = makeDeps(nodeClaudeFs, {
        run: fakeClaude().run,
        hasOAuthSession: signedOut,
      });

      await runSetupClaude(dir, { mcp: true, env: 'integration' }, deps);

      expect(signedOut).toHaveBeenCalledWith('integration');
      expect(logs.at(-1)).toBe(
        "You're not signed in to integration yet. Run `appbuilder login --env integration` before using kizen-integration.",
      );
      expect(exitCodes).toStrictEqual([]);
    });

    it('--mcp sets exit 1 when registering fails', async () => {
      const claude = fakeClaude({ add: { code: 1, stdout: '', stderr: 'Invalid configuration' } });
      const { deps, errors, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

      await runSetupClaude(dir, { mcp: true, env: 'staging' }, deps);

      expect(errors).toStrictEqual([
        "Error: couldn't register the MCP server kizen-staging: claude mcp add-json exited 1: Invalid configuration",
      ]);
      expect(exitCodes).toStrictEqual([1]);
    });

    it('--include-lib without --mcp fails before any side effect', async () => {
      const claude = fakeClaude();
      const fs = spyFs();
      const { deps, logs, errors, exitCodes } = makeDeps(fs, { run: claude.run });

      await runSetupClaude(dir, { includeLib: true }, deps);

      expect(errors).toStrictEqual([
        'Error: kizen.json not found. Run this command from a plugin directory, or pass --mcp to only register the MCP server.',
      ]);
      expect(exitCodes).toStrictEqual([1]);
      expect(logs).toStrictEqual([]);
      expect(claude.run).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
      await expectNoFiles();
    });

    it('without --mcp fails with exit 1, runs nothing and writes nothing', async () => {
      const claude = fakeClaude();
      const { deps, logs, errors, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

      await runSetupClaude(dir, { dryRun: true }, deps);

      expect(errors).toStrictEqual([
        'Error: kizen.json not found. Run this command from a plugin directory, or pass --mcp to only register the MCP server.',
      ]);
      expect(exitCodes).toStrictEqual([1]);
      expect(logs).toStrictEqual([]);
      expect(claude.run).not.toHaveBeenCalled();
      await expectNoFiles();
    });

    it('still rejects --env without --mcp as a usage error first', async () => {
      const { deps, errors, exitCodes } = makeDeps();

      await runSetupClaude(dir, { env: 'staging' }, deps);

      expect(errors).toStrictEqual(['Error: --env and --force only apply with --mcp.']);
      expect(exitCodes).toStrictEqual([1]);
    });
  });

  it('--env or --force without --mcp is a usage error', async () => {
    await inPlugin();

    const claude = fakeClaude();
    const { deps, errors, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

    await runSetupClaude(dir, { env: 'staging' }, deps);

    expect(errors).toStrictEqual(['Error: --env and --force only apply with --mcp.']);
    expect(exitCodes).toStrictEqual([1]);
    expect(claude.run).not.toHaveBeenCalled();
    // Rejected before anything is written.
    await expect(stat(skillFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('unknown --env is rejected', async () => {
    await inPlugin();

    const claude = fakeClaude();
    const { deps, errors, exitCodes } = makeDeps(nodeClaudeFs, { run: claude.run });

    await runSetupClaude(dir, { mcp: true, env: 'prod' }, deps);

    expect(errors).toStrictEqual([
      'Error: Unknown --env "prod". Use one of: go, fmo, staging, integration, test1.',
    ]);
    expect(exitCodes).toStrictEqual([1]);
    expect(claude.run).not.toHaveBeenCalled();
    await expect(stat(skillFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mcp step failure sets exit 1 and writes nothing', async () => {
    await inPlugin();

    // Even with --force: an add-json failure that isn't "already exists" never leads to remove.
    const addFails = fakeClaude({
      existsAt: 'user',
      add: { code: 1, stdout: '', stderr: 'Invalid configuration\nsomething went wrong' },
    });
    const first = makeDeps(nodeClaudeFs, { run: addFails.run });

    await runSetupClaude(dir, { mcp: true, env: 'staging', force: true }, first.deps);

    expect(addFails.calls()).toStrictEqual([ADD_STAGING]);
    expect(first.errors).toStrictEqual([
      "Error: couldn't register the MCP server kizen-staging: claude mcp add-json exited 1: Invalid configuration something went wrong",
    ]);
    expect(first.logs.some((line) => line.includes('left unchanged'))).toBe(false);
    expect(first.exitCodes).toStrictEqual([1]);
    await expectNoFiles();

    // A spawn error other than ENOENT is a failure too, not the "not installed" path.
    const broken = makeDeps(nodeClaudeFs, {
      run: () =>
        Promise.reject(Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' })),
    });

    await runSetupClaude(dir, { mcp: true, env: 'staging' }, broken.deps);
    expect(broken.exitCodes).toStrictEqual([1]);
    expect(broken.errors[0]).toContain('EACCES');
    await expectNoFiles();
  });
});

describe('runCommand', () => {
  // Uses node itself, never `claude`, to check the shapes the MCP step relies on.
  it('returns the exit code and output of a program run with argv', async () => {
    await expect(
      runCommand(process.execPath, [
        '-e',
        'process.stdout.write("out " + process.argv[1]); process.stderr.write("err"); process.exit(3)',
        "it's one arg",
      ]),
    ).resolves.toStrictEqual({ code: 3, stdout: "out it's one arg", stderr: 'err' });
  });

  it('rejects with ENOENT when the program is not installed', async () => {
    await expect(
      runCommand('appbuilder-test-no-such-program-7c1e', ['mcp', 'get', 'x']),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
