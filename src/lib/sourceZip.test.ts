import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gitChildEnv,
  type GitRunner,
  isManagedSkillPath,
  readSourceLineage,
  readZipEntries,
  SOURCE_LINEAGE_PATH,
  SourceZipIgnoredDirError,
  SourceZipMissingManifestError,
  SourceZipTooLargeError,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_TOTAL_BYTES,
  resolveExecutable,
  ZipLimitError,
  UnsafeZipEntryError,
  unzipToDir,
  withSourceLineage,
  ZipDestinationExistsError,
  zipSourceDir,
} from './sourceZip.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'appbuilder-source-zip-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const write = async (root: string, path: string, content: string | Uint8Array): Promise<void> => {
  const target = join(root, ...path.split('/'));

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const KEPT = [
  'kizen.json',
  'src/blocks/helloBlock/script.js',
  'src/blocks/helloBlock/config.json',
  'thumbnail.png',
  '.gitignore',
  'README.md',
];

const EXCLUDED = [
  'node_modules/lodash/index.js',
  'src/node_modules/x.js',
  '.git/HEAD',
  '.git/objects/ab/cdef',
  '.kizenapp/bundle.json',
  '.kizenapp/config.json',
  '.kizenappbuilder/credentials.json',
  '.copilot-docs/doc.md',
  'dist/index.js',
  'src/__pycache__/x.pyc',
  '.DS_Store',
  'src/.DS_Store',
  '.env',
  '.env.local',
  '.env.production',
  'src/.env',
  'credentials.json',
  'config/credentials.json',
  '.npmrc',
];

const buildTree = async (root: string): Promise<void> => {
  for (const path of [...KEPT, ...EXCLUDED]) {
    await write(root, path, `content of ${path}`);
  }
};

const NO_GIT: GitRunner = () =>
  Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));

const isolatedGit: GitRunner = async (args, cwd) =>
  (
    await promisify(execFile)('git', ['-c', 'core.excludesFile=', ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })
  ).stdout;

const gitInit = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await isolatedGit(['init', '-q'], dir);
};

const zippedPaths = async (dir: string, git: GitRunner = NO_GIT): Promise<string[]> => {
  const zip = await zipSourceDir(dir, { git });

  expect([...readZipEntries(zip.bytes).files.keys()]).toStrictEqual(zip.files);

  return zip.files;
};

describe('zipSourceDir size limits', () => {
  const plugin = async (sizes: Record<string, number>): Promise<string> => {
    const root = join(workDir, 'sized');

    await write(root, 'kizen.json', '{}');

    for (const [path, size] of Object.entries(sizes)) {
      await write(root, path, new Uint8Array(size));
    }

    return root;
  };

  const limits = { entryBytes: 100, totalBytes: 250 };

  it('refuses a file over the per-file limit, naming it', async () => {
    const root = await plugin({ 'src/big.bin': 101 });

    await expect(zipSourceDir(root, { limits })).rejects.toThrow(
      new SourceZipTooLargeError(
        "src/big.bin is 101 bytes, over the 100-byte limit for one file in an app's source. Exclude it with .kizenignore.",
      ),
    );
  });

  it('refuses a source over the total limit', async () => {
    const root = await plugin({ 'a.bin': 100, 'b.bin': 100, 'c.bin': 100 });

    await expect(zipSourceDir(root, { limits })).rejects.toBeInstanceOf(SourceZipTooLargeError);
  });

  it('zips a source exactly at the limits, which a reader accepts', async () => {
    const root = await plugin({ 'a.bin': 100, 'b.bin': 100, 'c.bin': 48 });
    const zip = await zipSourceDir(root, { limits });

    expect(zip.files).toStrictEqual(['a.bin', 'b.bin', 'c.bin', 'kizen.json']);
    expect(readZipEntries(zip.bytes).files.size).toBe(4);
  });

  it("defaults to the readers' own limits", async () => {
    const root = await plugin({ 'big.bin': MAX_ZIP_ENTRY_BYTES + 1 });

    await expect(zipSourceDir(root)).rejects.toBeInstanceOf(SourceZipTooLargeError);
  });

  it('leaves excluded files out of the count', async () => {
    const root = await plugin({ 'node_modules/huge.bin': 1000, 'a.bin': 10 });

    await write(root, '.kizenignore', 'ignored.bin\n');
    await write(root, 'ignored.bin', new Uint8Array(1000));

    expect((await zipSourceDir(root, { limits })).files).toStrictEqual([
      '.kizenignore',
      'a.bin',
      'kizen.json',
    ]);
  });
});

describe('zipSourceDir', () => {
  it('zipSourceDir excludes node_modules, .git, .kizenapp, .env files and credential files', async () => {
    const root = join(workDir, 'app');

    await buildTree(root);

    expect(await zippedPaths(root)).toStrictEqual([...KEPT].sort());
  });

  it('does not follow symlinks out of the project', async () => {
    const root = join(workDir, 'app');
    const outside = join(workDir, 'outside');

    await write(root, 'kizen.json', '{}');
    await write(outside, 'secret.txt', 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'));
    await symlink(outside, join(root, 'linkedDir'));

    expect(await zippedPaths(root)).toStrictEqual(['kizen.json']);

    await gitInit(root);
    await isolatedGit(['add', '-A'], root);
    expect(await zippedPaths(root, isolatedGit)).toStrictEqual(['kizen.json']);
  });

  it('zipSourceDir is deterministic', async () => {
    const first = join(workDir, 'first');
    const second = join(workDir, 'second');

    for (const path of KEPT) {
      await write(first, path, `content of ${path}`);
    }

    for (const path of [...KEPT].reverse()) {
      await write(second, path, `content of ${path}`);
      await utimes(join(second, ...path.split('/')), new Date(2001, 1, 1), new Date(2001, 1, 1));
    }

    const a = (await zipSourceDir(first, { git: NO_GIT })).bytes;
    const b = (await zipSourceDir(second, { git: NO_GIT })).bytes;

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(
      Buffer.from((await zipSourceDir(first, { git: NO_GIT })).bytes).equals(Buffer.from(a)),
    ).toBe(true);

    await gitInit(first);
    expect(
      Buffer.from((await zipSourceDir(first, { git: isolatedGit })).bytes).equals(Buffer.from(a)),
    ).toBe(true);

    await write(second, 'kizen.json', 'changed');
    expect(
      Buffer.from((await zipSourceDir(second, { git: NO_GIT })).bytes).equals(Buffer.from(a)),
    ).toBe(false);
  });

  it('zip round-trips file bytes', async () => {
    const root = join(workDir, 'app');
    const binary = new Uint8Array(256).map((_, index) => index);

    await write(root, 'kizen.json', '{"name":"Ünïcode ✓"}');
    await write(root, 'thumbnail.png', binary);
    await write(root, 'src/deep/nested/empty.js', '');

    const dest = join(workDir, 'out');
    const { written, skipped } = await unzipToDir(
      (await zipSourceDir(root, { git: NO_GIT })).bytes,
      dest,
    );

    expect(skipped).toStrictEqual([]);
    expect(written).toStrictEqual(['kizen.json', 'src/deep/nested/empty.js', 'thumbnail.png']);
    expect(await readFile(join(dest, 'kizen.json'), 'utf-8')).toBe('{"name":"Ünïcode ✓"}');
    expect([...(await readFile(join(dest, 'thumbnail.png')))]).toStrictEqual([...binary]);
    expect(await readFile(join(dest, 'src', 'deep', 'nested', 'empty.js'), 'utf-8')).toBe('');
  });
});

describe('ignore files', () => {
  it('zip honors .gitignore inside a git repo', async () => {
    const root = join(workDir, 'app');

    await gitInit(root);
    await write(root, '.gitignore', '*.log\nbuild/\n!keep.log\n');
    await write(root, 'src/.gitignore', 'generated/\n*.tmp\n');
    await write(root, '.git/info/exclude', 'local-only.txt\n');

    for (const path of [
      'kizen.json',
      'debug.log',
      'keep.log',
      'build/out.js',
      'src/a.js',
      'src/b.tmp',
      'src/generated/x.js',
      'local-only.txt',
      'src/untracked.js',
    ]) {
      await write(root, path, path);
    }

    await isolatedGit(['add', 'kizen.json', 'src/a.js', '.gitignore', 'src/.gitignore'], root);

    const zip = await zipSourceDir(root, { git: isolatedGit });

    expect(zip.mode).toBe('git');
    expect(zip.notice).toBeUndefined();
    expect(zip.files).toStrictEqual([
      '.gitignore',
      'keep.log',
      'kizen.json',
      'src/.gitignore',
      'src/a.js',
      'src/untracked.js',
    ]);
  });

  it('zip honors root .gitignore outside a git repo', async () => {
    const root = join(workDir, 'app');

    await write(root, '.gitignore', '*.log\nbuild/\n!keep.log\n/rootonly.txt\n');

    for (const path of [
      'kizen.json',
      'debug.log',
      'src/deep.log',
      'keep.log',
      'build/out.js',
      'src/build/out.js',
      'rootonly.txt',
      'src/rootonly.txt',
    ]) {
      await write(root, path, path);
    }

    const zip = await zipSourceDir(root, { git: NO_GIT });

    expect(zip.mode).toBe('walk');
    expect(zip.notice).toBe(
      "git isn't installed, so the source zip honors only the root .gitignore and .kizenignore.",
    );
    expect(zip.files).toStrictEqual(['.gitignore', 'keep.log', 'kizen.json', 'src/rootonly.txt']);
  });

  it('zip honors .kizenignore in both modes', async () => {
    const root = join(workDir, 'app');

    await write(root, '.kizenignore', 'docs/\n*.psd\n');

    for (const path of ['kizen.json', 'docs/notes.md', 'art/logo.psd', 'src/a.js']) {
      await write(root, path, path);
    }

    const expected = ['.kizenignore', 'kizen.json', 'src/a.js'];

    expect(await zippedPaths(root)).toStrictEqual(expected);

    await gitInit(root);
    await isolatedGit(['add', '-A'], root);

    const zip = await zipSourceDir(root, { git: isolatedGit });

    expect(zip.mode).toBe('git');
    expect(zip.files).toStrictEqual(expected);
  });

  it('negations cannot re-include safety-listed files', async () => {
    const root = join(workDir, 'app');
    const negations = '!.env\n!.env.local\n!.npmrc\n!credentials.json\n!node_modules/\n!dist/\n';

    await write(root, '.gitignore', negations);
    await write(root, '.kizenignore', negations);

    for (const path of [
      'kizen.json',
      '.env',
      '.env.local',
      '.npmrc',
      'credentials.json',
      'node_modules/x/index.js',
      'dist/out.js',
    ]) {
      await write(root, path, path);
    }

    const expected = ['.gitignore', '.kizenignore', 'kizen.json'];

    expect(await zippedPaths(root)).toStrictEqual(expected);

    await gitInit(root);
    await isolatedGit(['add', '-f', '-A'], root);
    await isolatedGit(
      [
        'add',
        '-f',
        '.env',
        '.env.local',
        '.npmrc',
        'credentials.json',
        'dist/out.js',
        'node_modules/x/index.js',
      ],
      root,
    );

    const listed = await isolatedGit(['ls-files', '--cached'], root);

    expect(listed).toContain('.env');
    expect(await zippedPaths(root, isolatedGit)).toStrictEqual(expected);
  });

  it('tracked-but-gitignored files are included in git mode', async () => {
    const root = join(workDir, 'app');

    await gitInit(root);
    await write(root, '.gitignore', 'vendor/\n');
    await write(root, 'kizen.json', '{}');
    await write(root, 'vendor/lib.js', 'tracked');
    await write(root, 'vendor/other.js', 'untracked');
    await isolatedGit(['add', '.gitignore', 'kizen.json'], root);
    await isolatedGit(['add', '-f', 'vendor/lib.js'], root);

    expect(await zippedPaths(root, isolatedGit)).toStrictEqual([
      '.gitignore',
      'kizen.json',
      'vendor/lib.js',
    ]);
  });

  it('zip falls back to the walk when git is unavailable', async () => {
    const root = join(workDir, 'app');

    await gitInit(root);
    await write(root, '.gitignore', 'ignored.txt\n');
    await write(root, 'kizen.json', '{}');
    await write(root, 'ignored.txt', 'x');

    const unavailable = vi.fn<GitRunner>(NO_GIT);
    const zip = await zipSourceDir(root, { git: unavailable });

    expect(unavailable).toHaveBeenCalled();
    expect(zip.mode).toBe('walk');
    expect(zip.notice).toContain("git isn't installed");
    expect(zip.files).toStrictEqual(['.gitignore', 'kizen.json']);

    const broken: GitRunner = () =>
      Promise.reject(Object.assign(new Error('timed out'), { code: null }));
    const fallback = await zipSourceDir(root, { git: broken });

    expect(fallback.mode).toBe('walk');
    expect(fallback.notice).toBe(
      "Couldn't list files with git (timed out), so the source zip honors only the root .gitignore and .kizenignore.",
    );

    const plain = join(workDir, 'plain');

    await write(plain, 'kizen.json', '{}');

    const outside = await zipSourceDir(plain, { git: isolatedGit });

    expect(outside.mode).toBe('walk');
    expect(outside.notice).toBe(
      'Not in a git work tree, so the source zip honors only the root .gitignore and .kizenignore.',
    );
  });

  it('zip of a plugin dir inside a larger repo uses paths relative to the plugin dir', async () => {
    const repo = join(workDir, 'monorepo');
    const plugin = join(repo, 'plugins', 'acme');

    await gitInit(repo);
    await write(repo, '.gitignore', '*.log\n');
    await write(repo, 'README.md', 'root');
    await write(repo, 'plugins/other/kizen.json', '{}');
    await write(plugin, 'kizen.json', '{}');
    await write(plugin, 'src/a.js', 'a');
    await write(plugin, 'debug.log', 'log');
    await write(plugin, '.kizenignore', 'src/skip.js\n');
    await write(plugin, 'src/skip.js', 'skip');
    await isolatedGit(['add', '-A'], repo);

    const zip = await zipSourceDir(plugin, { git: isolatedGit });

    expect(zip.mode).toBe('git');
    expect(zip.files).toStrictEqual(['.kizenignore', 'kizen.json', 'src/a.js']);
  });
});

describe('unzipToDir', () => {
  it.each([
    ['../escape.txt'],
    ['src/../../escape.txt'],
    ['/etc/passwd'],
    ['C:/Windows/evil.txt'],
    ['src\\..\\..\\escape.txt'],
    ['./a.txt'],
    ['src//a.txt'],
  ])('unzipToDir rejects path traversal and absolute paths (%s)', async (name) => {
    const bytes = zipSync({ 'ok.txt': strToU8('fine'), [name]: strToU8('bad') });
    const dest = join(workDir, 'out');
    const error = await rejectionOfUnsafe(unzipToDir(bytes, dest));

    expect(error.entry).toBe(name);
    expect(error.message).toContain('nothing was extracted');
    await expect(readdir(dest)).rejects.toThrow();
    await expect(readFile(join(workDir, 'escape.txt'))).rejects.toThrow();
  });

  it.each([
    [{ a: strToU8('file'), 'a/b': strToU8('nested') }],
    [{ 'a/': new Uint8Array(0), a: strToU8('file') }],
    [{ 'src/x': strToU8('file'), 'src/x/y/z.js': strToU8('nested') }],
    [{ 'A.txt': strToU8('upper'), 'a.txt': strToU8('lower') }],
    [{ 'Src/a.js': strToU8('1'), src: strToU8('file') }],
  ])('unzipToDir rejects file/directory prefix collisions before writing (%#)', async (entries) => {
    const dest = join(workDir, 'out');

    await rejectionOfUnsafe(unzipToDir(zipSync({ 'ok.txt': strToU8('fine'), ...entries }), dest));
    await expect(readdir(dest)).rejects.toThrow();
  });

  it('unzipToDir refuses an existing destination', async () => {
    const dest = join(workDir, 'out');
    const bytes = zipSync({ 'a.txt': strToU8('a') });

    await mkdir(dest);

    await expect(unzipToDir(bytes, dest)).rejects.toBeInstanceOf(ZipDestinationExistsError);
    expect(await readdir(dest)).toStrictEqual([]);

    const outside = join(workDir, 'outside');
    const linked = join(workDir, 'linked');

    await mkdir(outside);
    await symlink(outside, linked);
    await expect(unzipToDir(bytes, linked)).rejects.toBeInstanceOf(ZipDestinationExistsError);
    expect(await readdir(outside)).toStrictEqual([]);
  });

  it('creates a missing parent and skips directory entries', async () => {
    const bytes = zipSync({ 'src/': new Uint8Array(0), 'src/a.js': strToU8('a') });
    const dest = join(workDir, 'nested', 'parent', 'out');

    await expect(unzipToDir(bytes, dest)).resolves.toStrictEqual({
      written: ['src/a.js'],
      skipped: [],
    });
    expect(await readFile(join(dest, 'src', 'a.js'), 'utf-8')).toBe('a');
  });
});

async function rejectionOfUnsafe(promise: Promise<unknown>): Promise<UnsafeZipEntryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UnsafeZipEntryError);

    return error as UnsafeZipEntryError;
  }

  throw new Error('expected a rejection');
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('git listing safety', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('git listing never runs a repo-local fsmonitor', async () => {
    const root = join(workDir, 'app');
    const marker = join(workDir, 'fsmonitor-ran');
    const hooks = join(workDir, 'hooks');

    await gitInit(root);
    await write(root, 'kizen.json', '{}');
    await write(root, 'src/a.js', 'a');
    await isolatedGit(['add', '-A'], root);
    await isolatedGit(
      ['config', 'core.fsmonitor', `sh -c 'echo ran >> "${marker}"; exit 1'`],
      root,
    );
    await write(hooks, 'post-index-change', `#!/bin/sh\necho hook >> "${marker}"\n`);
    await isolatedGit(['config', 'core.hooksPath', hooks], root);
    await write(root, 'src/a.js', 'changed');

    const zip = await zipSourceDir(root);

    expect(zip.mode).toBe('git');
    expect(zip.files).toContain('src/a.js');
    expect(await exists(marker)).toBe(false);

    await isolatedGit(['ls-files', '--cached', '--others', '--exclude-standard'], root);
    expect(await exists(marker)).toBe(true);
  });

  it('git listing ignores an inherited GIT_DIR and GIT_WORK_TREE', async () => {
    const root = join(workDir, 'app');
    const other = join(workDir, 'other');

    await gitInit(root);
    await write(root, 'kizen.json', '{}');
    await gitInit(other);
    await write(other, 'kizen.json', '{}');
    await write(other, 'elsewhere.js', 'x');
    await isolatedGit(['add', '-A'], other);
    vi.stubEnv('GIT_DIR', join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);

    const zip = await zipSourceDir(root);

    expect(zip.mode).toBe('git');
    expect(zip.files).toStrictEqual(['kizen.json']);
  });

  it('gitChildEnv drops git variables except the global-config ones', () => {
    expect(
      gitChildEnv({
        PATH: '/bin',
        HOME: '/home/u',
        GIT_DIR: '/x/.git',
        GIT_WORK_TREE: '/x',
        GIT_INDEX_FILE: '/x/index',
        GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_GLOBAL: '/home/u/.gitconfig',
        GIT_CEILING_DIRECTORIES: '/home',
      }),
    ).toStrictEqual({
      PATH: '/bin',
      HOME: '/home/u',
      GIT_CONFIG_GLOBAL: '/home/u/.gitconfig',
      GIT_CEILING_DIRECTORIES: '/home',
    });
  });

  it('git mode drops files under a symlinked directory', async () => {
    const root = join(workDir, 'app');
    const outside = join(workDir, 'outside');

    await gitInit(root);
    await write(root, 'kizen.json', '{}');
    await write(root, 'src/a.js', 'inside');
    await write(root, 'lib/deep/real/b.js', 'inside');
    await isolatedGit(['add', '-A'], root);

    await write(outside, 'a.js', 'OUTSIDE-SECRET');
    await write(outside, 'real/b.js', 'OUTSIDE-SECRET');
    await rm(join(root, 'src'), { recursive: true });
    await symlink(outside, join(root, 'src'));
    await rm(join(root, 'lib', 'deep'), { recursive: true });
    await symlink(outside, join(root, 'lib', 'deep'));

    const listed = await isolatedGit(['ls-files', '--cached'], root);

    expect(listed).toContain('src/a.js');
    expect(listed).toContain('lib/deep/real/b.js');

    const zip = await zipSourceDir(root, { git: isolatedGit });

    expect(zip.files).toStrictEqual(['kizen.json']);
    expect(Buffer.from(zip.bytes).includes('OUTSIDE-SECRET')).toBe(false);
  });

  it('a plugin dir ignored by its enclosing repo is refused', async () => {
    const repo = join(workDir, 'repo');
    const plugin = join(repo, 'plugins', 'app');

    await gitInit(repo);
    await write(repo, '.gitignore', 'plugins/\n*.pem\nsecrets.yaml\n');
    await write(repo, 'README.md', 'root');
    await isolatedGit(['add', '-A'], repo);
    await write(plugin, 'kizen.json', '{}');
    await write(plugin, 'src/a.js', 'a');
    await write(plugin, 'secrets.yaml', 'token: SECRET');
    await write(plugin, 'service.pem', 'PRIVATE KEY');

    expect((await isolatedGit(['rev-parse', '--is-inside-work-tree'], plugin)).trim()).toBe('true');
    expect(
      await isolatedGit(['ls-files', '--cached', '--others', '--exclude-standard'], plugin),
    ).toBe('');

    const error = await zipSourceDir(plugin, { git: isolatedGit }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SourceZipIgnoredDirError);
    expect((error as Error).message).toBe(
      'The enclosing git repository ignores this folder, so none of its files can be picked for the source zip. Nothing was uploaded.',
    );
  });

  it('zip refuses a file set without kizen.json', async () => {
    const plain = join(workDir, 'plain');

    await write(plain, 'src/a.js', 'a');
    await expect(zipSourceDir(plain, { git: NO_GIT })).rejects.toBeInstanceOf(
      SourceZipMissingManifestError,
    );

    await write(plain, 'kizen.json', '{}');
    await write(plain, '.kizenignore', 'kizen.json\n');

    const walkError = await zipSourceDir(plain, { git: NO_GIT }).catch((error: unknown) => error);

    expect(walkError).toBeInstanceOf(SourceZipMissingManifestError);
    expect((walkError as Error).message).toBe(
      "kizen.json isn't among the files picked for the source zip. Check that .gitignore or .kizenignore doesn't exclude it.",
    );

    const repo = join(workDir, 'repo');

    await gitInit(repo);
    await write(repo, '.gitignore', 'kizen.json\n');
    await write(repo, 'kizen.json', '{}');
    await write(repo, 'src/a.js', 'a');

    const gitError = await zipSourceDir(repo, { git: isolatedGit }).catch(
      (error: unknown) => error,
    );

    expect(gitError).toBeInstanceOf(SourceZipMissingManifestError);
    expect((gitError as SourceZipMissingManifestError).mode).toBe('git');
  });

  it('the safety list matches case-insensitively and as folder names', async () => {
    const root = join(workDir, 'app');
    // Windows strips trailing dots and spaces; git refuses to index these, so walk mode only.
    const trailing = [
      '.env.',
      '.Env ',
      'Credentials.json.',
      'sub/.git./config',
      'node_modules ./x.js',
    ];
    const unsafe = [
      '.ENV',
      '.Env.Local',
      'Credentials.json',
      'config/CREDENTIALS.JSON',
      '.NPMRC',
      'nested/.env/secret.txt',
      '.env.d/secret.txt',
      'Node_Modules/x/index.js',
      'DIST/out.js',
      'src/.Git/config',
    ];

    await write(root, 'kizen.json', '{}');

    for (const path of unsafe) {
      await write(root, path, 'secret');
    }

    expect(await zippedPaths(root)).toStrictEqual(['kizen.json']);

    for (const path of trailing) {
      await write(root, path, 'secret');
    }

    expect(await zippedPaths(root)).toStrictEqual(['kizen.json']);

    for (const path of trailing) {
      await rm(join(root, ...path.split('/')), { force: true });
    }

    await gitInit(root);
    // Git refuses to index any `.git` look-alike, and with core.ignorecase it skips `.Git` dirs.
    await isolatedGit(['config', 'core.ignorecase', 'false'], root);
    await isolatedGit(['add', '-f', '-A', '--', '.', ':(exclude)src/.Git'], root);
    expect(
      (await isolatedGit(['ls-files', '--others', '--exclude-standard', '-z'], root)).split('\0'),
    ).toContain('src/.Git/config');
    expect(await zippedPaths(root, isolatedGit)).toStrictEqual(['kizen.json']);
  });
});

describe('managed agent skills stay out of the source', () => {
  const MANAGED = [
    '.claude/skills/kizen-custom-block/SKILL.md',
    '.claude/skills/kizen-custom-block/design.md',
    '.claude/skills/kizen-business-apps/SKILL.md',
    '.agents/skills/kizen-custom-block/SKILL.md',
    '.agents/skills/kizen-custom-block/design.md',
    '.agents/skills/kizen-business-apps/SKILL.md',
  ];
  const OWN = [
    'kizen.json',
    '.claude/settings.json',
    '.claude/skills/my-skill/SKILL.md',
    '.agents/skills/kizen-custom-block-extra/SKILL.md',
    'src/.claude/skills/kizen-custom-block/SKILL.md',
  ];

  it.each(['walk', 'git'] as const)(
    'zipSourceDir leaves out only the CLI-managed skill folders (%s)',
    async (mode) => {
      const root = join(workDir, 'app');

      for (const path of [...MANAGED, ...OWN]) {
        await write(root, path, 'x');
      }

      if (mode === 'git') {
        await gitInit(root);
        await isolatedGit(['add', '-A'], root);
      }

      expect(await zippedPaths(root, mode === 'git' ? isolatedGit : undefined)).toStrictEqual(
        [...OWN].sort(),
      );
    },
  );

  it('isManagedSkillPath matches the managed folders as a case-insensitive filesystem would', () => {
    for (const path of [
      ...MANAGED,
      '.Claude/Skills/Kizen-Business-Apps/SKILL.md',
      '.agents/skills/kizen-custom-block./SKILL.md',
      '.agents/skills/kizen-custom-block',
      '.agents/skills/kizen-custom-block/',
    ]) {
      expect(isManagedSkillPath(path), path).toBe(true);
    }

    for (const path of [...OWN, '.claude/skills', '.agents/skills/kizen']) {
      expect(isManagedSkillPath(path), path).toBe(false);
    }
  });

  it('readZipEntries skips them in an older zip, so merges and base detection ignore them', () => {
    const zip = zipSync(
      Object.fromEntries([...MANAGED, ...OWN].map((path) => [path, strToU8('x')])),
    );
    const { files, skipped } = readZipEntries(zip);

    expect([...files.keys()].sort()).toStrictEqual([...OWN].sort());
    expect([...skipped].sort()).toStrictEqual([...MANAGED].sort());
  });
});

describe('unzip safety list', () => {
  it('unzipToDir never writes .git or safety-listed entries', async () => {
    const dest = join(workDir, 'out');
    const bytes = zipSync({
      'kizen.json': strToU8('{}'),
      'src/a.js': strToU8('a'),
      '.git/': new Uint8Array(0),
      '.git/config': strToU8('[core]\n\tfsmonitor = evil\n'),
      '.git/hooks/post-checkout': strToU8('#!/bin/sh\nevil\n'),
      'src/.GIT/HEAD': strToU8('ref'),
      '.env': strToU8('SECRET=1'),
      '.Env.Production': strToU8('SECRET=1'),
      'node_modules/x/index.js': strToU8('x'),
      'Credentials.json': strToU8('{}'),
    });

    await expect(unzipToDir(bytes, dest)).resolves.toStrictEqual({
      written: ['kizen.json', 'src/a.js'],
      skipped: [
        '.Env.Production',
        '.env',
        '.git/config',
        '.git/hooks/post-checkout',
        'Credentials.json',
        'node_modules/x/index.js',
        'src/.GIT/HEAD',
      ],
    });
    expect((await readdir(dest)).sort()).toStrictEqual(['kizen.json', 'src']);
    expect(await readdir(join(dest, 'src'))).toStrictEqual(['a.js']);
  });
});

function setDeclaredSize(bytes: Uint8Array, index: number, size: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  let end = out.length - 22;

  while (view.getUint32(end, true) !== 0x06054b50) {
    end -= 1;
  }

  let offset = view.getUint32(end + 16, true);

  for (let skip = index; skip > 0; skip -= 1) {
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }

  view.setUint32(offset + 24, size, true);

  return out;
}

describe('zip limits', () => {
  it('readZipEntries refuses entries over the uncompressed cap before decompressing', () => {
    const oneEntry = setDeclaredSize(
      zipSync({ 'kizen.json': strToU8('{}'), 'big.bin': strToU8('x') }),
      1,
      MAX_ZIP_ENTRY_BYTES + 1,
    );
    const entryError = (() => {
      try {
        readZipEntries(oneEntry);
      } catch (error) {
        return error;
      }

      return undefined;
    })();

    expect(entryError).toBeInstanceOf(ZipLimitError);
    expect((entryError as ZipLimitError).entry).toBe('big.bin');

    const perEntry = Math.floor(MAX_ZIP_TOTAL_BYTES / 5) + 1;

    expect(perEntry).toBeLessThan(MAX_ZIP_ENTRY_BYTES);

    let many: Uint8Array = zipSync({
      'a.bin': strToU8('a'),
      'b.bin': strToU8('b'),
      'c.bin': strToU8('c'),
      'd.bin': strToU8('d'),
      'e.bin': strToU8('e'),
    });

    for (let index = 0; index < 5; index += 1) {
      many = setDeclaredSize(many, index, perEntry);
    }

    expect(() => readZipEntries(many)).toThrow(
      `The source zip expands to more than ${String(MAX_ZIP_TOTAL_BYTES)} bytes; nothing was extracted.`,
    );

    const skippedBig = setDeclaredSize(
      zipSync({ '.git/objects/pack': strToU8('x'), 'kizen.json': strToU8('{}') }),
      0,
      MAX_ZIP_ENTRY_BYTES + 1,
    );

    expect(readZipEntries(skippedBig).skipped).toStrictEqual(['.git/objects/pack']);
  });

  it('readZipEntries refuses an entry whose data does not match its recorded size', () => {
    const content = strToU8('a'.repeat(1000));

    const shorter = setDeclaredSize(zipSync({ 'a.txt': content }), 0, 10);

    expect(() => readZipEntries(shorter)).toThrow(UnsafeZipEntryError);

    const longer = setDeclaredSize(zipSync({ 'a.txt': content }), 0, 2000);

    expect(() => readZipEntries(longer)).toThrow(UnsafeZipEntryError);

    expect([
      ...(readZipEntries(zipSync({ 'a.txt': content })).files.get('a.txt') ?? []),
    ]).toStrictEqual([...content]);
  });

  it('unzipToDir skips safety-listed names that differ only by trailing dots or spaces', async () => {
    const dest = join(workDir, 'out');
    const bytes = zipSync({
      'kizen.json': strToU8('{}'),
      '.git./hooks/post-checkout': strToU8('evil'),
      '.git /config': strToU8('evil'),
      '.env.': strToU8('SECRET'),
      'Credentials.json ': strToU8('{}'),
    });

    await expect(unzipToDir(bytes, dest)).resolves.toStrictEqual({
      written: ['kizen.json'],
      skipped: ['.env.', '.git /config', '.git./hooks/post-checkout', 'Credentials.json '],
    });
  });
});

describe('resolveExecutable', () => {
  it('git is resolved from PATH only, never the working directory', () => {
    const present = new Set(['/usr/local/bin/git', 'c:\\program files\\git\\cmd\\git.exe']);
    const isExecutable = (path: string): boolean =>
      present.has(path.toLowerCase()) || !/^([A-Za-z]:\\|\/)/.test(path);

    expect(
      resolveExecutable('git', {
        env: { PATH: ':.:bin:/usr/local/bin' },
        platform: 'darwin',
        isExecutable,
      }),
    ).toBe('/usr/local/bin/git');

    expect(
      resolveExecutable('git', {
        env: { Path: ';.;tools;C:\\Program Files\\Git\\cmd', PATHEXT: '.COM;.EXE;.CMD' },
        platform: 'win32',
        isExecutable,
      }),
    ).toBe('C:\\Program Files\\Git\\cmd\\git.EXE');

    expect(
      resolveExecutable('git', { env: { PATH: '.:bin::' }, platform: 'linux', isExecutable }),
    ).toBeUndefined();
    expect(resolveExecutable('git', { env: {}, platform: 'linux', isExecutable })).toBeUndefined();
  });

  it('tries each PATHEXT extension in order within a PATH entry', () => {
    const present = new Set(['c:\\bin\\git.cmd', 'c:\\bin\\git.exe']);

    expect(
      resolveExecutable('git', {
        env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' },
        platform: 'win32',
        isExecutable: (path) => present.has(path.toLowerCase()),
      }),
    ).toBe('C:\\bin\\git.EXE');
  });
});

describe('source lineage', () => {
  const files = { 'kizen.json': '{"api_name":"acme"}', 'src/a.js': 'a' };
  const plain = (): Uint8Array =>
    zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
  const lineage = { baseLiveVersion: '3', baseSourcePackageId: 'src-v3' };

  it('a written lineage reads back, and the files stay the same', () => {
    const zipped = withSourceLineage(plain(), lineage);

    expect(readSourceLineage(zipped)).toStrictEqual(lineage);
    expect(readSourceLineage(plain())).toBeNull();
    expect(readZipEntries(zipped)).toStrictEqual(readZipEntries(plain()));
    expect(withSourceLineage(plain(), lineage)).toStrictEqual(zipped);
    expect(
      readSourceLineage(
        withSourceLineage(zipped, { baseLiveVersion: null, baseSourcePackageId: null }),
      ),
    ).toStrictEqual({ baseLiveVersion: null, baseSourcePackageId: null });
  });

  it('readZipEntries and unzipToDir neither keep nor list the record', async () => {
    const zipped = withSourceLineage(plain(), lineage);
    const { files: kept, skipped } = readZipEntries(zipped);

    expect([...kept.keys()]).toStrictEqual(['kizen.json', 'src/a.js']);
    expect(skipped).toStrictEqual([]);

    const dest = join(workDir, 'out');
    const result = await unzipToDir(zipped, dest);

    expect(result).toStrictEqual({ written: ['kizen.json', 'src/a.js'], skipped: [] });
    expect((await readdir(dest)).sort()).toStrictEqual(['kizen.json', 'src']);
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['another format', JSON.stringify({ format: 2, ...lineage })],
    [
      'a base that is not a release number',
      JSON.stringify({ format: 1, baseLiveVersion: '0', baseSourcePackageId: 'x' }),
    ],
    [
      'a version without its package',
      JSON.stringify({ format: 1, baseLiveVersion: '3', baseSourcePackageId: null }),
    ],
    [
      'a package with a null base',
      JSON.stringify({ format: 1, baseLiveVersion: null, baseSourcePackageId: 'x' }),
    ],
    [
      'an empty package',
      JSON.stringify({ format: 1, baseLiveVersion: '3', baseSourcePackageId: '' }),
    ],
    ['a missing field', JSON.stringify({ format: 1, baseLiveVersion: '3' })],
    ['not an object', JSON.stringify(['3'])],
    ['over the size limit', JSON.stringify({ format: 1, ...lineage, pad: 'x'.repeat(5000) })],
    ['not UTF-8', '\uFFFD'],
  ])('a record with %s reads as none', (_name, raw) => {
    const bytes =
      raw === '\uFFFD'
        ? zipSync({ [SOURCE_LINEAGE_PATH]: new Uint8Array([0xff, 0xfe]) })
        : zipSync({ [SOURCE_LINEAGE_PATH]: strToU8(raw) });

    expect(readSourceLineage(bytes)).toBeNull();
  });

  it('an invalid zip reads as no lineage instead of throwing', () => {
    expect(readSourceLineage(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
