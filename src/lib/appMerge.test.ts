import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type BigIntStats, readdirSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMerge,
  MergeApplyError,
  MergeGitError,
  MergeStagingError,
  type MergeDeps,
  type MergePlan,
  MergeStaleError,
  planMerge,
  type ReadyMergePlan,
  UnsafeMergePathError,
} from './appMerge.js';
import {
  collectSourceFiles,
  type GitRunner,
  resolveGit,
  UnsafeZipEntryError,
} from './sourceZip.js';

const execFileAsync = promisify(execFile);

const REAL_IO_TIMEOUT = 30_000;

let workDir: string;
let pluginDir: string;
let workspaces: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'appbuilder-merge-test-'));
  pluginDir = join(workDir, 'plugin');
  workspaces = join(workDir, 'workspaces');
  await mkdir(pluginDir);
  await mkdir(workspaces);
}, REAL_IO_TIMEOUT);

afterEach(async () => {
  const left = await readdir(workspaces).catch(() => []);

  await rm(workDir, { recursive: true, force: true });
  expect(left).toStrictEqual([]);
}, REAL_IO_TIMEOUT);

type Files = Record<string, string | Uint8Array>;

const write = async (root: string, path: string, content: string | Uint8Array): Promise<void> => {
  const target = join(root, ...path.split('/'));

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const writeAll = async (root: string, files: Files): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    await write(root, path, content);
  }
};

const zipOf = (files: Files): Uint8Array => {
  const zippable: Zippable = {};

  for (const [path, content] of Object.entries(files)) {
    zippable[path] = typeof content === 'string' ? strToU8(content) : content;
  }

  return zipSync(zippable);
};

const read = (path: string): Promise<string> =>
  readFile(join(pluginDir, ...path.split('/')), 'utf8');

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

const NO_GIT: GitRunner = () =>
  Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));

const ISOLATED_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const isolatedGit: GitRunner = async (args, cwd) =>
  (
    await execFileAsync('git', ['-c', 'core.excludesFile=', ...args], {
      cwd,
      encoding: 'utf8',
      env: ISOLATED_GIT_ENV,
    })
  ).stdout;

const deps = (extra: MergeDeps = {}): MergeDeps => ({ git: NO_GIT, tmpDir: workspaces, ...extra });

const LINES = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`);
const text = (lines: readonly string[]): string => `${lines.join('\n')}\n`;
const edit = (index: number, value: string): string =>
  text(LINES.map((line, at) => (at === index ? value : line)));

const MANIFEST = '{"name":"app"}\n';

const plan = async (
  baseFiles: Files,
  liveFiles: Files,
  localFiles: Files,
  extra: MergeDeps = {},
): Promise<MergePlan> => {
  await writeAll(pluginDir, localFiles);

  return planMerge(
    {
      pluginDir,
      base: { version: '3', zip: zipOf(baseFiles) },
      live: { version: '4', zip: zipOf(liveFiles) },
    },
    deps(extra),
  );
};

const ready = (result: MergePlan): ReadyMergePlan => {
  if (result.status !== 'ready') {
    throw new Error(`expected a ready plan, got ${result.status}`);
  }

  return result;
};

interface Entry {
  type: 'file' | 'dir' | 'symlink';
  hash?: string;
  mode?: number;
  mtimeMs?: number;
  target?: string;
}

const snapshot = async (root: string): Promise<Record<string, Entry>> => {
  const out: Record<string, Entry> = {};

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const stats = await lstat(path);
      const key = `${prefix}${name}`;

      if (stats.isSymbolicLink()) {
        out[key] = { type: 'symlink', target: await readlink(path) };
      } else if (stats.isDirectory()) {
        out[key] = { type: 'dir', mode: stats.mode };
        await walk(path, `${key}/`);
      } else {
        out[key] = {
          type: 'file',
          hash: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
          mode: stats.mode,
          mtimeMs: stats.mtimeMs,
        };
      }
    }
  };

  await walk(root, '');

  return out;
};

describe('planMerge and applyMerge', { timeout: REAL_IO_TIMEOUT }, () => {
  it('clean three-way merge applies non-overlapping edits from live and keeps local edits', async () => {
    const result = ready(
      await plan(
        { 'kizen.json': MANIFEST, 'src/a.js': text(LINES), 'src/b.js': 'b\n' },
        { 'kizen.json': MANIFEST, 'src/a.js': edit(1, 'live 2'), 'src/b.js': 'b\n' },
        { 'kizen.json': MANIFEST, 'src/a.js': edit(10, 'local 11'), 'src/b.js': 'b local\n' },
      ),
    );

    expect(result).toMatchObject({
      written: ['src/a.js'],
      deleted: [],
      conflicted: [],
      binaryConflicts: [],
      ignoredIncoming: [],
      baseVersion: '3',
      liveVersion: '4',
    });

    const outcome = await applyMerge(result, { git: NO_GIT });

    expect(outcome).toStrictEqual({
      status: 'merged',
      written: ['src/a.js'],
      deleted: [],
      ignoredIncoming: [],
    });
    expect(await read('src/a.js')).toBe(
      text(LINES.map((line, at) => (at === 1 ? 'live 2' : at === 10 ? 'local 11' : line))),
    );
    expect(await read('src/b.js')).toBe('b local\n');
  });

  it('overlapping edits produce conflict markers and are listed in conflicted', async () => {
    const result = ready(
      await plan(
        { 'kizen.json': MANIFEST, 'a.js': text(LINES), 'b.js': text(LINES) },
        { 'kizen.json': MANIFEST, 'a.js': edit(4, 'live 5'), 'b.js': edit(0, 'live 1') },
        { 'kizen.json': MANIFEST, 'a.js': edit(4, 'local 5'), 'b.js': text(LINES) },
      ),
    );
    const outcome = await applyMerge(result, { git: NO_GIT });

    expect(outcome).toMatchObject({
      status: 'conflicts',
      written: ['a.js', 'b.js'],
      conflicted: ['a.js'],
      deletedOnLive: [],
      deletedLocally: [],
      binaryConflicts: [],
    });
    expect(await read('a.js')).toBe(
      text([
        ...LINES.slice(0, 4),
        '<<<<<<< HEAD',
        'local 5',
        '=======',
        'live 5',
        '>>>>>>> live',
        ...LINES.slice(5),
      ]),
    );
    expect(await read('b.js')).toBe(edit(0, 'live 1'));
  });

  it('file added on live is written; file deleted on live and untouched locally is removed; file deleted on live but edited locally is a conflict', async () => {
    const result = ready(
      await plan(
        { 'kizen.json': MANIFEST, 'old.js': 'old\n', 'edited.js': 'v1\n' },
        { 'kizen.json': MANIFEST, 'src/new/added.js': 'added\n' },
        { 'kizen.json': MANIFEST, 'old.js': 'old\n', 'edited.js': 'v2 local\n' },
      ),
    );

    expect(result).toMatchObject({
      written: ['src/new/added.js'],
      deleted: ['old.js'],
      conflicted: ['edited.js'],
      deletedOnLive: ['edited.js'],
    });

    const outcome = await applyMerge(result, { git: NO_GIT });

    expect(outcome.status).toBe('conflicts');
    expect(await read('src/new/added.js')).toBe('added\n');
    expect(await exists(join(pluginDir, 'old.js'))).toBe(false);
    expect(await read('edited.js')).toBe('v2 local\n');
  });

  it('file deleted locally but changed on live is a conflict and live copy is written', async () => {
    const result = ready(
      await plan(
        { 'kizen.json': MANIFEST, 'gone.js': 'v1\n' },
        { 'kizen.json': MANIFEST, 'gone.js': 'v2 live\n' },
        { 'kizen.json': MANIFEST },
      ),
    );

    expect(result).toMatchObject({
      written: ['gone.js'],
      conflicted: ['gone.js'],
      deletedLocally: ['gone.js'],
      deletedOnLive: [],
    });
    await applyMerge(result, { git: NO_GIT });
    expect(await read('gone.js')).toBe('v2 live\n');
  });

  it('binary conflict keeps the local file and is reported', async () => {
    const baseBytes = new Uint8Array([0x89, 0x50, 0, 1, 2, 3]);
    const localBytes = new Uint8Array([0x89, 0x50, 0, 1, 2, 4]);
    const liveBytes = new Uint8Array([0x89, 0x50, 0, 1, 2, 5]);
    const result = ready(
      await plan(
        { 'kizen.json': MANIFEST, 'img.png': baseBytes },
        { 'kizen.json': MANIFEST, 'img.png': liveBytes },
        { 'kizen.json': MANIFEST, 'img.png': localBytes },
      ),
    );

    expect(result).toMatchObject({ written: [], conflicted: [], binaryConflicts: ['img.png'] });

    const outcome = await applyMerge(result, { git: NO_GIT });

    expect(outcome).toMatchObject({ status: 'conflicts', binaryConflicts: ['img.png'] });
    expect(new Uint8Array(await readFile(join(pluginDir, 'img.png')))).toStrictEqual(localBytes);
    expect((await readdir(pluginDir)).sort()).toStrictEqual(['img.png', 'kizen.json']);
  });

  it('up_to_date when live changes nothing relative to local', async () => {
    const result = await plan(
      { 'kizen.json': MANIFEST, 'a.js': 'a\n' },
      { 'kizen.json': MANIFEST, 'a.js': 'a\n' },
      { 'kizen.json': MANIFEST, 'a.js': 'a local\n' },
    );

    expect(result).toStrictEqual({ status: 'up_to_date', ignoredIncoming: [] });
    expect(await applyMerge(result)).toStrictEqual(result);
  });

  it('planMerge never writes to pluginDir', async () => {
    await writeAll(pluginDir, {
      'kizen.json': MANIFEST,
      'a.js': edit(4, 'local 5'),
      'deleted-on-live.js': 'x\n',
      'img.png': new Uint8Array([0, 1, 9]),
    });

    const before = await snapshot(pluginDir);
    const result = await plan(
      {
        'kizen.json': MANIFEST,
        'a.js': text(LINES),
        'deleted-on-live.js': 'x\n',
        'img.png': new Uint8Array([0, 1, 2]),
      },
      {
        'kizen.json': MANIFEST,
        'a.js': edit(4, 'live 5'),
        'added.js': 'added\n',
        'img.png': new Uint8Array([0, 1, 3]),
      },
      {},
    );

    expect(ready(result).written.length).toBeGreaterThan(0);
    expect(await snapshot(pluginDir)).toStrictEqual(before);
  });

  it('applyMerge refuses when the plugin dir changed after planning', async () => {
    const files = { 'kizen.json': MANIFEST, 'a.js': text(LINES), 'b.js': 'b\n' };
    const result = ready(
      await plan(
        files,
        { ...files, 'a.js': edit(0, 'live 1'), 'added.js': 'added\n' },
        { ...files, 'b.js': 'b local\n' },
      ),
    );

    await write(pluginDir, 'b.js', 'b changed again\n');

    const afterEdit = await snapshot(pluginDir);
    const error = await applyMerge(result, { git: NO_GIT }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MergeStaleError);
    expect((error as MergeStaleError).paths).toStrictEqual(['b.js']);
    expect(await snapshot(pluginDir)).toStrictEqual(afterEdit);

    await write(pluginDir, 'b.js', 'b local\n');
    await write(pluginDir, 'c.js', 'new\n');

    const afterAdd = await snapshot(pluginDir);

    await expect(applyMerge(result, { git: NO_GIT })).rejects.toBeInstanceOf(MergeStaleError);
    expect(await snapshot(pluginDir)).toStrictEqual(afterAdd);
  });

  it('applyMerge refuses when something appears at a path the merge adds', async () => {
    const result = ready(
      await plan(
        { 'kizen.json': MANIFEST, '.gitignore': 'secret.cfg\n' },
        { 'kizen.json': MANIFEST, '.gitignore': 'secret.cfg\n', 'cfg/new.js': 'new\n' },
        { 'kizen.json': MANIFEST, '.gitignore': 'secret.cfg\n' },
      ),
    );

    expect(result.written).toStrictEqual(['cfg/new.js']);
    await mkdir(join(pluginDir, 'cfg'));
    await symlink(join(workDir, 'elsewhere.js'), join(pluginDir, 'cfg', 'new.js'));

    const before = await snapshot(pluginDir);

    await expect(applyMerge(result, { git: NO_GIT })).rejects.toBeInstanceOf(MergeStaleError);
    expect(await snapshot(pluginDir)).toStrictEqual(before);
    expect(await exists(join(workDir, 'elsewhere.js'))).toBe(false);
  });

  it('merge never writes safety-listed or outside paths even if live contains them', async () => {
    const files = { 'kizen.json': MANIFEST, 'a.js': 'a\n' };
    const hostile = {
      ...files,
      'a.js': 'a live\n',
      '.env': 'SECRET=live',
      '.env.local': 'SECRET=live',
      '.git/config': '[core]\n\thooksPath = /tmp/x\n',
      '.git/hooks/post-merge': '#!/bin/sh\necho pwned\n',
      'node_modules/x/index.js': 'x',
      'dist/index.js': 'x',
      'src/credentials.json': '{}',
      '.kizenappbuilder/credentials.json': '{}',
    };
    const result = ready(await plan(files, hostile, { ...files, '.env': 'SECRET=local' }));

    expect(result.written).toStrictEqual(['a.js']);

    await applyMerge(result, { git: NO_GIT });

    expect(await read('a.js')).toBe('a live\n');
    expect(await read('.env')).toBe('SECRET=local');
    expect((await readdir(pluginDir)).sort()).toStrictEqual(['.env', 'a.js', 'kizen.json']);

    const escaping = planMerge(
      {
        pluginDir,
        base: { version: '3', zip: zipOf(files) },
        live: { version: '4', zip: zipOf({ ...files, '../escaped.txt': 'x' }) },
      },
      deps(),
    );

    await expect(escaping).rejects.toBeInstanceOf(UnsafeZipEntryError);
    expect(await exists(join(workDir, 'escaped.txt'))).toBe(false);
  });

  it.each([
    ['.env'],
    ['src/.env.production'],
    ['.git/config'],
    ['node_modules/x.js'],
    ['../escaped.txt'],
    ['src/../../escaped.txt'],
    ['/tmp/absolute.txt'],
    ['C:/escaped.txt'],
  ])('applyMerge refuses a plan that would write %s', async (path) => {
    const files = { 'kizen.json': MANIFEST, 'a.js': 'a\n' };
    const result = ready(await plan(files, { ...files, 'a.js': 'a live\n' }, files));
    const tampered: ReadyMergePlan = {
      ...result,
      written: [...result.written, path],
      contents: new Map([...result.contents, [path, strToU8('pwned')]]),
    };
    const before = await snapshot(pluginDir);

    await expect(applyMerge(tampered, { git: NO_GIT })).rejects.toBeInstanceOf(
      UnsafeMergePathError,
    );
    expect(await snapshot(pluginDir)).toStrictEqual(before);
    expect(await exists(join(workDir, 'escaped.txt'))).toBe(false);
  });

  it('applyMerge refuses a plan that would delete a file outside the planned local set', async () => {
    const files = { 'kizen.json': MANIFEST, 'a.js': 'a\n' };
    const result = ready(await plan(files, { ...files, 'a.js': 'a live\n' }, files));

    await write(pluginDir, 'ignored.txt', 'not a planned source file\n');

    await expect(
      applyMerge({ ...result, deleted: ['ignored.txt'] }, { git: NO_GIT }),
    ).rejects.toBeInstanceOf(UnsafeMergePathError);
  });

  it('merge never writes through a symlinked directory in the plugin dir', async () => {
    const outside = join(workDir, 'outside');

    await writeAll(outside, { 'existing.js': 'outside\n' });

    const outsideBefore = await snapshot(outside);
    const base = { 'kizen.json': MANIFEST, 'lib/existing.js': 'v1\n' };

    await write(pluginDir, 'kizen.json', MANIFEST);
    await symlink(outside, join(pluginDir, 'lib'));

    const result = ready(
      await plan(
        base,
        {
          ...base,
          'lib/existing.js': 'v2 live\n',
          'lib/evil.js': 'evil\n',
          'a.js': 'a\n',
        },
        {},
      ),
    );

    expect(result.written).toStrictEqual(['a.js']);
    expect(result.ignoredIncoming).toStrictEqual(['lib/evil.js', 'lib/existing.js']);
    expect(result.conflicted).toStrictEqual([]);

    await applyMerge(result, { git: NO_GIT });
    expect(await snapshot(outside)).toStrictEqual(outsideBefore);

    const again = ready(
      await planMerge(
        {
          pluginDir,
          base: { version: '3', zip: zipOf(base) },
          live: { version: '4', zip: zipOf({ ...base, 'b.js': 'b\n' }) },
        },
        deps(),
      ),
    );
    const tampered: ReadyMergePlan = {
      ...again,
      written: [...again.written, 'lib/evil.js'],
      contents: new Map([...again.contents, ['lib/evil.js', strToU8('evil')]]),
    };

    await expect(applyMerge(tampered, { git: NO_GIT })).rejects.toBeInstanceOf(MergeStaleError);
    expect(await snapshot(outside)).toStrictEqual(outsideBefore);
    expect(await exists(join(pluginDir, 'b.js'))).toBe(false);
  });

  it.each([
    ['walk', NO_GIT],
    ['git', isolatedGit],
  ] as const)(
    'live files at paths ignored locally are not written (%s mode)',
    async (mode, git) => {
      if (mode === 'git') {
        await isolatedGit(['init', '-q'], pluginDir);
      }

      const ignores = { '.gitignore': 'secret.cfg\ncache/\n', '.kizenignore': 'notes.md\n' };
      const base = { 'kizen.json': MANIFEST, ...ignores };
      const result = await plan(
        base,
        {
          ...base,
          'secret.cfg': 'live secret',
          'cache/x.bin': 'cached',
          'cache/we"ird.txt': 'cached',
          'notes.md': 'live notes',
          'a.js': 'a\n',
        },
        { ...base, 'secret.cfg': 'local secret' },
        { git },
      );
      const lists = ready(result);

      expect(lists.written).toStrictEqual(['a.js']);
      expect(lists.ignoredIncoming).toStrictEqual([
        'cache/we"ird.txt',
        'cache/x.bin',
        'notes.md',
        'secret.cfg',
      ]);

      await applyMerge(result, { git });
      expect(await read('secret.cfg')).toBe('local secret');
      expect(await exists(join(pluginDir, 'cache'))).toBe(false);
      expect(await exists(join(pluginDir, 'notes.md'))).toBe(false);
      expect(await read('a.js')).toBe('a\n');
    },
  );

  it('keeps an existing file executable', async () => {
    const files = { 'kizen.json': MANIFEST, 'run.sh': text(LINES) };
    const result = ready(await plan(files, { ...files, 'run.sh': edit(0, 'live') }, files));

    await chmod(join(pluginDir, 'run.sh'), 0o755);
    await applyMerge(result, { git: NO_GIT });
    expect((await lstat(join(pluginDir, 'run.sh'))).mode & 0o777).toBe(0o755);
    expect(await read('run.sh')).toBe(edit(0, 'live'));
  });
});

describe('replacements and odd names', { timeout: REAL_IO_TIMEOUT }, () => {
  it('case-only rename on live keeps the local edit', async () => {
    const base = { 'kizen.json': MANIFEST, 'foo.js': text(LINES) };
    const result = ready(
      await plan(
        base,
        { 'kizen.json': MANIFEST, 'Foo.js': text(LINES) },
        { ...base, 'foo.js': edit(11, 'local 12') },
      ),
    );

    expect(result).toMatchObject({
      written: ['Foo.js'],
      deleted: ['foo.js'],
      conflicted: [],
      ignoredIncoming: [],
    });

    const outcome = await applyMerge(result, { git: NO_GIT });

    expect(outcome.status).toBe('merged');
    expect((await readdir(pluginDir)).sort()).toStrictEqual(['Foo.js', 'kizen.json']);
    expect(await read('Foo.js')).toBe(edit(11, 'local 12'));
  });

  it('file replaced by a directory on live is applied without losing data', async () => {
    const base = { 'kizen.json': MANIFEST, foo: 'foo file\n', 'a.js': 'a\n' };
    const result = ready(
      await plan(
        base,
        { 'kizen.json': MANIFEST, 'foo/bar.js': 'bar\n', 'a.js': 'a\n' },
        { ...base, 'a.js': 'a local\n' },
      ),
    );

    expect(result).toMatchObject({ written: ['foo/bar.js'], deleted: ['foo'], conflicted: [] });
    await applyMerge(result, { git: NO_GIT });
    expect(await read('foo/bar.js')).toBe('bar\n');
    expect(await read('a.js')).toBe('a local\n');
    expect(await readdir(join(pluginDir, 'foo'))).toStrictEqual(['bar.js']);
  });

  it('file replaced by a directory on live keeps a local edit to the file', async () => {
    const base = { 'kizen.json': MANIFEST, foo: 'foo file\n' };
    const result = ready(
      await plan(
        base,
        { 'kizen.json': MANIFEST, 'foo/bar.js': 'bar\n' },
        { ...base, foo: 'foo edited\n' },
      ),
    );

    expect(result.conflicted.length).toBeGreaterThan(0);
    await applyMerge(result, { git: NO_GIT });

    const all = await snapshot(pluginDir);
    const keptEdit = await Promise.all(
      Object.entries(all)
        .filter(([, entry]) => entry.type === 'file')
        .map(async ([path]) => read(path)),
    );

    expect(keptEdit).toContain('foo edited\n');
  });

  it('directory replaced by a file on live is applied and leaves no empty directory', async () => {
    const base = { 'kizen.json': MANIFEST, 'foo/bar.js': 'bar\n', 'foo/deep/baz.js': 'baz\n' };
    const result = ready(await plan(base, { 'kizen.json': MANIFEST, foo: 'foo file\n' }, base));

    expect(result).toMatchObject({
      written: ['foo'],
      deleted: ['foo/bar.js', 'foo/deep/baz.js'],
      conflicted: [],
    });

    const outcome = await applyMerge(result, { git: NO_GIT });

    expect(outcome.status).toBe('merged');
    expect((await lstat(join(pluginDir, 'foo'))).isFile()).toBe(true);
    expect(await read('foo')).toBe('foo file\n');
    expect((await readdir(pluginDir)).sort()).toStrictEqual(['foo', 'kizen.json']);
  });

  it('deletions prune the folders they empty and keep the rest', async () => {
    const base = {
      'kizen.json': MANIFEST,
      'src/old/a.js': 'a\n',
      'src/old/deeper/b.js': 'b\n',
      'src/keep.js': 'keep\n',
    };
    const result = ready(
      await plan(base, { 'kizen.json': MANIFEST, 'src/keep.js': 'keep\n' }, base),
    );

    await mkdir(join(pluginDir, 'empty-before'));
    await applyMerge(result, { git: NO_GIT });
    expect(await readdir(join(pluginDir, 'src'))).toStrictEqual(['keep.js']);
    expect(await exists(join(pluginDir, 'empty-before'))).toBe(true);
  });

  it('plan never deletes a path whose replacement it skips', async () => {
    const folder = { 'kizen.json': MANIFEST, 'foo/bar.js': 'bar\n' };
    const result = ready(await plan(folder, { 'kizen.json': MANIFEST, foo: 'foo file\n' }, folder));

    await write(pluginDir, 'foo/.DS_Store', 'finder');
    expect(result.deleted).toStrictEqual(['foo/bar.js']);

    const blockedPlan = ready(
      await planMerge(
        {
          pluginDir,
          base: { version: '3', zip: zipOf(folder) },
          live: { version: '4', zip: zipOf({ 'kizen.json': MANIFEST, foo: 'foo file\n' }) },
        },
        deps(),
      ),
    );

    expect(blockedPlan).toMatchObject({
      written: [],
      deleted: [],
      conflicted: ['foo', 'foo/bar.js'],
      ignoredIncoming: [],
    });
    await applyMerge(blockedPlan, { git: NO_GIT });
    expect(await read('foo/bar.js')).toBe('bar\n');
    expect(await read('foo/.DS_Store')).toBe('finder');

    await rm(join(pluginDir, 'foo'), { recursive: true });

    const ignores = { 'kizen.json': MANIFEST, '.kizenignore': 'foo/bar.js\n' };
    const turned = ready(
      await plan(
        { ...ignores, foo: 'foo file\n' },
        { ...ignores, 'foo/bar.js': 'bar\n' },
        { ...ignores, foo: 'foo file\n' },
      ),
    );

    expect(turned).toMatchObject({
      written: [],
      deleted: [],
      conflicted: ['foo', 'foo/bar.js'],
      ignoredIncoming: [],
    });
    await applyMerge(turned, { git: NO_GIT });
    expect(await read('foo')).toBe('foo file\n');
  });

  it.each([
    ['walk', NO_GIT],
    ['git', isolatedGit],
  ] as const)(
    'live paths with special characters are written end to end (%s mode)',
    async (mode, git) => {
      if (mode === 'git') {
        await isolatedGit(['init', '-q'], pluginDir);
      }

      const names = [
        'with space.js',
        'quo"te.js',
        'new\nline.js',
        'tab\there.js',
        'café.js',
        '日本語/ファイル.js',
        'star*.js',
        'q?.js',
        '[brackets].js',
        ':colon.js',
      ];
      const base = { 'kizen.json': MANIFEST };
      const live: Files = { ...base };

      for (const name of names) {
        live[name] = `content of ${name}\n`;
      }

      const result = ready(await plan(base, live, base, { git }));

      expect(result.written).toStrictEqual([...names].sort());
      expect(result.ignoredIncoming).toStrictEqual([]);
      await applyMerge(result, { git });

      for (const name of names) {
        expect(await read(name)).toBe(`content of ${name}\n`);
      }
    },
  );

  it('a local file stored in NFD merges with the NFC name Live uses', async () => {
    const nfc = 'café.js';
    const nfd = 'café.js';
    const result = ready(
      await plan(
        { 'kizen.json': MANIFEST, [nfc]: text(LINES) },
        { 'kizen.json': MANIFEST, [nfc]: edit(0, 'live 1') },
        { 'kizen.json': MANIFEST, [nfd]: edit(11, 'local 12') },
      ),
    );

    expect(result).toMatchObject({ written: [nfc], ignoredIncoming: [], conflicted: [] });
    await applyMerge(result, { git: NO_GIT });

    const names = await readdir(pluginDir);

    expect(names).toHaveLength(2);
    expect(names.map((name) => name.normalize('NFC')).sort()).toStrictEqual([nfc, 'kizen.json']);
    expect(await read(names.find((name) => name !== 'kizen.json') ?? '')).toBe(
      text(LINES.map((line, at) => (at === 0 ? 'live 1' : at === 11 ? 'local 12' : line))),
    );
  });

  it('git mode reports live paths under a symlinked directory as ignoredIncoming', async () => {
    const outside = join(workDir, 'outside');

    await writeAll(outside, { 'existing.js': 'outside\n' });
    await isolatedGit(['init', '-q'], pluginDir);
    await write(pluginDir, 'kizen.json', MANIFEST);
    await symlink(outside, join(pluginDir, 'lib'));

    const outsideBefore = await snapshot(outside);
    const base = { 'kizen.json': MANIFEST };
    const result = ready(
      await plan(
        base,
        { ...base, 'lib/evil.js': 'evil\n', 'lib/existing.js': 'x\n', 'a.js': 'a\n' },
        {},
        { git: isolatedGit },
      ),
    );

    expect(result.written).toStrictEqual(['a.js']);
    expect(result.ignoredIncoming).toStrictEqual(['lib/evil.js', 'lib/existing.js']);
    await applyMerge(result, { git: isolatedGit });
    expect(await snapshot(outside)).toStrictEqual(outsideBefore);
  });

  it('pathspec-magic live paths are checked literally', async () => {
    await isolatedGit(['init', '-q'], pluginDir);

    const base = { 'kizen.json': MANIFEST, '.gitignore': 'x.js\nignored/\n' };
    const result = ready(
      await plan(
        base,
        {
          ...base,
          ':x.js': 'a\n',
          ':(glob)y.js': 'b\n',
          ':!z.js': 'c\n',
          ':(top)ignored/w.js': 'd\n',
          'ignored/v.js': 'e\n',
        },
        base,
        { git: isolatedGit },
      ),
    );

    expect(result.written).toStrictEqual([':!z.js', ':(glob)y.js', ':(top)ignored/w.js', ':x.js']);
    expect(result.ignoredIncoming).toStrictEqual(['ignored/v.js']);
  });

  it('MergeStaleError names the first ten paths and counts the rest', () => {
    const paths = Array.from({ length: 15 }, (_, index) => `f${String(index)}.js`);
    const error = new MergeStaleError(paths);

    expect(error.paths).toStrictEqual(paths);
    expect(error.message).toContain('f9.js and 5 more');
    expect(error.message).not.toContain('f10.js');
  });
});

describe('apply staging', { timeout: REAL_IO_TIMEOUT }, () => {
  it.each([
    ['walk', NO_GIT],
    ['git', isolatedGit],
  ] as const)(
    'a failed apply leaves recovery files under .kizenapp and outside the source set (%s mode)',
    async (mode, git) => {
      if (mode === 'git') {
        await isolatedGit(['init', '-q'], pluginDir);
      }

      const base = { 'kizen.json': MANIFEST, 'src/old.js': 'old\n', 'a.js': text(LINES) };
      const result = ready(
        await plan(base, { 'kizen.json': MANIFEST, 'a.js': edit(0, 'live 1') }, base, { git }),
      );
      let moves = 0;
      const failingRename = async (from: string, to: string): Promise<void> => {
        moves += 1;

        if (moves > 1) {
          throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
        }

        await rename(from, to);
      };

      const error = await applyMerge(result, { git, rename: failingRename }).catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(MergeApplyError);

      const { recoveryDir } = error as MergeApplyError;

      expect(recoveryDir.startsWith(join(pluginDir, '.kizenapp', 'merge-'))).toBe(true);
      expect(await readFile(join(recoveryDir, 'removed', 'src', 'old.js'), 'utf8')).toBe('old\n');
      expect(await readFile(join(recoveryDir, 'merged', 'a.js'), 'utf8')).toBe(edit(0, 'live 1'));
      expect((error as MergeApplyError).message).toContain(join(recoveryDir, 'removed'));

      const listed = await collectSourceFiles(pluginDir, { git });

      expect(listed.mode).toBe(mode);
      expect(listed.files).toStrictEqual(['a.js', 'kizen.json']);

      const again = ready(
        await planMerge(
          {
            pluginDir,
            base: { version: '3', zip: zipOf(base) },
            live: {
              version: '4',
              zip: zipOf({ 'kizen.json': MANIFEST, 'a.js': edit(0, 'live 1') }),
            },
          },
          deps({ git }),
        ),
      );

      expect([...again.localHashes.keys()].sort()).toStrictEqual(['a.js', 'kizen.json']);
    },
  );

  it('applyMerge refuses a symlinked .kizenapp before writing anything', async () => {
    const files = { 'kizen.json': MANIFEST, 'a.js': 'a\n', 'old.js': 'old\n' };
    const result = ready(await plan(files, { 'kizen.json': MANIFEST, 'a.js': 'a live\n' }, files));
    const outside = join(workDir, 'outside-state');

    await mkdir(outside);
    await symlink(outside, join(pluginDir, '.kizenapp'));

    const before = await snapshot(pluginDir);

    await expect(applyMerge(result, { git: NO_GIT })).rejects.toBeInstanceOf(MergeStagingError);
    expect(await snapshot(pluginDir)).toStrictEqual(before);
    expect(await readdir(outside)).toStrictEqual([]);
  });

  it('applyMerge refuses a .kizenapp on a different device', async () => {
    const files = { 'kizen.json': MANIFEST, 'a.js': 'a\n', 'old.js': 'old\n' };
    const result = ready(await plan(files, { 'kizen.json': MANIFEST, 'a.js': 'a live\n' }, files));
    const before = await snapshot(pluginDir);
    const otherDevice = async (path: string, follow: boolean): Promise<BigIntStats> => {
      const real = follow
        ? await stat(path, { bigint: true })
        : await lstat(path, { bigint: true });

      return path.endsWith('.kizenapp')
        ? Object.assign(Object.create(Object.getPrototypeOf(real) as object) as BigIntStats, real, {
            dev: real.dev + 1n,
          })
        : real;
    };

    await expect(applyMerge(result, { git: NO_GIT, stat: otherDevice })).rejects.toBeInstanceOf(
      MergeStagingError,
    );
    expect(await snapshot(pluginDir)).toStrictEqual(before);

    await mkdir(join(pluginDir, '.kizenapp'));
    await write(pluginDir, '.kizenapp/config.json', '{}');

    const withState = await snapshot(pluginDir);

    await expect(applyMerge(result, { git: NO_GIT, stat: otherDevice })).rejects.toBeInstanceOf(
      MergeStagingError,
    );
    expect(await snapshot(pluginDir)).toStrictEqual(withState);
  });

  it('applyMerge cancelled after staging writes nothing to the plugin folder and leaves no staging', async () => {
    const base = { 'kizen.json': MANIFEST, 'a.js': 'a\n', 'old.js': 'old\n' };
    const result = ready(await plan(base, { 'kizen.json': MANIFEST, 'a.js': 'a live\n' }, base));
    const stagedWhenAsked: string[][] = [];
    const isAborted = vi.fn(() => {
      stagedWhenAsked.push(
        readdirSync(join(pluginDir, '.kizenapp'))
          .filter((name) => name.startsWith('merge-'))
          .flatMap((dir) => readdirSync(join(pluginDir, '.kizenapp', dir, 'merged'))),
      );

      return true;
    });

    const before = await snapshot(pluginDir);

    expect(await applyMerge(result, { git: NO_GIT, isAborted })).toStrictEqual({
      status: 'cancelled',
    });
    expect(stagedWhenAsked).toStrictEqual([['a.js']]);
    expect(await snapshot(pluginDir)).toStrictEqual(before);

    await write(pluginDir, '.kizenapp/config.json', '{}');

    const withState = await snapshot(pluginDir);

    expect(await applyMerge(result, { git: NO_GIT, isAborted })).toStrictEqual({
      status: 'cancelled',
    });
    expect(await snapshot(pluginDir)).toStrictEqual(withState);
    expect(stagedWhenAsked).toStrictEqual([['a.js'], ['a.js']]);

    await applyMerge(result, { git: NO_GIT, isAborted: () => false });
    expect(await read('a.js')).toBe('a live\n');
    expect(await exists(join(pluginDir, 'old.js'))).toBe(false);
  });

  it('a successful apply leaves no staging folder and keeps an existing .kizenapp', async () => {
    const files = { 'kizen.json': MANIFEST, 'a.js': 'a\n' };
    const result = ready(await plan(files, { ...files, 'a.js': 'a live\n' }, files));

    await write(pluginDir, '.kizenapp/config.json', '{}');
    await applyMerge(result, { git: NO_GIT });
    expect(await readdir(join(pluginDir, '.kizenapp'))).toStrictEqual(['config.json']);
    expect(await read('a.js')).toBe('a live\n');
  });
});

describe('throwaway repository isolation', { timeout: REAL_IO_TIMEOUT }, () => {
  it("user hooks and global config don't run in the throwaway repo", async () => {
    const marker = join(workDir, 'hostile-ran');
    const hooks = join(workDir, 'hooks');
    const xdg = join(workDir, 'xdg');
    const run = join(workDir, 'hostile-command');

    for (const hook of [
      'post-checkout',
      'pre-merge-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-merge',
      'pre-commit',
      'post-commit',
    ]) {
      await write(hooks, hook, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      await chmod(join(hooks, hook), 0o755);
    }

    await write(workDir, 'hostile-command', `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
    await chmod(run, 0o755);
    await write(workDir, 'hostile-fsmonitor', `#!/bin/sh\necho fsmonitor >> "${marker}"\nexit 1\n`);
    await chmod(join(workDir, 'hostile-fsmonitor'), 0o755);

    const hostileAttributes = '* filter=evil merge=evil diff=evil\n';
    const hostileConfig = [
      '[core]',
      `\thooksPath = ${hooks}`,
      `\tattributesFile = ${join(workDir, 'attributes')}`,
      `\tfsmonitor = ${join(workDir, 'hostile-fsmonitor')}`,
      '[merge]',
      '\tconflictStyle = diff3',
      '\trenames = false',
      '[merge "evil"]',
      `\tdriver = ${run}`,
      '[filter "evil"]',
      `\tclean = ${run}`,
      `\tsmudge = ${run}`,
      '\trequired = true',
      '[user]',
      '\tname = Host',
      '\temail = host@example.com',
      '',
    ].join('\n');

    await write(workDir, 'attributes', hostileAttributes);
    await write(workDir, 'gitconfig', hostileConfig);
    await writeAll(xdg, { 'git/config': hostileConfig, 'git/attributes': hostileAttributes });

    const hostileEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(workDir, 'gitconfig'),
      XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooks,
      GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${hooks}'`,
      GIT_TEMPLATE_DIR: join(workDir, 'template'),
    };
    const base = {
      'kizen.json': MANIFEST,
      'a.js': text(LINES),
      'b.js': text(LINES),
      'moved.js': text(LINES),
    };
    const live = {
      'kizen.json': MANIFEST,
      '.gitattributes': hostileAttributes,
      'a.js': edit(0, 'live 1'),
      'b.js': edit(5, 'live 6'),
      'renamed.js': text(LINES),
    };
    const result = ready(
      await plan(
        base,
        live,
        {
          ...base,
          'a.js': edit(0, 'local 1'),
          'b.js': edit(9, 'local 10'),
          'moved.js': edit(11, 'local 12'),
        },
        {
          env: hostileEnv,
        },
      ),
    );

    await applyMerge(result, { git: NO_GIT });

    expect(await exists(marker)).toBe(false);
    expect(result.conflicted).toStrictEqual(['a.js']);
    expect(result.deleted).toStrictEqual(['moved.js']);
    expect(await read('renamed.js')).toBe(edit(11, 'local 12'));
    expect(await read('a.js')).not.toContain('|||||||');
    expect(await read('b.js')).toBe(
      text(LINES.map((line, at) => (at === 5 ? 'live 6' : at === 9 ? 'local 10' : line))),
    );

    const probe = join(workDir, 'probe');

    await writeAll(probe, { 'a.js': 'a\n' });
    await execFileAsync('git', ['init', '-q', '--template='], { cwd: probe, env: hostileEnv });
    await execFileAsync('git', ['add', '-A'], { cwd: probe, env: hostileEnv });
    await execFileAsync('git', ['commit', '-q', '-m', 'x'], { cwd: probe, env: hostileEnv });
    expect(await exists(marker)).toBe(true);
  }, 30_000);

  it('isolation holds when git ignores GIT_CONFIG_GLOBAL (git < 2.32)', async () => {
    const marker = join(workDir, 'hostile-ran');
    const hooks = join(workDir, 'hooks');
    const hostileHome = join(workDir, 'home');
    const hostileXdg = join(workDir, 'xdg');
    const hostileConfig = [
      '[core]',
      `\thooksPath = ${hooks}`,
      '[merge]',
      '\trenames = false',
      '\tconflictStyle = diff3',
      '',
    ].join('\n');

    for (const hook of ['post-checkout', 'pre-merge-commit', 'prepare-commit-msg', 'post-merge']) {
      await write(hooks, hook, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      await chmod(join(hooks, hook), 0o755);
    }

    await write(hostileHome, '.gitconfig', hostileConfig);
    await write(hostileXdg, 'git/config', hostileConfig);

    const oldGit = join(workDir, 'old-git');

    await write(
      workDir,
      'old-git',
      `#!/bin/sh\nunset GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM\nexec "${resolveGit()}" "$@"\n`,
    );
    await chmod(oldGit, 0o755);

    const parentEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: hostileHome,
      XDG_CONFIG_HOME: hostileXdg,
    };

    delete parentEnv.GIT_CONFIG_GLOBAL;
    delete parentEnv.GIT_CONFIG_SYSTEM;

    const base = { 'kizen.json': MANIFEST, 'moved.js': text(LINES), 'a.js': text(LINES) };
    const result = ready(
      await plan(
        base,
        {
          'kizen.json': MANIFEST,
          'renamed.js': text(LINES),
          'a.js': edit(0, 'live 1'),
        },
        { ...base, 'moved.js': edit(11, 'local 12'), 'a.js': edit(0, 'local 1') },
        { env: parentEnv, findGit: () => oldGit },
      ),
    );

    await applyMerge(result, { git: NO_GIT });
    expect(await exists(marker)).toBe(false);
    expect(result.deleted).toStrictEqual(['moved.js']);
    expect(await read('renamed.js')).toBe(edit(11, 'local 12'));
    expect(await read('a.js')).not.toContain('|||||||');

    const { stdout } = await execFileAsync(oldGit, ['config', '--get', 'merge.renames'], {
      cwd: workDir,
      env: parentEnv,
    });

    expect(stdout.trim()).toBe('false');
  });

  it("in-tree .gitattributes can't rewrite merged file contents", async () => {
    const base = { 'kizen.json': MANIFEST, 'a.txt': text(LINES), 'c.txt': 'crlf\r\nkept\r\n' };
    const live = {
      ...base,
      '.gitattributes': '* text eol=crlf\n*.txt working-tree-encoding=UTF-16\n',
      'a.txt': edit(0, 'live 1'),
      'c.txt': 'crlf\r\nkept\r\nlive\r\n',
    };
    const result = ready(await plan(base, live, { ...base, 'a.txt': edit(11, 'local 12') }));

    await applyMerge(result, { git: NO_GIT });

    expect(await read('a.txt')).toBe(
      text(LINES.map((line, at) => (at === 0 ? 'live 1' : at === 11 ? 'local 12' : line))),
    );
    expect(await read('c.txt')).toBe('crlf\r\nkept\r\nlive\r\n');
    expect(await read('.gitattributes')).toBe(live['.gitattributes']);
  });

  it('the throwaway repo is deleted on success and on failure', async () => {
    const files = { 'kizen.json': MANIFEST, 'a.js': 'a\n' };
    const seen: string[] = [];
    const realGit = resolveGit();
    const wrapper = join(workDir, 'git-wrapper');

    await write(
      workDir,
      'git-wrapper',
      [
        '#!/bin/sh',
        `pwd >> "${join(workDir, 'seen')}"`,
        'case " $* " in *" merge "*) echo "merge exploded" >&2; exit 2;; esac',
        `exec "${realGit}" "$@"`,
        '',
      ].join('\n'),
    );
    await chmod(wrapper, 0o755);

    const ok = await plan(files, { ...files, 'a.js': 'a live\n' }, files);

    expect(ok.status).toBe('ready');
    expect(await readdir(workspaces)).toStrictEqual([]);

    const failing = planMerge(
      {
        pluginDir,
        base: { version: '3', zip: zipOf(files) },
        live: { version: '4', zip: zipOf({ ...files, 'a.js': 'a live\n' }) },
      },
      deps({ findGit: () => wrapper }),
    );

    await expect(failing).rejects.toBeInstanceOf(MergeGitError);
    await expect(failing).rejects.toThrow(/merge exploded/);

    for (const line of (await readFile(join(workDir, 'seen'), 'utf8')).split('\n')) {
      if (line.includes('appbuilder-merge-')) {
        seen.push(line);
      }
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(await readdir(workspaces)).toStrictEqual([]);
  });

  it('the throwaway repo lives in the temp dir by default, outside the plugin dir', async () => {
    const files = { 'kizen.json': MANIFEST, 'a.js': 'a\n' };

    await writeAll(pluginDir, files);

    const result = await planMerge(
      {
        pluginDir,
        base: { version: '3', zip: zipOf(files) },
        live: { version: '4', zip: zipOf({ ...files, 'a.js': 'a live\n' }) },
      },
      { git: NO_GIT },
    );

    expect(result.status).toBe('ready');
    await expect(
      planMerge(
        {
          pluginDir,
          base: { version: '3', zip: zipOf(files) },
          live: { version: '4', zip: zipOf(files) },
        },
        { git: NO_GIT, tmpDir: join(pluginDir, 'tmp') },
      ),
    ).rejects.toThrow(/must not be inside the plugin folder/);
  });

  it('no_base when base is null', async () => {
    const findGit = vi.fn(() => resolveGit());
    const result = await planMerge(
      { pluginDir, base: null, live: { version: '4', zip: zipOf({ 'kizen.json': MANIFEST }) } },
      deps({ findGit }),
    );

    expect(result).toStrictEqual({ status: 'no_base' });
    expect(findGit).not.toHaveBeenCalled();
    expect(await applyMerge(result)).toStrictEqual({ status: 'no_base' });
    expect(await readdir(pluginDir)).toStrictEqual([]);
  });

  it("git_unavailable when git can't be resolved", async () => {
    await write(pluginDir, 'kizen.json', MANIFEST);

    const before = await snapshot(pluginDir);
    const result = await planMerge(
      {
        pluginDir,
        base: { version: '3', zip: zipOf({ 'kizen.json': MANIFEST }) },
        live: { version: '4', zip: zipOf({ 'kizen.json': MANIFEST, 'a.js': 'a\n' }) },
      },
      deps({ findGit: () => undefined }),
    );

    expect(result).toStrictEqual({
      status: 'git_unavailable',
      reason: "git isn't installed or isn't on PATH.",
    });
    expect(await applyMerge(result)).toStrictEqual(result);
    expect(await snapshot(pluginDir)).toStrictEqual(before);
  });

  it('git_unavailable when git is older than 2.24', async () => {
    const old = join(workDir, 'old-git');

    await write(workDir, 'old-git', '#!/bin/sh\necho "git version 2.20.1"\n');
    await chmod(old, 0o755);
    await write(pluginDir, 'kizen.json', MANIFEST);

    const result = await planMerge(
      {
        pluginDir,
        base: { version: '3', zip: zipOf({ 'kizen.json': MANIFEST }) },
        live: { version: '4', zip: zipOf({ 'kizen.json': MANIFEST, 'a.js': 'a\n' }) },
      },
      deps({ findGit: () => old }),
    );

    expect(result).toStrictEqual({
      status: 'git_unavailable',
      reason: 'git 2.20 is older than 2.24, which merging needs.',
    });
  });

  it("merge works when the plugin dir is itself inside the developer's git repo and leaves that repo's index and HEAD untouched", async () => {
    const repo = join(workDir, 'repo');
    const plugin = join(repo, 'apps', 'plugin');
    const base = { 'kizen.json': MANIFEST, 'a.js': text(LINES), 'old.js': 'old\n' };

    await writeAll(repo, { 'README.md': 'repo\n' });
    await writeAll(plugin, base);
    await isolatedGit(['init', '-q'], repo);
    await isolatedGit(['add', '-A'], repo);
    await isolatedGit(['commit', '-q', '-m', 'init'], repo);
    await write(plugin, 'a.js', edit(11, 'local 12'));
    await write(plugin, 'staged.js', 'staged\n');
    await isolatedGit(['add', 'apps/plugin/staged.js'], repo);

    const headBefore = await isolatedGit(['rev-parse', 'HEAD'], repo);
    const indexBefore = await readFile(join(repo, '.git', 'index'));
    const statusBefore = await isolatedGit(['status', '--porcelain'], repo);
    const branchesBefore = await isolatedGit(['branch', '--list'], repo);
    const result = ready(
      await planMerge(
        {
          pluginDir: plugin,
          base: { version: '3', zip: zipOf(base) },
          live: {
            version: '4',
            zip: zipOf({ 'kizen.json': MANIFEST, 'a.js': edit(0, 'live 1'), 'new.js': 'new\n' }),
          },
        },
        deps({ git: isolatedGit }),
      ),
    );

    expect(result).toMatchObject({ written: ['a.js', 'new.js'], deleted: ['old.js'] });
    expect(await readFile(join(repo, '.git', 'index'))).toStrictEqual(indexBefore);

    await applyMerge(result, { git: isolatedGit });

    expect(await readFile(join(plugin, 'a.js'), 'utf8')).toBe(
      text(LINES.map((line, at) => (at === 0 ? 'live 1' : at === 11 ? 'local 12' : line))),
    );
    expect(await isolatedGit(['rev-parse', 'HEAD'], repo)).toBe(headBefore);
    expect(await readFile(join(repo, '.git', 'index'))).toStrictEqual(indexBefore);
    expect(await isolatedGit(['branch', '--list'], repo)).toBe(branchesBefore);
    expect(statusBefore.split('\n').filter(Boolean).sort()).toStrictEqual([
      ' M apps/plugin/a.js',
      'A  apps/plugin/staged.js',
    ]);
    expect(
      (await isolatedGit(['status', '--porcelain'], repo)).split('\n').filter(Boolean).sort(),
    ).toStrictEqual([
      ' D apps/plugin/old.js',
      ' M apps/plugin/a.js',
      '?? apps/plugin/new.js',
      'A  apps/plugin/staged.js',
    ]);
  });
});
