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

export interface MergeSource {
  version: string;
  zip: Uint8Array;
}

export interface MergeInput {
  pluginDir: string;
  base: MergeSource | null;
  live: MergeSource;
}

export interface MergeDeps {
  git?: GitRunner;
  findGit?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  tmpDir?: string;
}

export interface ApplyMergeDeps {
  git?: GitRunner;
  isAborted?: () => boolean;
  rename?: (from: string, to: string) => Promise<void>;
  stat?: (path: string, follow: boolean) => Promise<BigIntStats>;
}

export interface MergeChanges {
  written: string[];
  deleted: string[];
  conflicted: string[];
  deletedOnLive: string[];
  deletedLocally: string[];
  binaryConflicts: string[];
  ignoredIncoming: string[];
}

export interface ReadyMergePlan extends MergeChanges {
  status: 'ready';
  pluginDir: string;
  baseVersion: string;
  liveVersion: string;
  contents: ReadonlyMap<string, Uint8Array>;
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
  | { status: 'cancelled' };

export class MergeGitError extends Error {
  readonly step: string;

  constructor(step: string, detail: string) {
    super(`git ${step} failed while merging (${detail}). Nothing was written.`);
    this.name = 'MergeGitError';
    this.step = step;
  }
}

const MAX_PATHS_IN_MESSAGE = 10;

export class MergeStaleError extends Error {
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

export class MergeStagingError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path} ${problem}, so the merge has nowhere safe to stage files. Nothing was written.`);
    this.name = 'MergeStagingError';
    this.path = path;
  }
}

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

const WORKSPACE_GIT_MAX_BUFFER = 1024 * 1024 * 1024;

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
    ['core.precomposeUnicode', 'false'],
    ['init.defaultBranch', 'main'],
    ['rerere.enabled', 'false'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['color.ui', 'false'],
  ] as const
).flatMap(([key, value]) => ['-c', `${key}=${value}`]);

/** `$GIT_DIR/info/attributes` outranks every `.gitattributes` in the merged sources. */
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

/** git before 2.32 ignores `GIT_CONFIG_GLOBAL` and reads `$HOME` and `$XDG_CONFIG_HOME` config. */
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
  changes: { status: string; path: string }[];
  contents: Map<string, Uint8Array>;
  unmerged: Map<string, Map<number, string>>;
  binary: Set<string>;
}

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

  await run('init', ['init', '-q', '--template=', '.']);
  await mkdir(join(workspace, '.git', 'info'), { recursive: true });
  await writeFile(join(workspace, '.git', 'info', 'attributes'), WORKSPACE_ATTRIBUTES);
  await run(
    'fast-import',
    ['fast-import', '--quiet', '--done'],
    fastImportStream(trees.base, trees.live, trees.local),
  );
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
  files: Map<string, Uint8Array>;
  hashes: Map<string, string>;
  diskPaths: Map<string, string>;
  mode: SourceZipMode;
}

const O_NOFOLLOW = (fsConstants as Partial<typeof fsConstants>).O_NOFOLLOW ?? 0;

async function readNoFollow(path: string): Promise<Uint8Array> {
  const handle = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW);

  try {
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

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

const nfcTree = (files: ReadonlyMap<string, Uint8Array>): Tree =>
  new Map([...files].map(([path, data]) => [path.normalize('NFC'), data]));

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

const fileIdentity = (stats: BigIntStats): string | undefined =>
  stats.isFile() && stats.nlink === 1n ? `${String(stats.dev)}:${String(stats.ino)}` : undefined;

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
    // Without --stdin, check-ignore quotes odd paths and refuses --literal-pathspecs.
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

function overlaps(a: string, b: string): boolean {
  const [x, y] = [foldPath(a), foldPath(b)];

  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

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

function assertApplicablePath(root: string, path: string): void {
  const target = resolve(root, ...segmentsOf(path));

  if (!isSafeEntryName(path) || isSafetyExcluded(path) || !target.startsWith(root + sep)) {
    throw new UnsafeMergePathError(path);
  }
}

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
    await rmdir(join(root, ...segmentsOf(directory))).catch(() => undefined);
  }
}

const STATE_DIR = '.kizenapp';

const statDefault = (path: string, follow: boolean): Promise<BigIntStats> =>
  follow ? stat(path, { bigint: true }) : lstat(path, { bigint: true });

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

      if (plan.localHashes.has(path)) {
        await chmod(source, (await lstat(target)).mode & 0o7777);
      }

      staged.push({ path: diskPath(path), source, target });
    }
  } catch (err) {
    await cleanUp();

    throw err;
  }

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
