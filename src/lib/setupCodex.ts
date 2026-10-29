import { AGENT_HARNESS_INFO } from './agentHarness.js';
import { isAgentFilesStale, setupAgentFiles, type AgentFilesDeps } from './agentSetup.js';
import { nodeManagedFs, type ManagedFs } from './managedFiles.js';

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
