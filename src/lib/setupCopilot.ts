import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { copilotFiles } from './createCopilotFiles.js';
import { precheckTargetDir } from './createPlugin.js';
import { ensureGitignore } from './gitignore.js';
import type { ScaffoldedFile } from './createArtifacts.js';

export type SetupCopilotStatus = 'created' | 'updated' | 'unchanged';

export interface SetupCopilotFile {
  path: string;
  status: SetupCopilotStatus;
}

export interface SetupCopilotResult {
  files: SetupCopilotFile[];
}

export interface SetupCopilotOptions {
  dryRun?: boolean;
}

async function readIfPresent(fullPath: string): Promise<string | undefined> {
  try {
    return await readFile(fullPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw err;
  }
}

async function applyFile(
  pluginDir: string,
  file: ScaffoldedFile,
  dryRun: boolean,
): Promise<SetupCopilotFile> {
  const fullPath = join(pluginDir, ...file.path.split('/'));
  const existing = await readIfPresent(fullPath);

  if (existing === file.content) {
    return { path: file.path, status: 'unchanged' };
  }

  const status: SetupCopilotStatus = existing === undefined ? 'created' : 'updated';

  if (!dryRun) {
    await mkdir(dirname(fullPath), { recursive: true });

    await writeFile(fullPath, file.content, 'utf-8');
  }

  return { path: file.path, status };
}

export async function setupCopilot(
  pluginDir: string,
  options: SetupCopilotOptions = {},
): Promise<SetupCopilotResult> {
  if ((await precheckTargetDir(pluginDir)) !== 'has-manifest') {
    throw new Error(`No kizen.json found in ${pluginDir}`);
  }

  const dryRun = options.dryRun === true;

  const files = await Promise.all(copilotFiles().map((file) => applyFile(pluginDir, file, dryRun)));

  if (!dryRun) {
    ensureGitignore(pluginDir);
  }

  return { files };
}
