import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { errorCause, ifExists } from './guards.js';
import {
  collectSourceFiles,
  foldPath,
  gitChildEnv,
  type GitRunner,
  isSafeEntryName,
  isSafetyExcluded,
  KIZENIGNORE_FILE,
  readIgnoreFile,
  readZipEntries,
  resolveGit,
  runGit,
  type SourceZipMode,
} from './sourceZip.js';

/**
 * Merges a newer Live version of a Business App into the developer's plugin folder with real
 * git, in a throwaway repository that never touches the developer's own.
 *
 * `planMerge` builds the repository in the OS temp dir from bytes: the base version's source on
 * `base`, Live's on `live` and the plugin folder's source file set (what `collectSourceFiles`
 * picks) on `local`, both branched from `base`. It checks out `local`, runs
 * `git merge --no-ff --no-edit live`, reads the result back and deletes the repository. Nothing
 * in the plugin folder is written. `applyMerge` then writes only the paths whose content differs
 * between the local file set and the merge result, after checking the folder hasn't changed.
 *
 * Conflicts:
 * - Text conflicts get git's standard two-way markers (`<<<<<<< HEAD` is the local file,
 *   `>>>>>>> live` is Live's), written into the file and listed in `conflicted`.
 * - Edited locally, deleted on Live: the local file is kept as is (`conflicted`, `deletedOnLive`).
 * - Deleted locally, changed on Live: Live's copy is written back (`conflicted`, `deletedLocally`).
 * - Binary files changed on both sides: git keeps the local file. Nothing is written for them,
 *   no marker file and no `.live` copy beside it (a sibling file would be picked up by the next
 *   push); they're listed in `binaryConflicts` and the caller can offer Live's copy separately.
 *
 * Paths Live has that the local file set excludes (ignored by .gitignore / git excludes /
 * .kizenignore, occupied by a file that isn't a source file, or reached through a symlink) are
 * never written; they're listed in `ignoredIncoming`. When such a path takes the place of a local
 * file the merge would delete (a case-only rename, a file turned into a folder or back), the
 * deletion is dropped too and both are reported in `conflicted`, so nothing local is lost.
 *
 * Paths are compared in NFC: zip names and the folder's names are normalized before merging, and
 * written back under the name the folder already uses.
 */

export interface MergeSource {
  version: string;
  zip: Uint8Array;
}

export interface MergeInput {
  /** The developer's plugin folder; its source file set is the local side. */
  pluginDir: string;
  /** The Live version the developer's preview was based on; null when unknown or deleted. */
  base: MergeSource | null;
  live: MergeSource;
}

export interface MergeDeps {
  /** Lists the plugin folder's files (`collectSourceFiles`' runner); defaults to `runGit`. */
  git?: GitRunner;
  /** git's absolute path for the throwaway repository, or undefined when there's none on PATH. */
  findGit?: () => string | undefined;
  /** The environment the throwaway repository's git environment is derived from. */
  env?: NodeJS.ProcessEnv;
  /** Where the throwaway repository is created; defaults to the OS temp dir. */
  tmpDir?: string;
}

export interface ApplyMergeDeps {
  /** Lists the plugin folder's files (`collectSourceFiles`' runner); defaults to `runGit`. */
  git?: GitRunner;
  /**
   * Whether the run was cancelled (Ctrl+C at a terminal). Checked once every merged file is
   * staged, right before the first move: a cancel by then returns `{ status: 'cancelled' }` and
   * leaves the plugin folder as it was. Once moves start, they finish.
   */
  isAborted?: () => boolean;
  /**
   * Moves a file or directory; defaults to `fs.rename`.
   * @internal Injected for tests.
   */
  rename?: (from: string, to: string) => Promise<void>;
  /**
   * `stat` (follow) or `lstat` with bigint fields; used for `.kizenapp`.
   * @internal Injected for tests.
   */
  stat?: (path: string, follow: boolean) => Promise<BigIntStats>;
}

/** Relative paths (zip-style, `/`-separated), each list sorted. */
export interface MergeChanges {
  /** Modified or added by the merge; conflicted text files are written with markers. */
  written: string[];
  /** Deleted by the merge (deleted on Live, untouched locally). */
  deleted: string[];
  /**
   * Every conflict except binary ones; includes `deletedOnLive` and `deletedLocally`, and both
   * sides of a replacement left undone because the folder holds non-source files in its way
   * (neither side is changed).
   */
  conflicted: string[];
  /** Edited locally and deleted on Live; the local file is kept. */
  deletedOnLive: string[];
  /** Deleted locally and changed on Live; Live's copy is written. */
  deletedLocally: string[];
  /** Binary files changed on both sides; the local file is kept and nothing is written. */
  binaryConflicts: string[];
  /** Paths Live has that the local file set excludes; never written. */
  ignoredIncoming: string[];
}

export interface ReadyMergePlan extends MergeChanges {
  status: 'ready';
  /** Absolute path of the plugin folder. */
  pluginDir: string;
  baseVersion: string;
  liveVersion: string;
  /** The merged content of every path in `written`. */
  contents: ReadonlyMap<string, Uint8Array>;
  /** SHA-256 of every local source file when the plan was made. */
  localHashes: ReadonlyMap<string, string>;
}

export type MergePlan =
  | { status: 'no_base' }
  | { status: 'git_unavailable'; reason: string }
  | { status: 'up_to_date'; ignoredIncoming: string[] }
  | ReadyMergePlan;

export type MergeOutcome =
  | { status: 'no_base' }
  | { status: 'git_unavailable'; reason: string }
  | { status: 'up_to_date'; ignoredIncoming: string[] }
  | { status: 'merged'; written: string[]; deleted: string[]; ignoredIncoming: string[] }
  | ({ status: 'conflicts' } & MergeChanges)
  /** `isAborted` said so before anything moved; the plugin folder is unchanged. */
  | { status: 'cancelled' };

/** A git step in the throwaway repository failed; nothing was written to the plugin folder. */
export class MergeGitError extends Error {
  readonly step: string;

  constructor(step: string, detail: string) {
    super(`git ${step} failed while merging (${detail}). Nothing was written.`);
    this.name = 'MergeGitError';
    this.step = step;
  }
}

/** How many paths an error message names before summarizing the rest. */
const MAX_PATHS_IN_MESSAGE = 10;

/** The plugin folder changed after `planMerge`; nothing was written. */
export class MergeStaleError extends Error {
  /** Every path that changed or is now in the way. */
  readonly paths: string[];

  constructor(paths: string[]) {
    const named = paths.slice(0, MAX_PATHS_IN_MESSAGE).join(', ');
    const more = paths.length - MAX_PATHS_IN_MESSAGE;

    super(
      `The plugin folder changed after the merge was planned (${more > 0 ? `${named} and ${String(more)} more` : named}). Nothing was written; run the merge again.`,
    );
    this.name = 'MergeStaleError';
    this.paths = paths;
  }
}

/**
 * `applyMerge` failed after it started moving files. The plugin folder may be partly merged;
 * `recoveryDir` (`<pluginDir>/.kizenapp/merge-<uuid>`) holds `removed/<path>` for every file the
 * merge removed and `merged/<path>` for every merged file it hadn't put in place yet.
 */
export class MergeApplyError extends Error {
  readonly recoveryDir: string;

  constructor(recoveryDir: string, cause: unknown) {
    super(
      `Applying the merge stopped partway (${errorCause(cause)}). Files it removed are in ${join(recoveryDir, 'removed')}, and merged files it hadn't put in place yet are in ${join(recoveryDir, 'merged')}, each at its path in the plugin folder.`,
      { cause },
    );
    this.name = 'MergeApplyError';
    this.recoveryDir = recoveryDir;
  }
}

/** The plugin folder's `.kizenapp` can't hold the merge's staging files; nothing was written. */
export class MergeStagingError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path} ${problem}, so the merge has nowhere safe to stage files. Nothing was written.`);
    this.name = 'MergeStagingError';
    this.path = path;
  }
}

/** A plan names a path `applyMerge` must never write or delete; nothing was written. */
export class UnsafeMergePathError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `The merge plan includes "${path}", which isn't a writable source file. Nothing was written.`,
    );
    this.name = 'UnsafeMergePathError';
    this.path = path;
  }
}

/** `git merge --no-verify` arrived in 2.24. */
const MIN_GIT_VERSION: readonly [number, number] = [2, 24];

const GIT_MISSING_REASON = "git isn't installed or isn't on PATH.";

const WORKSPACE_GIT_TIMEOUT_MS = 60_000;

/** A cap, not an allocation: `cat-file` can return a few conflicted blobs of up to 50 MB each. */
const WORKSPACE_GIT_MAX_BUFFER = 1024 * 1024 * 1024;

/**
 * Config for every git call in the throwaway repository. Global and system config are off (see
 * `workspaceEnv`), so these are the only settings besides the repository's own `git init` ones:
 * an identity so commits work anywhere, no signing, no line-ending conversion, no fsmonitor, no
 * hooks, no global attributes or excludes (their XDG defaults apply even without a global config),
 * two-way conflict markers (the style most editors' conflict tools expect, and git's default), no
 * rerere, and no automatic gc or maintenance, which could outlive the call in the background.
 */
const WORKSPACE_GIT_CONFIG: readonly string[] = (
  [
    ['user.name', 'appbuilder'],
    ['user.email', 'appbuilder@localhost'],
    ['commit.gpgSign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', devNull],
    ['core.attributesFile', devNull],
    ['core.excludesFile', devNull],
    ['merge.conflictStyle', 'merge'],
    ['merge.renormalize', 'false'],
    // Every name here is already NFC; git compares them as bytes rather than re-normalizing.
    ['core.precomposeUnicode', 'false'],
    ['init.defaultBranch', 'main'],
    ['rerere.enabled', 'false'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['color.ui', 'false'],
  ] as const
).flatMap(([key, value]) => ['-c', `${key}=${value}`]);

/**
 * `$GIT_DIR/info/attributes` outranks every `.gitattributes` in the merged sources. Those could
 * name filters or merge drivers (inert: the config defining them doesn't exist here) or ask for
 * line-ending or encoding conversion (which needs no config); this turns all of it off and pins
 * the built-in text merge, so files go in and come out byte for byte.
 */
const WORKSPACE_ATTRIBUTES =
  '* -text -eol -filter -ident -working-tree-encoding merge conflict-marker-size=7\n';

const IDENT = 'appbuilder <appbuilder@localhost> 0 +0000';

const encoder = new TextEncoder();

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Git's own binary check (`buffer_is_binary`): a NUL in the first 8000 bytes. */
const isBinary = (data: Uint8Array): boolean => data.subarray(0, 8000).includes(0);

const segmentsOf = (path: string): string[] => path.split('/');

function findGitOnPath(): string | undefined {
  try {
    return resolveGit();
  } catch {
    return undefined;
  }
}

/**
 * The parent environment minus git's own variables (`gitChildEnv`), with global and system config
 * turned off. The kept `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` are overridden. git before 2.32
 * ignores `GIT_CONFIG_GLOBAL` and reads `$HOME/.gitconfig` and `$XDG_CONFIG_HOME/git/config`, so
 * both point at `home`, an empty directory inside the throwaway workspace.
 */
function workspaceEnv(parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return {
    ...gitChildEnv(parent),
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

interface GitOutput {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs git without a shell; resolves with the exit code, rejects when it can't run or times out. */
function execGit(
  gitPath: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: readonly Uint8Array[],
): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      gitPath,
      [...WORKSPACE_GIT_CONFIG, ...args],
      {
        cwd,
        env,
        timeout: WORKSPACE_GIT_TIMEOUT_MS,
        maxBuffer: WORKSPACE_GIT_MAX_BUFFER,
        encoding: 'buffer',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;

        if (typeof code !== 'number') {
          reject(error ?? new Error('git did not exit'));

          return;
        }

        resolvePromise({ code, stdout, stderr: stderr.toString('utf8') });
      },
    );

    // git exiting early closes stdin; its exit code reports the failure.
    child.stdin?.on('error', () => undefined);

    for (const chunk of input ?? []) {
      child.stdin?.write(chunk);
    }

    child.stdin?.end();
  });
}

/** A reason git can't be used, or undefined when it's new enough. */
async function gitVersionProblem(
  gitPath: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | undefined> {
  let output: GitOutput;

  try {
    output = await execGit(gitPath, ['--version'], cwd, env);
  } catch (err) {
    return `git couldn't be run (${errorCause(err)}).`;
  }

  const match = /git version (\d+)\.(\d+)/.exec(output.stdout.toString('utf8'));

  if (output.code !== 0 || match === null) {
    return "git couldn't report its version.";
  }

  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [minMajor, minMinor] = MIN_GIT_VERSION;

  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    return `git ${String(major)}.${String(minor)} is older than ${String(minMajor)}.${String(minMinor)}, which merging needs.`;
  }

  return undefined;
}

/** A path in fast-import's C-style quoting, so any byte (spaces, quotes, newlines) round-trips. */
function quotePath(path: string): string {
  let quoted = '"';

  for (const char of path) {
    const code = char.charCodeAt(0);

    if (char === '"' || char === '\\') {
      quoted += `\\${char}`;
    } else if (code < 0x20 || code === 0x7f) {
      quoted += `\\${code.toString(8).padStart(3, '0')}`;
    } else {
      quoted += char;
    }
  }

  return `${quoted}"`;
}

type Tree = ReadonlyMap<string, Uint8Array>;

/**
 * A `git fast-import` stream committing `base`, then `live` and `local` as children of it, each
 * with exactly its tree. Blobs come from memory, so no file on disk, filter or hook is involved.
 */
function fastImportStream(base: Tree, live: Tree, local: Tree): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const text = (value: string): void => {
    chunks.push(encoder.encode(value));
  };

  const data = (bytes: Uint8Array): void => {
    text(`data ${String(bytes.length)}\n`);
    chunks.push(bytes);
    text('\n');
  };

  const commit = (branch: string, mark: number, tree: Tree, parent?: number): void => {
    text(`commit refs/heads/${branch}\nmark :${String(mark)}\ncommitter ${IDENT}\n`);
    data(encoder.encode(branch));

    if (parent !== undefined) {
      text(`from :${String(parent)}\ndeleteall\n`);
    }

    for (const [path, bytes] of tree) {
      text(`M 100644 inline ${quotePath(path)}\n`);
      data(bytes);
    }
  };

  commit('base', 1, base);
  commit('live', 2, live, 1);
  commit('local', 3, local, 1);
  text('done\n');

  return chunks;
}

const splitNul = (output: Buffer): string[] =>
  output
    .toString('utf8')
    .split('\0')
    .filter((part) => part !== '');

/** `ls-files -u -z`: path → stage number → blob id. */
function parseUnmerged(output: Buffer): Map<string, Map<number, string>> {
  const unmerged = new Map<string, Map<number, string>>();

  for (const line of splitNul(output)) {
    const tab = line.indexOf('\t');
    const [, blob, stage] = line.slice(0, tab).split(' ');
    const path = line.slice(tab + 1);
    const stages = unmerged.get(path) ?? new Map<number, string>();

    stages.set(Number(stage), blob ?? '');
    unmerged.set(path, stages);
  }

  return unmerged;
}

/** `cat-file --batch` output: blob id → content. */
function parseBatch(output: Buffer): Map<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset < output.length) {
    const newline = output.indexOf(10, offset);
    const [id = '', , size] = output.subarray(offset, newline).toString('utf8').split(' ');

    if (size === undefined) {
      throw new MergeGitError('cat-file', `missing object ${id}`);
    }

    const start = newline + 1;
    const end = start + Number(size);

    blobs.set(id, output.subarray(start, end));
    offset = end + 1;
  }

  return blobs;
}

interface WorkspaceResult {
  /** `git diff-tree --name-status` between the local commit and the merge result. */
  changes: { status: string; path: string }[];
  /** Merged content of every added or modified path. */
  contents: Map<string, Uint8Array>;
  unmerged: Map<string, Map<number, string>>;
  /** Unmerged paths both sides changed where git's binary check refused a text merge. */
  binary: Set<string>;
}

/** Runs the merge in a new repository at `workspace`; the caller deletes it. */
async function mergeInWorkspace(
  gitPath: string,
  env: NodeJS.ProcessEnv,
  workspace: string,
  trees: { base: Tree; live: Tree; local: Tree },
): Promise<WorkspaceResult> {
  await mkdir(workspace);

  const run = async (
    step: string,
    args: readonly string[],
    input?: readonly Uint8Array[],
  ): Promise<GitOutput> => {
    let output: GitOutput;

    try {
      output = await execGit(gitPath, args, workspace, env, input);
    } catch (err) {
      throw new MergeGitError(step, errorCause(err));
    }

    if (output.code !== 0 && !(step === 'merge' && output.code === 1)) {
      throw new MergeGitError(step, output.stderr.trim() || `exit ${String(output.code)}`);
    }

    return output;
  };

  // No templates: nothing but what git itself needs goes into .git.
  await run('init', ['init', '-q', '--template=', '.']);
  await mkdir(join(workspace, '.git', 'info'), { recursive: true });
  await writeFile(join(workspace, '.git', 'info', 'attributes'), WORKSPACE_ATTRIBUTES);
  await run(
    'fast-import',
    ['fast-import', '--quiet', '--done'],
    fastImportStream(trees.base, trees.live, trees.local),
  );
  // The merge moves the `local` branch, so the local tree is pinned first.
  const localTree = (await run('rev-parse', ['rev-parse', '--verify', 'local^{tree}'])).stdout
    .toString('utf8')
    .trim();

  await run('checkout', ['checkout', '-q', 'local', '--']);

  const merge = await run('merge', ['merge', '--no-ff', '--no-edit', '--no-verify', '-q', 'live']);
  const unmerged = parseUnmerged((await run('ls-files', ['ls-files', '-u', '-z'])).stdout);

  // Exit 1 is a conflicted merge only if git recorded conflicts; anything else is a failure.
  const hasConflicts = unmerged.size > 0;

  if ((merge.code === 1) !== hasConflicts) {
    throw new MergeGitError('merge', merge.stderr.trim() || `exit ${String(merge.code)}`);
  }

  const bothChanged = [...unmerged].filter(([, stages]) => stages.has(2) && stages.has(3));
  const blobIds = [...new Set(bothChanged.flatMap(([, stages]) => [...stages.values()]))];
  const blobs =
    blobIds.length === 0
      ? new Map<string, Uint8Array>()
      : parseBatch(
          (
            await run(
              'cat-file',
              ['cat-file', '--batch'],
              [encoder.encode(blobIds.map((id) => `${id}\n`).join(''))],
            )
          ).stdout,
        );
  const binary = new Set(
    bothChanged
      .filter(([, stages]) =>
        [...stages.values()].some((id) => isBinary(blobs.get(id) ?? new Uint8Array())),
      )
      .map(([path]) => path),
  );

  // Stage whatever the merge left (markers, the kept side of a delete conflict) as one tree.
  await run('add', ['add', '-A', '-f']);

  const tree = (await run('write-tree', ['write-tree'])).stdout.toString('utf8').trim();
  const diff = splitNul(
    (
      await run('diff-tree', [
        'diff-tree',
        '-r',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--name-status',
        localTree,
        tree,
      ])
    ).stdout,
  );
  const changes: { status: string; path: string }[] = [];

  for (let index = 0; index + 1 < diff.length; index += 2) {
    changes.push({ status: diff[index] ?? '', path: diff[index + 1] ?? '' });
  }

  const contents = new Map<string, Uint8Array>();

  for (const { status, path } of changes) {
    if (!isSafeEntryName(path)) {
      throw new MergeGitError('merge', `unexpected path "${path}"`);
    }

    if (status !== 'D') {
      contents.set(path, await readFile(join(workspace, ...segmentsOf(path))));
    }
  }

  return { changes, contents, unmerged, binary };
}

interface LocalTree {
  /** Content by merge path: NFC, unless two local names share an NFC form. */
  files: Map<string, Uint8Array>;
  hashes: Map<string, string>;
  /** Merge path → the name on disk, which can be in another Unicode normalization form. */
  diskPaths: Map<string, string>;
  mode: SourceZipMode;
}

/** `O_NOFOLLOW` where the platform has it (not on Windows). */
const O_NOFOLLOW = (fsConstants as Partial<typeof fsConstants>).O_NOFOLLOW ?? 0;

/**
 * Reads a file without following a symlink at the last segment; `collectSourceFiles` already
 * checked every directory above it.
 */
async function readNoFollow(path: string): Promise<Uint8Array> {
  const handle = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW);

  try {
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/**
 * The plugin folder's source files, named in NFC so they line up with the zips' names whatever
 * form the filesystem stored (macOS keeps names as created, so a decomposed `café.js` is common
 * enough). Names stay as stored when two of them share an NFC form, which only a filesystem that
 * keeps both forms apart allows.
 */
async function readLocalTree(dir: string, git: GitRunner | undefined): Promise<LocalTree> {
  const listing = await collectSourceFiles(dir, git === undefined ? {} : { git });
  const contents = await Promise.all(
    listing.files.map((path) => readNoFollow(join(dir, ...segmentsOf(path)))),
  );
  const nfc = listing.files.map((path) => path.normalize('NFC'));
  const names = new Set(nfc).size === nfc.length ? nfc : listing.files;
  const files = new Map<string, Uint8Array>();
  const hashes = new Map<string, string>();
  const diskPaths = new Map<string, string>();

  listing.files.forEach((diskPath, index) => {
    const path = names[index] ?? diskPath;
    const data = contents[index] ?? new Uint8Array();

    files.set(path, data);
    hashes.set(path, sha256(data));
    diskPaths.set(path, diskPath);
  });

  return { files, hashes, diskPaths, mode: listing.mode };
}

/** A zip's files with NFC names; `readZipEntries` already refused names that fold together. */
const nfcTree = (files: ReadonlyMap<string, Uint8Array>): Tree =>
  new Map([...files].map(([path, data]) => [path.normalize('NFC'), data]));

/**
 * What's on disk at `path` under `root`: 'absent' when it (or an ancestor) doesn't exist and every
 * existing ancestor is a real directory, 'file' for a regular file reached through real
 * directories, 'blocked' for anything else (a symlink anywhere, a file where a directory is
 * needed, a directory or special file at the path).
 */
async function pathShape(root: string, path: string): Promise<'absent' | 'file' | 'blocked'> {
  const segments = segmentsOf(path);

  for (let depth = 1; depth <= segments.length; depth += 1) {
    const stats = await ifExists(lstat(join(root, ...segments.slice(0, depth))));

    if (stats === undefined) {
      return 'absent';
    }

    if (depth === segments.length) {
      return stats.isFile() ? 'file' : 'blocked';
    }

    if (!stats.isDirectory()) {
      return 'blocked';
    }
  }

  return 'blocked';
}

/**
 * A regular file's identity on disk. Undefined when it has other hard links: removing one name
 * wouldn't free the others.
 */
const fileIdentity = (stats: BigIntStats): string | undefined =>
  stats.isFile() && stats.nlink === 1n ? `${String(stats.dev)}:${String(stats.ino)}` : undefined;

/** The identities of the files at `paths` (relative to `root`) that the merge removes. */
async function removedIdentities(root: string, paths: readonly string[]): Promise<Set<string>> {
  const identities = new Set<string>();

  for (const path of paths) {
    const stats = await ifExists(lstat(join(root, ...segmentsOf(path)), { bigint: true }));
    const identity = stats === undefined ? undefined : fileIdentity(stats);

    if (identity !== undefined) {
      identities.add(identity);
    }
  }

  return identities;
}

/**
 * Whether `dir` holds only removed files and directories that removal empties too. A directory
 * with nothing removed from it, even an empty one, isn't pruned, so it still stands in the way.
 */
async function emptiedBy(dir: string, removed: ReadonlySet<string>): Promise<boolean> {
  const names = await readdir(dir);

  if (names.length === 0) {
    return false;
  }

  for (const name of names) {
    const full = join(dir, name);
    const stats = await lstat(full, { bigint: true });
    const goes = stats.isDirectory()
      ? await emptiedBy(full, removed)
      : removed.has(fileIdentity(stats) ?? '');

    if (!goes) {
      return false;
    }
  }

  return true;
}

/**
 * Whether a path the merge adds can be written once the merge's removals are done. 'absent' when
 * nothing is in the way, or only what the merge removes: a removed file at the path (on a
 * case-insensitive filesystem, the same file under another case) or at an ancestor, or a directory
 * holding only removed files. 'blocked' for anything else: a symlink anywhere, a file or directory
 * that stays, a special file.
 */
async function incomingShape(
  root: string,
  path: string,
  removed: ReadonlySet<string>,
): Promise<'absent' | 'blocked'> {
  const segments = segmentsOf(path);

  for (let depth = 1; depth <= segments.length; depth += 1) {
    const full = join(root, ...segments.slice(0, depth));
    const stats = await ifExists(lstat(full, { bigint: true }));

    if (stats === undefined) {
      return 'absent';
    }

    if (stats.isFile()) {
      return removed.has(fileIdentity(stats) ?? '') ? 'absent' : 'blocked';
    }

    if (!stats.isDirectory()) {
      return 'blocked';
    }

    if (depth === segments.length) {
      return (await emptiedBy(full, removed)) ? 'absent' : 'blocked';
    }
  }

  return 'blocked';
}

/**
 * Which of `paths` the plugin folder's ignore rules exclude from its source file set. Only paths
 * with nothing in the way on disk are passed, so git never sees one through a symlink.
 */
async function ignoredLocally(
  dir: string,
  paths: readonly string[],
  mode: SourceZipMode,
  git: GitRunner,
): Promise<Set<string>> {
  const ignored = new Set<string>();

  if (paths.length === 0) {
    return ignored;
  }

  const rules = [
    await readIgnoreFile(dir, KIZENIGNORE_FILE),
    mode === 'walk' ? await readIgnoreFile(dir, '.gitignore') : undefined,
  ];

  for (const path of paths) {
    if (rules.some((rule) => rule?.ignores(path) === true)) {
      ignored.add(path);
    }
  }

  if (mode === 'git') {
    // `check-ignore -z` needs --stdin, which a GitRunner can't feed. Without it git quotes a path
    // holding a quote, backslash or control character, so those are asked about one at a time
    // (exit 0: ignored) and the rest in batches, matched against the output lines.
    // check-ignore refuses --literal-pathspecs; the `./` prefix stops a leading `:` from being
    // read as pathspec magic, and git echoes each path as given.
    const quoted = (path: string): boolean => /["\\\p{Cc}]/u.test(path);
    const checkIgnore = async (batch: readonly string[]): Promise<Set<string>> => {
      try {
        const listed = await git(
          ['-c', 'core.quotePath=false', 'check-ignore', '--', ...batch.map((path) => `./${path}`)],
          dir,
        );

        return new Set(listed.split('\n'));
      } catch (err) {
        // check-ignore exits 1 when none of the paths is ignored.
        if ((err as { code?: unknown } | null)?.code === 1) {
          return new Set();
        }

        const stderr = (err as { stderr?: unknown } | null)?.stderr;

        throw new MergeGitError(
          'check-ignore',
          typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : errorCause(err),
        );
      }
    };

    const plain = paths.filter((path) => !quoted(path));

    for (let start = 0; start < plain.length; start += 100) {
      const batch = plain.slice(start, start + 100);
      const listed = await checkIgnore(batch);

      batch.filter((path) => listed.has(`./${path}`)).forEach((path) => ignored.add(path));
    }

    for (const path of paths.filter(quoted)) {
      if ((await checkIgnore([path])).size > 0) {
        ignored.add(path);
      }
    }
  }

  return ignored;
}

const sorted = (paths: Iterable<string>): string[] => [...paths].sort();

/** Whether two paths are the same place, or one is inside the other, on a folding filesystem. */
function overlaps(a: string, b: string): boolean {
  const [x, y] = [foldPath(a), foldPath(b)];

  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Sorts the merge result into what applying it writes, deletes and reports. */
async function classify(
  pluginDir: string,
  local: LocalTree,
  result: WorkspaceResult,
  git: GitRunner,
): Promise<MergeChanges & { contents: Map<string, Uint8Array> }> {
  const diskPath = (path: string): string => local.diskPaths.get(path) ?? path;

  for (const { path } of result.changes) {
    if (isSafetyExcluded(path)) {
      throw new MergeGitError('merge', `unexpected path "${path}"`);
    }
  }

  const deleted = new Set(
    result.changes
      .filter(({ status, path }) => status === 'D' && local.files.has(path))
      .map(({ path }) => path),
  );
  const removed = await removedIdentities(pluginDir, [...deleted].map(diskPath));
  const written = new Set<string>();
  const ignoredIncoming = new Set<string>();
  const clear: string[] = [];

  for (const { status, path } of result.changes) {
    if (status === 'D') {
      continue;
    }

    if (local.files.has(path)) {
      written.add(path);
    } else if ((await incomingShape(pluginDir, path, removed)) === 'absent') {
      clear.push(path);
    } else {
      ignoredIncoming.add(path);
    }
  }

  const ignoredByRules = await ignoredLocally(pluginDir, clear, local.mode, git);

  for (const path of clear) {
    (ignoredByRules.has(path) ? ignoredIncoming : written).add(path);
  }

  const conflicted = new Set<string>();
  const deletedOnLive: string[] = [];
  const deletedLocally: string[] = [];
  const binaryConflicts: string[] = [];

  for (const [path, stages] of result.unmerged) {
    if (result.binary.has(path)) {
      binaryConflicts.push(path);
    } else if (!ignoredIncoming.has(path)) {
      conflicted.add(path);

      if (stages.has(1) && stages.has(2) && !stages.has(3)) {
        deletedOnLive.push(path);
      } else if (stages.has(1) && stages.has(3) && !stages.has(2)) {
        deletedLocally.push(path);
      }
    }
  }

  // A redundant safeguard: a local path is never removed while the Live path that takes its place
  // (the same place on a case-insensitive filesystem, or a path inside it or around it) goes
  // unwritten. Such a deletion is dropped and both sides are reported as a conflict, along with
  // any new path that needed the deletion.
  const kept = [...deleted].filter((path) =>
    [...ignoredIncoming].some((incoming) => overlaps(incoming, path)),
  );

  for (const path of kept) {
    deleted.delete(path);
    conflicted.add(path);
  }

  for (const path of [...ignoredIncoming, ...written]) {
    if (!local.files.has(path) && kept.some((keptPath) => overlaps(path, keptPath))) {
      ignoredIncoming.delete(path);
      written.delete(path);
      conflicted.add(path);
    }
  }

  const contents = new Map<string, Uint8Array>();

  for (const path of written) {
    contents.set(path, result.contents.get(path) ?? new Uint8Array());
  }

  return {
    written: sorted(written),
    deleted: sorted(deleted),
    conflicted: sorted(conflicted),
    deletedOnLive: sorted(deletedOnLive),
    deletedLocally: sorted(deletedLocally),
    binaryConflicts: sorted(binaryConflicts),
    ignoredIncoming: sorted(ignoredIncoming),
    contents,
  };
}

/**
 * Merges Live into the plugin folder's source in a throwaway repository and returns what applying
 * it would change. Writes nothing in `pluginDir`. Throws `UnsafeZipEntryError` / `ZipLimitError`
 * for a zip that fails `readZipEntries`, `collectSourceFiles`' errors for the folder, and
 * `MergeGitError` when a git step fails.
 */
export async function planMerge(input: MergeInput, deps: MergeDeps = {}): Promise<MergePlan> {
  if (input.base === null) {
    return { status: 'no_base' };
  }

  const gitPath = (deps.findGit ?? findGitOnPath)();

  if (gitPath === undefined) {
    return { status: 'git_unavailable', reason: GIT_MISSING_REASON };
  }

  const pluginDir = resolve(input.pluginDir);
  const tmpRoot = resolve(deps.tmpDir ?? tmpdir());

  if (tmpRoot === pluginDir || tmpRoot.startsWith(pluginDir + sep)) {
    throw new Error('The merge workspace must not be inside the plugin folder.');
  }

  const workspace = await mkdtemp(join(tmpRoot, 'appbuilder-merge-'));

  try {
    const home = join(workspace, 'home');

    await mkdir(home);

    const env = workspaceEnv(deps.env ?? process.env, home);
    const versionProblem = await gitVersionProblem(gitPath, env, workspace);

    if (versionProblem !== undefined) {
      return { status: 'git_unavailable', reason: versionProblem };
    }

    const base = nfcTree(readZipEntries(input.base.zip).files);
    const live = nfcTree(readZipEntries(input.live.zip).files);
    const local = await readLocalTree(pluginDir, deps.git);
    const result = await mergeInWorkspace(gitPath, env, join(workspace, 'repo'), {
      base,
      live,
      local: local.files,
    });
    const changes = await classify(pluginDir, local, result, deps.git ?? runGit);

    if (
      changes.written.length === 0 &&
      changes.deleted.length === 0 &&
      changes.conflicted.length === 0 &&
      changes.binaryConflicts.length === 0
    ) {
      return { status: 'up_to_date', ignoredIncoming: changes.ignoredIncoming };
    }

    return {
      status: 'ready',
      pluginDir,
      baseVersion: input.base.version,
      liveVersion: input.live.version,
      ...changes,
      localHashes: local.hashes,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Throws `UnsafeMergePathError` unless `path` is a canonical, non-safety-listed path under `root`. */
function assertApplicablePath(root: string, path: string): void {
  const target = resolve(root, ...segmentsOf(path));

  if (!isSafeEntryName(path) || isSafetyExcluded(path) || !target.startsWith(root + sep)) {
    throw new UnsafeMergePathError(path);
  }
}

/** Creates the missing directories above `path`, one level at a time. */
async function createParents(root: string, path: string): Promise<void> {
  const segments = segmentsOf(path);

  for (let depth = 1; depth < segments.length; depth += 1) {
    const directory = join(root, ...segments.slice(0, depth));

    try {
      await mkdir(directory);
    } catch (err) {
      if (
        (err as { code?: unknown }).code !== 'EEXIST' ||
        !(await lstat(directory)).isDirectory()
      ) {
        throw err;
      }
    }
  }
}

/**
 * Removes the directories above `paths` that are now empty, deepest first. Never `root` itself,
 * and never through a symlink (`rmdir` doesn't follow one).
 */
async function pruneEmptied(root: string, paths: readonly string[]): Promise<void> {
  const directories = new Set<string>();

  for (const path of paths) {
    const segments = segmentsOf(path);

    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'));
    }
  }

  const deepestFirst = [...directories].sort((a, b) => segmentsOf(b).length - segmentsOf(a).length);

  for (const directory of deepestFirst) {
    // A directory that still holds something stays.
    await rmdir(join(root, ...segmentsOf(directory))).catch(() => undefined);
  }
}

/** The CLI's own folder in a plugin folder: safety-listed, gitignored, unwatched. */
const STATE_DIR = '.kizenapp';

const statDefault = (path: string, follow: boolean): Promise<BigIntStats> =>
  follow ? stat(path, { bigint: true }) : lstat(path, { bigint: true });

/**
 * Creates `<root>/.kizenapp/merge-<uuid>`, creating `.kizenapp` too when it's missing. Refuses
 * (`MergeStagingError`, nothing left behind) unless `.kizenapp` is a real directory, not a
 * symlink, on the same device as `root`: a symlink would put the staged files outside the plugin
 * folder, and another device would make the moves fail after they've begun.
 */
async function createStaging(
  root: string,
  statPath: (path: string, follow: boolean) => Promise<BigIntStats>,
): Promise<{ staging: string; cleanUp: () => Promise<void> }> {
  const stateDir = join(root, STATE_DIR);
  let created = false;

  try {
    await mkdir(stateDir);
    created = true;
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EEXIST') {
      throw err;
    }
  }

  const removeStateDir = async (): Promise<void> => {
    if (created) {
      await rmdir(stateDir).catch(() => undefined);
    }
  };

  const [state, rootStats] = await Promise.all([statPath(stateDir, false), statPath(root, true)]);
  const problem = !state.isDirectory()
    ? "isn't a real folder"
    : state.dev !== rootStats.dev
      ? 'is on a different disk than the plugin folder'
      : undefined;

  if (problem !== undefined) {
    await removeStateDir();

    throw new MergeStagingError(stateDir, problem);
  }

  const staging = join(stateDir, `merge-${randomUUID()}`);

  await mkdir(staging);

  return {
    staging,
    cleanUp: async () => {
      await rm(staging, { recursive: true, force: true });
      await removeStateDir();
    },
  };
}

/**
 * Writes a `ready` plan into its plugin folder; any other plan comes back as the outcome as is.
 *
 * Only the plan's `written` and `deleted` paths are touched, and only after every check passes,
 * so a refused apply writes nothing:
 * - each path is canonical, inside the folder and off the safety list (`UnsafeMergePathError`);
 *   a deleted path, or a written one that isn't new, must be one of the planned local files;
 * - the folder's source file set and every file's content match the plan (`MergeStaleError`);
 * - every path is reached through real directories only, existing paths are regular files, and
 *   new ones have nothing in their way but what the plan removes (`MergeStaleError`).
 *
 * Then, in order: every merged file is written into a staging folder,
 * `.kizenapp/merge-<uuid>/merged/<path>`; removed files are moved to `…/removed/<path>`; directories
 * that emptied are pruned; merged files are renamed into place; the staging folder is deleted.
 * `.kizenapp` is on the source zip's safety list (and skipped by the dev server's reader and
 * watcher), so staged files are never part of the app's source, even after a crash. It must be a
 * real directory on the plugin folder's device, or the apply is refused before anything is written
 * (`MergeStagingError`). Moving removals out first lets a path change into a directory (or back)
 * and lets a case-only rename land on a case-insensitive filesystem. A failure before anything
 * moves removes the staging folder and changes nothing, and so does a cancel (`isAborted`) seen
 * once the files are staged; a failure after that throws `MergeApplyError` and leaves the staging
 * folder in place for recovery by hand.
 */
export async function applyMerge(
  plan: MergePlan,
  deps: ApplyMergeDeps = {},
): Promise<MergeOutcome> {
  if (plan.status !== 'ready') {
    return plan;
  }

  const root = resolve(plan.pluginDir);

  for (const path of plan.written) {
    if (!plan.contents.has(path)) {
      throw new UnsafeMergePathError(path);
    }

    assertApplicablePath(root, path);
  }

  for (const path of plan.deleted) {
    if (!plan.localHashes.has(path)) {
      throw new UnsafeMergePathError(path);
    }

    assertApplicablePath(root, path);
  }

  const now = await readLocalTree(root, deps.git);
  const changed = sorted(
    new Set(
      [...plan.localHashes.keys(), ...now.hashes.keys()].filter(
        (path) => plan.localHashes.get(path) !== now.hashes.get(path),
      ),
    ),
  );

  if (changed.length > 0) {
    throw new MergeStaleError(changed);
  }

  const diskPath = (path: string): string => now.diskPaths.get(path) ?? path;
  const removed = await removedIdentities(root, plan.deleted.map(diskPath));
  const blocked: string[] = [];

  for (const path of [...plan.written, ...plan.deleted]) {
    const fits = plan.localHashes.has(path)
      ? (await pathShape(root, diskPath(path))) === 'file'
      : (await incomingShape(root, path, removed)) === 'absent';

    if (!fits) {
      blocked.push(path);
    }
  }

  if (blocked.length > 0) {
    throw new MergeStaleError(blocked);
  }

  const { staging, cleanUp } = await createStaging(root, deps.stat ?? statDefault);
  const staged: { path: string; source: string; target: string }[] = [];

  try {
    for (const path of plan.written) {
      const target = join(root, ...segmentsOf(diskPath(path)));
      const source = join(staging, 'merged', ...segmentsOf(diskPath(path)));

      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, plan.contents.get(path) ?? new Uint8Array(), { flag: 'wx' });

      // Keep an existing file's permissions (an executable script stays executable).
      if (plan.localHashes.has(path)) {
        await chmod(source, (await lstat(target)).mode & 0o7777);
      }

      staged.push({ path: diskPath(path), source, target });
    }
  } catch (err) {
    await cleanUp();

    throw err;
  }

  // The last point where nothing in the plugin folder has changed.
  if (deps.isAborted?.() === true) {
    await cleanUp();

    return { status: 'cancelled' };
  }

  const move = deps.rename ?? rename;

  try {
    for (const path of plan.deleted.map(diskPath)) {
      const kept = join(staging, 'removed', ...segmentsOf(path));

      await mkdir(dirname(kept), { recursive: true });
      await move(join(root, ...segmentsOf(path)), kept);
    }

    await pruneEmptied(root, plan.deleted.map(diskPath));

    for (const { path, source, target } of staged) {
      await createParents(root, path);
      await move(source, target);
    }
  } catch (err) {
    throw new MergeApplyError(staging, err);
  }

  await cleanUp();

  const lists = {
    written: plan.written,
    deleted: plan.deleted,
    ignoredIncoming: plan.ignoredIncoming,
  };

  if (plan.conflicted.length === 0 && plan.binaryConflicts.length === 0) {
    return { status: 'merged', ...lists };
  }

  return {
    status: 'conflicts',
    ...lists,
    conflicted: plan.conflicted,
    deletedOnLive: plan.deletedOnLive,
    deletedLocally: plan.deletedLocally,
    binaryConflicts: plan.binaryConflicts,
  };
}
