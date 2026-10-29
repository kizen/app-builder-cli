import { join } from 'node:path';
import { AGENT_HARNESSES, AGENT_HARNESS_INFO, type AgentHarness } from './agentHarness.js';
import type { ScaffoldedFile } from './createArtifacts.js';
import { agentFiles, kizenDataLibPath, managedSkillEntryPaths } from './createCopilotFiles.js';
import { errorMessage, normalizeEntryDir } from './guards.js';
import {
  applyManagedFiles,
  formatManagedFileLine,
  nodeManagedFs,
  planManagedFiles,
  type ManagedFilePlan,
  type ManagedFileStatus,
  type ManagedFs,
} from './managedFiles.js';

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

const manifestEntryDirs = async (dir: string, fs: ManagedFs): Promise<string[]> => {
  try {
    const manifest = await fs.readFile(join(dir, 'kizen.json'));

    return manifest === undefined ? ['src'] : entryDirsOf(JSON.parse(manifest));
  } catch {
    return ['src'];
  }
};

export async function pluginAgentFiles(
  dir: string,
  harness: AgentHarness,
  fs: ManagedFs = nodeManagedFs,
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

  return agentFiles(harness, libEntryDirs);
}

export async function isAgentFilesStale(
  dir: string,
  harness: AgentHarness,
  fs: ManagedFs = nodeManagedFs,
): Promise<boolean> {
  try {
    const installed = await Promise.all(
      managedSkillEntryPaths(harness).map(
        async (path) => (await fs.readFile(join(dir, path))) !== undefined,
      ),
    );

    if (!installed.includes(true)) {
      return false;
    }

    const plan = await planManagedFiles(dir, await pluginAgentFiles(dir, harness, fs), fs);

    return plan.some((entry) => entry.status !== 'unchanged');
  } catch {
    return false;
  }
}

export async function staleAgentFileWarnings(
  dir: string,
  fs: ManagedFs = nodeManagedFs,
): Promise<string[]> {
  const stale = await Promise.all(
    AGENT_HARNESSES.map((harness) => isAgentFilesStale(dir, harness, fs)),
  );

  return AGENT_HARNESSES.filter((_harness, index) => stale[index] === true).map(
    (harness) => AGENT_HARNESS_INFO[harness].staleWarning,
  );
}

export interface AgentFilesDeps {
  fs: ManagedFs;
  log: (line: string) => void;
  error: (line: string) => void;
  setExitCode: (code: number) => void;
}

const count = (plan: readonly ManagedFilePlan[], status: ManagedFileStatus): string =>
  `${String(plan.filter((entry) => entry.status === status).length)} ${status}`;

export async function setupAgentFiles(
  dir: string,
  harness: AgentHarness,
  options: { dryRun: boolean; includeLib: boolean; notFoundHint?: string },
  deps: AgentFilesDeps,
): Promise<void> {
  if (!(await deps.fs.exists(join(dir, 'kizen.json')))) {
    deps.error(
      `Error: kizen.json not found. Run this command from a plugin directory${options.notFoundHint ?? ''}.`,
    );
    deps.setExitCode(1);

    return;
  }

  let plan: ManagedFilePlan[];

  try {
    plan = await applyManagedFiles(
      dir,
      await pluginAgentFiles(dir, harness, deps.fs, { includeLib: options.includeLib }),
      { dryRun: options.dryRun },
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
    options.dryRun
      ? `Dry run: ${counts}; nothing written (${managed}).`
      : `${AGENT_HARNESS_INFO[harness].filesLabel} files: ${counts} (${managed}).`,
  );
}
