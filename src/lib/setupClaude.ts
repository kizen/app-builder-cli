import { spawn } from 'node:child_process';
import { apiOriginFor } from '../../shared/lib/kizenUrls.js';
import { AGENT_HARNESS_INFO } from './agentHarness.js';
import { isAgentFilesStale, pluginAgentFiles, setupAgentFiles } from './agentSetup.js';
import type { ScaffoldedFile } from './createArtifacts.js';
import { parseEnvironment, type Environment } from './credentials.js';
import { errorMessage, isErrnoCode } from './guards.js';
import { nodeManagedFs, type ManagedFs } from './managedFiles.js';
import { DEFAULT_LOGIN_ENVIRONMENT, loginCommandFor } from './oauth.js';
import { createOAuthStore } from './oauthStore.js';
import { quoteArg } from './shellArg.js';

export { entryDirsOf } from './agentSetup.js';

export const CLAUDE_SKILL_PATH = '.claude/skills/kizen-custom-block/SKILL.md';

export const STALE_CLAUDE_SKILL_WARNING = AGENT_HARNESS_INFO.claude.staleWarning;

export type ClaudeFs = ManagedFs;

export const nodeClaudeFs: ClaudeFs = nodeManagedFs;

/** The Claude files appbuilder manages in this plugin (`pluginAgentFiles` for Claude Code). */
export const pluginClaudeFiles = (
  dir: string,
  fs: ClaudeFs = nodeClaudeFs,
  options: { includeLib?: boolean } = {},
): Promise<ScaffoldedFile[]> => pluginAgentFiles(dir, 'claude', fs, options);

/** Whether the plugin's Claude files are out of date (`isAgentFilesStale` for Claude Code). */
export const isClaudeSkillStale = (dir: string, fs: ClaudeFs = nodeClaudeFs): Promise<boolean> =>
  isAgentFilesStale(dir, 'claude', fs);

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

  await setupAgentFiles(
    dir,
    'claude',
    {
      dryRun,
      includeLib: options.includeLib === true,
      notFoundHint: ', or pass --mcp to only register the MCP server',
    },
    deps,
  );
}
