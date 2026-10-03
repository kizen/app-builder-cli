import { copilotFiles } from './createCopilotFiles.js';
import { precheckTargetDir } from './createPlugin.js';
import { ensureGitignore } from './gitignore.js';
import { applyManagedFiles, type ManagedFilePlan, type ManagedFileStatus } from './managedFiles.js';

export type SetupCopilotStatus = ManagedFileStatus;

export type SetupCopilotFile = ManagedFilePlan;

export interface SetupCopilotResult {
  files: SetupCopilotFile[];
}

export interface SetupCopilotOptions {
  dryRun?: boolean;
}

export async function setupCopilot(
  pluginDir: string,
  options: SetupCopilotOptions = {},
): Promise<SetupCopilotResult> {
  if ((await precheckTargetDir(pluginDir)) !== 'has-manifest') {
    throw new Error(`No kizen.json found in ${pluginDir}`);
  }

  const dryRun = options.dryRun === true;

  const files = await applyManagedFiles(pluginDir, copilotFiles(), { dryRun });

  if (!dryRun) {
    ensureGitignore(pluginDir);
  }

  return { files };
}
