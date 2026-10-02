import { join } from 'node:path';
import type { ScaffoldedFile } from './createArtifacts.js';
import { claudeFiles } from './createCopilotFiles.js';
import { normalizeEntryDir } from './guards.js';
import {
  applyManagedFiles,
  formatManagedFileLine,
  nodeManagedFs,
  planManagedFiles,
  type ManagedFilePlan,
  type ManagedFileStatus,
  type ManagedFs,
} from './managedFiles.js';

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

export async function pluginClaudeFiles(
  dir: string,
  fs: ClaudeFs = nodeClaudeFs,
): Promise<ScaffoldedFile[]> {
  try {
    const manifest = await fs.readFile(join(dir, 'kizen.json'));

    return claudeFiles(manifest === undefined ? undefined : entryDirsOf(JSON.parse(manifest)));
  } catch {
    return claudeFiles();
  }
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

export interface SetupClaudeDeps {
  fs: ClaudeFs;
  log: (line: string) => void;
  error: (line: string) => void;
  setExitCode: (code: number) => void;
}

export const defaultSetupClaudeDeps: SetupClaudeDeps = {
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

export async function runSetupClaude(
  dir: string,
  options: { dryRun?: boolean },
  deps: SetupClaudeDeps = defaultSetupClaudeDeps,
): Promise<void> {
  if (!(await deps.fs.exists(join(dir, 'kizen.json')))) {
    deps.error('Error: kizen.json not found. Run this command from a plugin directory.');
    deps.setExitCode(1);

    return;
  }

  const dryRun = options.dryRun === true;
  let plan: ManagedFilePlan[];

  try {
    plan = await applyManagedFiles(dir, await pluginClaudeFiles(dir, deps.fs), { dryRun }, deps.fs);
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
}
