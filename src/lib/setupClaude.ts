import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { ScaffoldedFile } from './createArtifacts.js';
import { claudeFiles } from './createCopilotFiles.js';

export const CLAUDE_SKILL_PATH = '.claude/skills/kizen-custom-block/SKILL.md';

export const STALE_CLAUDE_SKILL_WARNING =
  'Claude files managed by appbuilder are out of date; run appbuilder setup-claude';

export type ClaudeFileStatus = 'created' | 'updated' | 'unchanged';

export interface ClaudeFilePlan {
  path: string;
  status: ClaudeFileStatus;
}

export interface ClaudeFs {
  readFile: (path: string) => Promise<string | undefined>;
  writeFile: (path: string, content: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const nodeClaudeFs: ClaudeFs = {
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf-8');
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }

      throw error;
    }
  },
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  },
  exists: async (path) => {
    try {
      await access(path);

      return true;
    } catch {
      return false;
    }
  },
};

const normalizeEntryDir = (entry: unknown): string | undefined => {
  if (typeof entry !== 'string' || entry.trim() === '') {
    return undefined;
  }

  const normalized = posix.normalize(entry.trim().replaceAll('\\', '/')).replace(/\/+$/, '');

  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return undefined;
  }

  return normalized === '.' ? '' : normalized;
};

export function entryDirsOf(manifest: unknown): string[] {
  const manifests: unknown[] = Array.isArray(manifest) ? manifest : [manifest];
  const entryDirs = manifests
    .map((entry) =>
      typeof entry === 'object' && entry !== null && 'entry' in entry
        ? normalizeEntryDir(entry.entry)
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

const statusOf = (current: string | undefined, bundled: string): ClaudeFileStatus => {
  if (current === undefined) {
    return 'created';
  }

  return current === bundled ? 'unchanged' : 'updated';
};

export async function planClaudeFiles(
  dir: string,
  fs: ClaudeFs = nodeClaudeFs,
  files: readonly ScaffoldedFile[] = claudeFiles(),
): Promise<ClaudeFilePlan[]> {
  return Promise.all(
    files.map(async (file) => ({
      path: file.path,
      status: statusOf(await fs.readFile(join(dir, file.path)), file.content),
    })),
  );
}

export async function applyClaudeFiles(
  dir: string,
  options: { dryRun?: boolean } = {},
  fs: ClaudeFs = nodeClaudeFs,
  files: readonly ScaffoldedFile[] = claudeFiles(),
): Promise<ClaudeFilePlan[]> {
  const plan = await planClaudeFiles(dir, fs, files);

  if (options.dryRun === true) {
    return plan;
  }

  await Promise.all(
    files
      .filter((_file, index) => plan[index]?.status !== 'unchanged')
      .map((file) => fs.writeFile(join(dir, file.path), file.content)),
  );

  return plan;
}

export async function isClaudeSkillStale(
  dir: string,
  fs: ClaudeFs = nodeClaudeFs,
  files?: readonly ScaffoldedFile[],
): Promise<boolean> {
  try {
    const managed = files ?? (await pluginClaudeFiles(dir, fs));

    if (!managed.some((file) => file.path === CLAUDE_SKILL_PATH)) {
      return false;
    }

    if ((await fs.readFile(join(dir, CLAUDE_SKILL_PATH))) === undefined) {
      return false;
    }

    const plan = await planClaudeFiles(dir, fs, managed);

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

const count = (plan: readonly ClaudeFilePlan[], status: ClaudeFileStatus): string =>
  `${String(plan.filter((entry) => entry.status === status).length)} ${status}`;

export async function runSetupClaude(
  dir: string,
  options: { dryRun?: boolean },
  deps: SetupClaudeDeps = defaultSetupClaudeDeps,
  files?: readonly ScaffoldedFile[],
): Promise<void> {
  if (!(await deps.fs.exists(join(dir, 'kizen.json')))) {
    deps.error('Error: kizen.json not found. Run this command from a plugin directory.');
    deps.setExitCode(1);

    return;
  }

  const dryRun = options.dryRun === true;
  let plan: ClaudeFilePlan[];

  try {
    plan = await applyClaudeFiles(
      dir,
      { dryRun },
      deps.fs,
      files ?? (await pluginClaudeFiles(dir, deps.fs)),
    );
  } catch (error) {
    deps.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    deps.setExitCode(1);

    return;
  }

  for (const entry of plan) {
    deps.log(`${entry.status.padEnd(9)} ${entry.path}`);
  }

  const counts = `${count(plan, 'created')}, ${count(plan, 'updated')}, ${count(plan, 'unchanged')}`;
  const managed = 'these files are managed by appbuilder, so local edits to them are replaced';

  deps.log(
    dryRun
      ? `Dry run: ${counts}; nothing written (${managed}).`
      : `Claude files: ${counts} (${managed}).`,
  );
}
