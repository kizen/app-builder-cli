import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { apiOriginFor } from '../../shared/lib/kizenUrls.js';
import type { ScaffoldedFile } from './createArtifacts.js';
import { parseEnvironment, type Environment } from './credentials.js';
import { claudeFiles, kizenDataLibPath } from './createCopilotFiles.js';
import { errorMessage, isErrnoCode, normalizeEntryDir } from './guards.js';
import {
  applyManagedFiles,
  formatManagedFileLine,
  nodeManagedFs,
  planManagedFiles,
  type ManagedFilePlan,
  type ManagedFileStatus,
  type ManagedFs,
} from './managedFiles.js';
import { DEFAULT_LOGIN_ENVIRONMENT, loginCommandFor } from './oauth.js';
import { createOAuthStore } from './oauthStore.js';
import { quoteArg } from './shellArg.js';

export const CLAUDE_SKILL_PATH = '.claude/skills/kizen-custom-block/SKILL.md';

export const STALE_CLAUDE_SKILL_WARNING =
  'Claude files managed by appbuilder are out of date; run appbuilder setup-claude';

export type ClaudeFs = ManagedFs;

export const nodeClaudeFs: ClaudeFs = nodeManagedFs;

/** A kizen.json `entry` as a root-relative directory, or undefined when blank or outside the plugin. */
const entryDirOf = (entry: unknown): string | undefined => {
  if (typeof entry !== 'string' || entry.trim() === '') {
    return undefined;
  }

  const normalized = normalizeEntryDir(entry);

  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return undefined;
  }

  return normalized;
};

export function entryDirsOf(manifest: unknown): string[] {
  const manifests: unknown[] = Array.isArray(manifest) ? manifest : [manifest];
  const entryDirs = manifests
    .map((entry) =>
      typeof entry === 'object' && entry !== null && 'entry' in entry
        ? entryDirOf(entry.entry)
        : undefined,
    )
    .filter((entryDir): entryDir is string => entryDir !== undefined);

  return entryDirs.length > 0 ? [...new Set(entryDirs)] : ['src'];
}

const manifestEntryDirs = async (dir: string, fs: ClaudeFs): Promise<string[]> => {
  try {
    const manifest = await fs.readFile(join(dir, 'kizen.json'));

    return manifest === undefined ? ['src'] : entryDirsOf(JSON.parse(manifest));
  } catch {
    return ['src'];
  }
};

/**
 * The Claude files appbuilder manages in this plugin: always the skill and its design guide,
 * and the data lib under each entry directory when `includeLib` is set or that lib already exists.
 */
export async function pluginClaudeFiles(
  dir: string,
  fs: ClaudeFs = nodeClaudeFs,
  options: { includeLib?: boolean } = {},
): Promise<ScaffoldedFile[]> {
  const entryDirs = await manifestEntryDirs(dir, fs);
  const libEntryDirs =
    options.includeLib === true
      ? entryDirs
      : (
          await Promise.all(
            entryDirs.map(async (entryDir) =>
              (await fs.exists(join(dir, kizenDataLibPath(entryDir)))) ? entryDir : undefined,
            ),
          )
        ).filter((entryDir): entryDir is string => entryDir !== undefined);

  return claudeFiles(libEntryDirs);
}

export async function isClaudeSkillStale(
  dir: string,
  fs: ClaudeFs = nodeClaudeFs,
): Promise<boolean> {
  try {
    const managed = await pluginClaudeFiles(dir, fs);

    if (!managed.some((file) => file.path === CLAUDE_SKILL_PATH)) {
      return false;
    }

    if ((await fs.readFile(join(dir, CLAUDE_SKILL_PATH))) === undefined) {
      return false;
    }

    const plan = await planManagedFiles(dir, managed, fs);

    return plan.some((entry) => entry.status !== 'unchanged');
  } catch {
    return false;
  }
}

/** The published package name (package.json `name`; a test keeps them equal). */
export const CLI_PACKAGE_NAME = '@kizenapps/cli';

/** Per `claude mcp …` call; a call still running is killed and reported as a failure. */
const CLAUDE_COMMAND_TIMEOUT_MS = 60_000;

export interface CommandResult {
  /** Exit code, or null when the process was killed (e.g. on timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program with argv (no shell). Rejects with the spawn error, e.g. ENOENT. */
export type RunCommand = (command: string, args: readonly string[]) => Promise<CommandResult>;

export const runCommand: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLAUDE_COMMAND_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

export interface SetupClaudeDeps {
  fs: ClaudeFs;
  log: (line: string) => void;
  error: (line: string) => void;
  setExitCode: (code: number) => void;
  /** Runs `claude`; injected so tests never run the real one. */
  run: RunCommand;
  /** Throws (an OAuthError saying how to sign in again) when the session can't be read. */
  hasOAuthSession: (environment: Environment) => Promise<boolean>;
  /** The running CLI's version, which the MCP helper pins. */
  cliVersion: string;
}

export const createDefaultSetupClaudeDeps = (cliVersion: string): SetupClaudeDeps => ({
  run: runCommand,
  hasOAuthSession: async (environment) =>
    (await createOAuthStore().readSession(environment)) !== null,
  cliVersion,
  fs: nodeClaudeFs,
  log: (line) => {
    console.log(line);
  },
  error: (line) => {
    console.error(line);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

const count = (plan: readonly ManagedFilePlan[], status: ManagedFileStatus): string =>
  `${String(plan.filter((entry) => entry.status === status).length)} ${status}`;

export interface SetupClaudeOptions {
  dryRun?: boolean;
  includeLib?: boolean;
  mcp?: boolean;
  env?: string;
  force?: boolean;
}

interface McpServerPlan {
  environment: Environment;
  name: string;
  url: string;
  /** argv for `claude` (after the program name). */
  addArgs: string[];
  /** The same command, quoted for a POSIX shell, for the user to run. */
  addCommand: string;
}

export function mcpServerPlan(environment: Environment, cliVersion: string): McpServerPlan {
  const name = `kizen-${environment}`;
  const url = `${apiOriginFor(environment)}/api/mcp`;
  const config = JSON.stringify({
    type: 'http',
    url,
    // Pinned, so npx never resolves a published CLI without `auth-header` or one the user didn't
    // choose; `--force` after an upgrade re-pins it. No --env: auth-header reads the server URL.
    headersHelper: `npx -y ${CLI_PACKAGE_NAME}@${cliVersion} auth-header`,
  });
  const addArgs = ['mcp', 'add-json', '--scope', 'user', name, config];

  return {
    environment,
    name,
    url,
    addArgs,
    addCommand: ['claude', ...addArgs].map(quoteArg).join(' '),
  };
}

function usageProblem(options: SetupClaudeOptions): string | undefined {
  if (options.mcp !== true && (options.env !== undefined || options.force === true)) {
    return '--env and --force only apply with --mcp.';
  }

  if (options.mcp === true && options.includeLib === true) {
    return "--mcp and --include-lib can't be combined. Run `appbuilder setup-claude --include-lib` and `appbuilder setup-claude --mcp` separately.";
  }

  return options.env === undefined ? undefined : parseEnvironment(options.env).message;
}

/**
 * The name is taken at user scope. Observed: `MCP server <name> already exists in user config`.
 * Claude Code's wording isn't a documented contract, so the match is loose and ignores case.
 */
const alreadyExists = (result: CommandResult): boolean =>
  /already\s+exists/i.test(`${result.stdout}\n${result.stderr}`);

const outputOf = (result: CommandResult): string => {
  const text = (result.stderr.trim() || result.stdout.trim()).replace(/\s+/g, ' ');
  const status =
    result.code === null ? 'was stopped (timed out?)' : `exited ${String(result.code)}`;

  return text === '' ? status : `${status}: ${text}`;
};

/** Never throws; failures set exit code 1. A missing `claude` prints the command to run instead. */
async function setupMcpServer(
  environment: Environment,
  options: { dryRun: boolean; force: boolean },
  deps: SetupClaudeDeps,
): Promise<void> {
  const plan = mcpServerPlan(environment, deps.cliVersion);
  const { name } = plan;
  let removedOld = false;
  const fail = (detail: string): void => {
    deps.error(`Error: couldn't register the MCP server ${name}: ${detail}`);

    if (removedOld) {
      deps.error(
        `The old ${name} registration was already removed, so Claude Code has no ${name} server now. Re-run \`appbuilder setup-claude --mcp --env ${environment}\`, or run:`,
      );
      deps.error(`  ${plan.addCommand}`);
    }

    deps.setExitCode(1);
  };

  if (options.dryRun) {
    deps.log(`Dry run: would register the MCP server ${plan.name} with: ${plan.addCommand}`);

    return;
  }

  try {
    // Add straight away at user scope; `claude mcp get` isn't used because it
    // sees every scope and health-checks the server by running the helper.
    let added = await deps.run('claude', plan.addArgs);

    if (added.code !== 0 && alreadyExists(added)) {
      if (!options.force) {
        deps.log(
          `MCP server ${plan.name} already exists in Claude Code; left unchanged. Pass --force to replace it.`,
        );

        return;
      }

      // "Already exists" here means a user-scope server: Claude Code checks only the
      // target scope, so a local or project server with this name doesn't block the add.
      const removed = await deps.run('claude', ['mcp', 'remove', '--scope', 'user', plan.name]);

      if (removed.code !== 0) {
        fail(`claude mcp remove --scope user ${outputOf(removed)}`);

        return;
      }

      // From here a failure leaves no kizen-<env> at user scope, so say so.
      removedOld = true;
      added = await deps.run('claude', plan.addArgs);
    }

    if (added.code !== 0) {
      fail(`claude mcp add-json ${outputOf(added)}`);

      return;
    }
  } catch (error) {
    // After --force removed the old registration, even ENOENT is a failure: the
    // user has lost the server, so they get the removal note and exit 1.
    if (!removedOld && isErrnoCode(error, 'ENOENT')) {
      deps.log(
        "Claude Code's `claude` command wasn't found. To register the MCP server, run (in a POSIX shell such as bash or zsh):",
      );
      deps.log(`  ${plan.addCommand}`);

      return;
    }

    fail(errorMessage(error));

    return;
  }

  deps.log(`Registered the MCP server ${plan.name} (${plan.url}) in Claude Code at user scope.`);

  // The hint is advisory, so an unreadable session doesn't fail setup; its
  // error (which says how to sign in again) is the hint.
  try {
    if (!(await deps.hasOAuthSession(environment))) {
      deps.log(
        `You're not signed in to ${environment} yet. Run \`${loginCommandFor(environment)}\` before using ${plan.name}.`,
      );
    }
  } catch (error) {
    deps.log(errorMessage(error));
  }
}

export async function runSetupClaude(
  dir: string,
  options: SetupClaudeOptions,
  deps: SetupClaudeDeps,
): Promise<void> {
  const problem = usageProblem(options);

  if (problem !== undefined) {
    deps.error(`Error: ${problem}`);
    deps.setExitCode(1);

    return;
  }

  const dryRun = options.dryRun === true;

  // --mcp only registers the user-scope server and never writes files, in or out of a plugin,
  // so running it from any directory can't rewrite a repo's managed files.
  if (options.mcp === true) {
    await setupMcpServer(
      (options.env === undefined ? undefined : parseEnvironment(options.env).environment) ??
        DEFAULT_LOGIN_ENVIRONMENT,
      { dryRun, force: options.force === true },
      deps,
    );

    return;
  }

  if (!(await deps.fs.exists(join(dir, 'kizen.json')))) {
    deps.error(
      'Error: kizen.json not found. Run this command from a plugin directory, or pass --mcp to only register the MCP server.',
    );
    deps.setExitCode(1);

    return;
  }

  let plan: ManagedFilePlan[];

  try {
    plan = await applyManagedFiles(
      dir,
      await pluginClaudeFiles(dir, deps.fs, { includeLib: options.includeLib === true }),
      { dryRun },
      deps.fs,
    );
  } catch (error) {
    deps.error(`Error: ${errorMessage(error)}`);
    deps.setExitCode(1);

    return;
  }

  for (const entry of plan) {
    deps.log(formatManagedFileLine(entry));
  }

  const counts = `${count(plan, 'created')}, ${count(plan, 'updated')}, ${count(plan, 'unchanged')}`;
  const managed = 'these files are managed by appbuilder, so local edits to them are replaced';

  deps.log(
    dryRun
      ? `Dry run: ${counts}; nothing written (${managed}).`
      : `Claude files: ${counts} (${managed}).`,
  );
}
