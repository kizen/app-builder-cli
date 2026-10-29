import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_STATE_RELATIVE_PATH,
  AppStateChangedError,
  AppStateUnreadableError,
  emptyAppStateDoc,
  findAppStateEntry,
  readAppState,
  updateAppStateEntries,
  upsertAppStateEntry,
  writeAppState,
  type AppStateDoc,
  type AppStateEntry,
  type AppStateKey,
} from './appState.js';

const KEY: AppStateKey = {
  environment: 'staging',
  businessId: 'biz',
  baseApiName: 'acme',
  userId: 'u1',
};

const entry = (overrides: Partial<AppStateEntry> = {}): AppStateEntry => ({
  ...KEY,
  folderBaseLiveVersion: '3',
  folderBaseSourcePackageId: 'src-v3',
  lastPushedSourceHash: 'hash',
  ...overrides,
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'appbuilder-state-'));
});

afterEach(async () => {
  await chmod(join(dir, APP_STATE_RELATIVE_PATH), 0o644).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const statePath = (): string => join(dir, APP_STATE_RELATIVE_PATH);

const writeRaw = async (text: string): Promise<void> => {
  await mkdir(join(dir, '.kizenapp'), { recursive: true });
  await writeFile(statePath(), text);
};

describe('app state', () => {
  it('reads a missing file as empty, with no notice', async () => {
    expect(await readAppState(dir)).toStrictEqual({ doc: emptyAppStateDoc() });
  });

  it('state is keyed per environment, business, app and user', () => {
    const variants: [keyof AppStateKey, string][] = [
      ['environment', 'go'],
      ['businessId', 'other-biz'],
      ['baseApiName', 'other_app'],
      ['userId', 'u2'],
    ];
    const others = variants.map(([field, value]) =>
      entry({ [field]: value, folderBaseLiveVersion: field }),
    );
    let doc: AppStateDoc = { ...emptyAppStateDoc(), entries: [...others] };

    expect(findAppStateEntry(doc, KEY)).toStrictEqual({ status: 'missing' });

    for (const [field, value] of variants) {
      expect(findAppStateEntry(doc, { ...KEY, [field]: value })).toStrictEqual({
        status: 'found',
        entry: entry({ [field]: value, folderBaseLiveVersion: field }),
      });
    }

    doc = upsertAppStateEntry(doc, entry({ folderBaseLiveVersion: '7' }));
    doc = upsertAppStateEntry(doc, entry({ folderBaseLiveVersion: '8' }));

    expect(doc.entries).toStrictEqual([...others, entry({ folderBaseLiveVersion: '8' })]);
  });

  it('round-trips entries and keeps unknown keys, top-level and per entry', async () => {
    await writeRaw(
      JSON.stringify({
        schema: 2,
        extra: { a: 1 },
        apps: [entry({ future: 'x' }), { unrelated: true }],
      }),
    );

    const { doc, notice } = await readAppState(dir);

    expect(notice).toBeUndefined();

    const found = findAppStateEntry(doc, KEY);

    expect(found).toStrictEqual({ status: 'found', entry: entry({ future: 'x' }) });

    if (found.status !== 'found') {
      return;
    }

    await writeAppState(
      dir,
      upsertAppStateEntry(doc, { ...found.entry, folderBaseLiveVersion: '4' }),
    );

    expect(JSON.parse(await readFile(statePath(), 'utf8'))).toStrictEqual({
      schema: 2,
      extra: { a: 1 },
      apps: [{ unrelated: true }, entry({ future: 'x', folderBaseLiveVersion: '4' })],
    });
  });

  it('a folder base version without its source package, or a package without one, is malformed', () => {
    const lookup = (fields: Record<string, unknown>): ReturnType<typeof findAppStateEntry> =>
      findAppStateEntry(
        { ...emptyAppStateDoc(), entries: [{ ...KEY, lastPushedSourceHash: null, ...fields }] },
        KEY,
      );

    expect(lookup({ folderBaseLiveVersion: '3' })).toStrictEqual({ status: 'malformed' });
    expect(lookup({ folderBaseLiveVersion: '3', folderBaseSourcePackageId: '' })).toStrictEqual({
      status: 'malformed',
    });
    expect(lookup({ folderBaseLiveVersion: null, folderBaseSourcePackageId: 'x' })).toStrictEqual({
      status: 'malformed',
    });
    expect(lookup({ folderBaseSourcePackageId: 'x' })).toStrictEqual({ status: 'malformed' });
    expect(lookup({ folderBaseLiveVersion: null }).status).toBe('found');
    expect(lookup({}).status).toBe('found');
    expect(lookup({ folderBaseLiveVersion: '3', folderBaseSourcePackageId: 'src-v3' }).status).toBe(
      'found',
    );
  });

  it('corrupt state file is treated as empty with a notice and never crashes', async () => {
    for (const text of ['{ not json', '[]', '"x"', JSON.stringify({ apps: 'nope' })]) {
      await writeRaw(text);

      const read = await readAppState(dir);

      expect(read.doc).toMatchObject({ rest: {}, entries: [], corrupt: true });
      expect(read.notice).toContain('.kizenapp/apps.json');
      expect(read.notice).toContain('so it was ignored');

      // The next write moves the corrupt file aside instead of destroying it.
      await writeAppState(dir, upsertAppStateEntry(read.doc, entry()));

      expect(await readFile(`${statePath()}.corrupt`, 'utf8')).toBe(text);
      expect(findAppStateEntry((await readAppState(dir)).doc, KEY).status).toBe('found');
    }
  });

  it('an unreadable state file is never written over', async () => {
    const original = JSON.stringify({ apps: [entry({ userId: 'someone-else' })] });

    await writeRaw(original);
    await chmod(statePath(), 0o000);

    const read = await readAppState(dir);

    expect(read.doc).toMatchObject({ entries: [], unreadable: true });
    expect(read.notice).toContain("Couldn't read .kizenapp/apps.json");

    await expect(writeAppState(dir, upsertAppStateEntry(read.doc, entry()))).rejects.toThrow(
      AppStateUnreadableError,
    );

    await chmod(statePath(), 0o644);

    expect(await readFile(statePath(), 'utf8')).toBe(original);
  });

  it('a malformed entry for the key is reported as malformed, not used', () => {
    const doc = {
      ...emptyAppStateDoc(),
      entries: [{ ...entry(), folderBaseLiveVersion: 3 }],
    };

    expect(findAppStateEntry(doc, KEY)).toStrictEqual({ status: 'malformed' });
    expect(upsertAppStateEntry(doc, entry()).entries).toStrictEqual([entry()]);
  });

  it('a write refuses to replace a file that changed since it was read', async () => {
    await writeAppState(dir, emptyAppStateDoc());

    const first = await readAppState(dir);
    const second = await readAppState(dir);

    await writeAppState(dir, upsertAppStateEntry(first.doc, entry({ userId: 'a' })));

    await expect(
      writeAppState(dir, upsertAppStateEntry(second.doc, entry({ userId: 'b' }))),
    ).rejects.toThrow(AppStateChangedError);

    // The first run's entry survived; re-reading and writing again keeps both.
    const fresh = await readAppState(dir);

    await writeAppState(dir, upsertAppStateEntry(fresh.doc, entry({ userId: 'b' })));

    const { doc } = await readAppState(dir);

    expect(findAppStateEntry(doc, { ...KEY, userId: 'a' }).status).toBe('found');
    expect(findAppStateEntry(doc, { ...KEY, userId: 'b' }).status).toBe('found');
    expect(await readdir(join(dir, '.kizenapp'))).toStrictEqual(['apps.json']);
  });

  it('a write from a missing-file read refuses once another run created the file', async () => {
    const empty = await readAppState(dir);

    await writeAppState(dir, upsertAppStateEntry(empty.doc, entry({ userId: 'a' })));

    await expect(
      writeAppState(dir, upsertAppStateEntry(empty.doc, entry({ userId: 'b' }))),
    ).rejects.toThrow(AppStateChangedError);
  });

  it('state writes are atomic', async () => {
    // A large document, so a non-atomic write (truncate, then write) is observable mid-way.
    const big: AppStateDoc = {
      ...emptyAppStateDoc(),
      entries: Array.from({ length: 3000 }, (_, index) =>
        entry({ userId: `user-${String(index)}`, padding: 'x'.repeat(64) }),
      ),
    };
    const notices: string[] = [];
    const control = { writing: true };

    const reader = (async () => {
      while (control.writing) {
        const read = await readAppState(dir);

        if (read.notice !== undefined) {
          notices.push(read.notice);
        }
      }
    })();

    for (let round = 0; round < 20; round += 1) {
      const { doc } = await readAppState(dir);

      await writeAppState(dir, { ...big, fingerprint: doc.fingerprint ?? null });
    }

    control.writing = false;
    await reader;

    expect(notices).toStrictEqual([]);
    expect(await readdir(join(dir, '.kizenapp'))).toStrictEqual(['apps.json']);
  });

  it('a failed write leaves the previous file intact and no temp file behind', async () => {
    await writeAppState(dir, upsertAppStateEntry(emptyAppStateDoc(), entry()));

    const before = await readFile(statePath(), 'utf8');
    const { doc } = await readAppState(dir);
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    await expect(writeAppState(dir, { ...doc, rest: { cyclic } })).rejects.toThrow();
    expect(await readFile(statePath(), 'utf8')).toBe(before);
    expect(await readdir(join(dir, '.kizenapp'))).toStrictEqual(['apps.json']);
  });
});

describe('updateAppStateEntries', () => {
  const APP = { environment: 'staging', businessId: 'biz', baseApiName: 'acme' };
  const clear = (recorded: AppStateEntry): AppStateEntry =>
    Object.fromEntries(
      Object.entries(recorded).filter(
        ([key]) => key !== 'folderBaseLiveVersion' && key !== 'folderBaseSourcePackageId',
      ),
    ) as AppStateEntry;

  it("updates every user's entry for the app; keeps the rest as read", () => {
    const second = entry({ userId: 'u2', folderBaseLiveVersion: '2' });
    const malformed = { ...KEY, userId: 'u3', lastPushedSourceHash: 7 };
    const otherApp = entry({ baseApiName: 'other' });
    const otherBusiness = entry({ businessId: 'biz-2' });
    const doc: AppStateDoc = {
      ...emptyAppStateDoc(),
      entries: [entry(), second, malformed, otherApp, otherBusiness, 'junk'],
    };
    const updated = updateAppStateEntries(doc, APP, clear);

    expect(updated?.entries).toStrictEqual([
      clear(entry()),
      clear(second),
      malformed,
      otherApp,
      otherBusiness,
      'junk',
    ]);
    // The same objects, untouched.
    expect(updated?.entries[3]).toBe(otherApp);
    expect(updated?.entries[4]).toBe(otherBusiness);
  });

  it('is null when nothing changes, so nothing is written', () => {
    const doc: AppStateDoc = {
      ...emptyAppStateDoc(),
      entries: [clear(entry()), entry({ baseApiName: 'other' })],
    };

    expect(updateAppStateEntries(doc, APP, clear)).toBeNull();
    expect(updateAppStateEntries(emptyAppStateDoc(), APP, clear)).toBeNull();
  });
});
