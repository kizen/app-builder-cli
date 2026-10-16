import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BASE_URLS } from '../../shared/lib/kizenUrls.js';
import type { ScaffoldedFile } from './createArtifacts.js';
import { isEnvironment, unknownEnvironmentMessage, type Environment } from './credentials.js';
import { claudeFiles, kizenDataLibPath } from './createCopilotFiles.js';
import { isErrnoCode, normalizeEntryDir } from './guards.js';
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

/**
 * The headersHelper Claude Code runs. It's pinned to the running CLI's version,
 * so npx never resolves an older published CLI without `auth-header`, or a newer
 * one the user didn't choose; `setup-claude --mcp --force` after an upgrade
 * re-pins it. No --env: auth-header resolves it from the server URL.
 */
export const mcpHeadersHelper = (cliVersion: string): string =>
  `npx -y ${CLI_PACKAGE_NAME}@${cliVersion} auth-header`;

/** Bound on each `claude mcp …` call; a call still running after this is killed and reported as a failure. */
export const CLAUDE_COMMAND_TIMEOUT_MS = 60_000;

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
  /** The running CLI's version (package.json `version`), which the MCP helper pins. */
  cliVersion: string | undefined;
}

export const defaultSetupClaudeDeps: SetupClaudeDeps = {
  run: runCommand,
  hasOAuthSession: async (environment) =>
    (await createOAuthStore().readSession(environment)) !== null,
  // The command supplies it from the program's version (see commands/setupClaude.ts).
  cliVersion: undefined,
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
};

const count = (plan: readonly ManagedFilePlan[], status: ManagedFileStatus): string =>
  `${String(plan.filter((entry) => entry.status === status).length)} ${status}`;

export interface SetupClaudeOptions {
  dryRun?: boolean;
  includeLib?: boolean;
  mcp?: boolean;
  env?: string;
  force?: boolean;
}

export interface McpServerPlan {
  environment: Environment;
  name: string;
  url: string;
  /** argv for `claude` (after the program name). */
  addArgs: string[];
  /** The same command, quoted for a POSIX shell, for the user to run. */
  addCommand: string;
}

const shellQuote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

export function mcpServerPlan(environment: Environment, cliVersion: string): McpServerPlan {
  const name = `kizen-${environment}`;
  const url = `${new URL(BASE_URLS[environment]).origin}/api/mcp`;
  const config = JSON.stringify({
    type: 'http',
    url,
    headersHelper: mcpHeadersHelper(cliVersion),
  });
  const addArgs = ['mcp', 'add-json', '--scope', 'user', name, config];

  return {
    environment,
    name,
    url,
    addArgs,
    addCommand: ['claude', ...addArgs].map(shellQuote).join(' '),
  };
}

/** The flag combination problem, if any; checked before anything runs. */
function usageProblem(options: SetupClaudeOptions): string | undefined {
  if (options.mcp !== true && (options.env !== undefined || options.force === true)) {
    return '--env and --force only apply with --mcp.';
  }

  if (options.env !== undefined && !isEnvironment(options.env)) {
    return unknownEnvironmentMessage(options.env);
  }

  return undefined;
}

/**
 * Whether `claude mcp add-json` failed because the name is taken in the target
 * scope. Observed output (exit 1): `MCP server <name> already exists in user config`.
 * The wording isn't a documented contract, so this matches "already exists" loosely
 * and ignores case.
 */
const alreadyExists = (result: CommandResult): boolean =>
  /already\s+exists/i.test(`${result.stdout}\n${result.stderr}`);

const outputOf = (result: CommandResult): string => {
  const text = (result.stderr.trim() || result.stdout.trim()).replace(/\s+/g, ' ');
  const status =
    result.code === null ? 'was stopped (timed out?)' : `exited ${String(result.code)}`;

  return text === '' ? status : `${status}: ${text}`;
};

/**
 * Registers the Kizen MCP server for `environment` in Claude Code at user scope,
 * with `auth-header` as its headersHelper. Never throws; failures are reported
 * and set exit code 1. A missing `claude` prints the command to run instead.
 */
async function setupMcpServer(
  environment: Environment,
  options: { dryRun: boolean; force: boolean },
  deps: SetupClaudeDeps,
): Promise<void> {
  if (deps.cliVersion === undefined || deps.cliVersion === '') {
    deps.error(
      `Error: couldn't register the MCP server kizen-${environment}: the CLI's version is unknown, so the auth-header helper can't be pinned.`,
    );
    deps.setExitCode(1);

    return;
  }

  const plan = mcpServerPlan(environment, deps.cliVersion);
  const { name } = plan;
  /** Set once `--force` has removed the old registration. */
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

    if (added.code !== 0) {
      if (!alreadyExists(added)) {
        fail(`claude mcp add-json ${outputOf(added)}`);

        return;
      }

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

      if (added.code !== 0) {
        fail(`claude mcp add-json ${outputOf(added)}`);

        return;
      }
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

    fail(error instanceof Error ? error.message : String(error));

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
    deps.log(error instanceof Error ? error.message : String(error));
  }
}

export async function runSetupClaude(
  dir: string,
  options: SetupClaudeOptions,
  deps: SetupClaudeDeps = defaultSetupClaudeDeps,
): Promise<void> {
  const problem = usageProblem(options);

  if (problem !== undefined) {
    deps.error(`Error: ${problem}`);
    deps.setExitCode(1);

    return;
  }

  if (!(await deps.fs.exists(join(dir, 'kizen.json')))) {
    deps.error('Error: kizen.json not found. Run this command from a plugin directory.');
    deps.setExitCode(1);

    return;
  }

  const dryRun = options.dryRun === true;
  let plan: ManagedFilePlan[];

  try {
    plan = await applyManagedFiles(
      dir,
      await pluginClaudeFiles(dir, deps.fs, { includeLib: options.includeLib === true }),
      { dryRun },
      deps.fs,
    );
  } catch (error) {
    deps.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
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

  if (options.mcp === true) {
    await setupMcpServer(
      (options.env as Environment | undefined) ?? DEFAULT_LOGIN_ENVIRONMENT,
      { dryRun, force: options.force === true },
      deps,
    );
  }
}
