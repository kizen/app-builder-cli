import { AGENT_HARNESS_INFO } from './agentHarness.js';
import { isAgentFilesStale, setupAgentFiles, type AgentFilesDeps } from './agentSetup.js';
import { nodeManagedFs, type ManagedFs } from './managedFiles.js';

/**
 * `appbuilder setup-codex`: the same skills `setup-claude` writes, rendered for Codex and written
 * where Codex discovers repository skills (`.agents/skills/<name>/SKILL.md`), plus the data lib.
 * It has no --mcp: Codex can only take a headers helper from a hand-edited config.toml, and gives
 * the helper 10 seconds, which a cold `npx` install of the pinned CLI can exceed.
 */

export const CODEX_SKILL_PATH = `${AGENT_HARNESS_INFO.codex.skillsDir}/kizen-custom-block/SKILL.md`;

export const STALE_CODEX_SKILL_WARNING = AGENT_HARNESS_INFO.codex.staleWarning;

export type SetupCodexDeps = AgentFilesDeps;

export const createDefaultSetupCodexDeps = (): SetupCodexDeps => ({
  fs: nodeManagedFs,
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

export interface SetupCodexOptions {
  dryRun?: boolean;
  includeLib?: boolean;
}

/** Whether the plugin's Codex files are out of date (`isAgentFilesStale` for Codex). */
export const isCodexSkillStale = (dir: string, fs: ManagedFs = nodeManagedFs): Promise<boolean> =>
  isAgentFilesStale(dir, 'codex', fs);

export async function runSetupCodex(
  dir: string,
  options: SetupCodexOptions,
  deps: SetupCodexDeps,
): Promise<void> {
  await setupAgentFiles(
    dir,
    'codex',
    { dryRun: options.dryRun === true, includeLib: options.includeLib === true },
    deps,
  );
}
