import { describe, expect, it, vi } from 'vitest';
import {
  applyPreviewDelete,
  DELETES_APP_WARNING,
  loadAppContext,
  NO_PREVIEW_TO_DELETE_MESSAGE,
  NOT_YOUR_PREVIEW_WARNING,
  NOW_DELETES_APP_MESSAGE,
  planPreviewDelete,
  PREVIEW_IN_USE_WARNING,
  PREVIEW_PUSHED_MESSAGE,
  type AppContext,
  type AppDeps,
  type AppPreviewDeletePlan,
} from './appFlow.js';
import {
  runAppPreviewDeleteHeadless,
  UNPINNED_PREVIEW_NOTICE,
  type AppPreviewDeleteOptions,
} from './appHeadless.js';
import { createProgram } from '../program.js';
import { takeInteractiveFlag } from './interactive.js';
import type { Environment } from './credentials.js';
import type { KizenClient } from './kizenTypes.js';
import {
  API_KEY,
  BIZ,
  JSON_ARGS,
  KEY,
  makeHarness,
  makeServer,
  NOW,
  OTHER,
  stateEntry,
  USER,
  yourPreview,
  type Harness,
  type HarnessOptions,
  type ServerOptions,
} from '../test/appHarness.js';

type Extra = Record<string, unknown>;

const THIRD = 'user-3';

const remove = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppPreviewDeleteHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

async function runArgv(h: Harness, argv: unknown): Promise<void> {
  if (!Array.isArray(argv) || argv[0] !== 'appbuilder') {
    throw new Error(`not an appbuilder argv: ${JSON.stringify(argv)}`);
  }

  const program = createProgram();
  const app = program.commands.find((command) => command.name() === 'app');
  const remove = app?.commands
    .find((command) => command.name() === 'preview')
    ?.commands.find((command) => command.name() === 'delete');
  let parsed: (AppPreviewDeleteOptions & { interactive?: boolean }) | undefined;

  if (remove === undefined) {
    throw new Error('app preview delete is not registered');
  }

  remove.action((options: AppPreviewDeleteOptions & { interactive?: boolean }) => {
    parsed = options;
  });
  program.parse((argv as string[]).slice(1), { from: 'user' });

  if (parsed === undefined) {
    throw new Error('the argv did not reach app preview delete');
  }

  h.reset();
  await runAppPreviewDeleteHeadless(takeInteractiveFlag(parsed).options, h.deps);
}

const bosPreview = (): ReturnType<typeof yourPreview> =>
  yourPreview({ ownerName: 'Bo B', updated: '2026-10-21T00:00:00.000Z' });

const harness = (server: ServerOptions = {}, options: HarnessOptions = {}): Harness =>
  makeHarness({
    server: makeServer({ live: '3', previews: { [USER]: yourPreview() }, ...server }),
    state: [stateEntry()],
    ...options,
  });

const sessionDeps = (environment: Environment = 'staging'): Partial<AppDeps> => ({
  oauth: {
    listSessions: vi.fn(() => Promise.resolve([environment])),
    listAccounts: vi.fn(() => Promise.resolve([])),
    connect: vi.fn(() =>
      Promise.resolve({
        identity: {
          userId: USER,
          businessId: BIZ,
          businessName: undefined,
          fullName: undefined,
          email: undefined,
        },
        client: { fakeUser: USER } as unknown as KizenClient,
      }),
    ),
  },
});

const PINNED = ['--env', 'staging', '--business', BIZ, '--user', USER, '--json'];

const contextOf = async (h: Harness): Promise<AppContext> => {
  const context = await loadAppContext(
    {
      credentials: { environment: 'staging', businessId: BIZ, userId: USER },
      client: { fakeUser: USER } as unknown as KizenClient,
      baseApiName: 'acme',
    },
    h.deps,
  );

  if (!context.ok) {
    throw new Error(context.message);
  }

  return context.value;
};

const planOf = async (
  h: Harness,
  owner?: string,
): Promise<{ context: AppContext; plan: AppPreviewDeletePlan }> => {
  const context = await contextOf(h);
  const planned = planPreviewDelete(context, owner === undefined ? {} : { owner });

  if (!planned.ok) {
    throw new Error(planned.message);
  }

  return { context, plan: planned.value };
};

describe('app preview delete', () => {
  it('preview delete is a dry run without --yes and pins the account and owner in applyArgv', async () => {
    for (const extra of [{}, { yes: true, dryRun: true }]) {
      const h = harness({}, { deps: sessionDeps() });

      await remove(h, { credentials: undefined, profile: undefined, ...extra });

      const result = h.json();

      expect(result).toStrictEqual({
        ok: true,
        applied: false,
        dryRun: true,
        reason: 'yes' in extra ? 'flag' : 'no_yes',
        action: 'preview delete',
        environment: 'staging',
        businessId: BIZ,
        userId: USER,
        app: { baseApiName: 'acme', apiName: 'acme_abc123', name: 'Acme', liveVersion: '3' },
        owner: { id: USER, fullName: 'Ada L', yours: true },
        preview: {
          updated: '2026-10-20T00:00:00.000Z',
          activeUsersCount: 1,
          installedCount: 1,
          otherActiveUsersCount: 0,
        },
        deletesApp: false,
        notices: [],
        warnings: [],
        applyArgv: [
          'appbuilder',
          'app',
          'preview',
          'delete',
          '--owner',
          USER,
          '--expect-updated',
          '2026-10-20T00:00:00.000Z',
          '--yes',
          ...PINNED,
        ],
        requiresProductionConsent: false,
        next: [],
      });
      expect(h.server.writes()).toStrictEqual([]);
      expect(h.store.writes).toBe(0);
      expect(h.exitCodes).toStrictEqual([]);
    }

    const noted = harness();

    await remove(noted);
    expect(noted.stderr.join('')).toContain('Dry run only: pass --yes to write.');
  });

  it("preview delete removes only your preview and clears this folder's preview state but keeps its base", async () => {
    const otherFolderKey = { ...KEY, userId: OTHER };
    const h = harness(
      { previews: { [USER]: yourPreview(), [OTHER]: bosPreview() } },
      {
        state: [
          stateEntry({ previewRestoredFrom: '2', conflictedPaths: ['src/a.js'], extra: 'kept' }),
          stateEntry({ userId: OTHER, previewSourcePackageId: 'src-bo' }),
        ],
      },
    );

    await remove(h, { yes: true });

    const result = h.json();

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      dryRun: false,
      action: 'preview delete',
      owner: { id: USER, yours: true },
      deletesApp: false,
      status: 'deleted',
      appDeleted: false,
      remembered: true,
      warnings: [],
      next: [{ step: 'push', argv: ['appbuilder', 'app', 'push', ...JSON_ARGS] }],
    });
    expect(h.server.writes()).toStrictEqual([`deletePreview:${USER}`]);
    expect([...h.server.state.previews.keys()]).toStrictEqual([OTHER]);
    expect(h.server.state.exists).toBe(true);

    const entry = h.entry();

    expect(entry).toStrictEqual({
      ...KEY,
      folderBaseLiveVersion: '3',
      folderBaseSourcePackageId: 'src-v3',
      lastPushedSourceHash: null,
      conflictedPaths: ['src/a.js'],
      extra: 'kept',
    });
    expect(h.entry(otherFolderKey)).toStrictEqual(
      stateEntry({ userId: OTHER, previewSourcePackageId: 'src-bo' }),
    );
    expect(h.text()).toContain('✓ Deleted your preview of Acme');
  });

  it("preview delete of another developer's preview needs --owner and warns, and leaves state alone", async () => {
    const server: ServerOptions = {
      previews: { [OTHER]: bosPreview() },
      active: { [OTHER]: OTHER, [THIRD]: OTHER },
    };

    const yours = harness(server);

    await remove(yours, { yes: true });
    expect(yours.json()).toStrictEqual({
      ok: false,
      code: 'not_found',
      message: NO_PREVIEW_TO_DELETE_MESSAGE('acme', USER, true),
      hint: `Previews of acme: Bo B (${OTHER}). Pass one of these user ids to --owner.`,
    });
    expect(yours.server.writes()).toStrictEqual([]);

    const dry = harness(server);

    await remove(dry, { owner: OTHER });

    const plan = dry.json();

    expect(plan).toMatchObject({
      dryRun: true,
      owner: { id: OTHER, fullName: 'Bo B', yours: false },
      preview: { activeUsersCount: 2, installedCount: 2, otherActiveUsersCount: 2 },
      deletesApp: false,
      warnings: [NOT_YOUR_PREVIEW_WARNING('Bo B'), PREVIEW_IN_USE_WARNING(2, false)],
    });
    expect(plan.warnings).toStrictEqual([
      "This is Bo B's preview, not yours.",
      '2 other users are using this preview. Deleting it switches them to their own preview, or Live, and notifies them.',
    ]);
    expect(plan.applyArgv).toStrictEqual([
      'appbuilder',
      'app',
      'preview',
      'delete',
      '--owner',
      OTHER,
      '--expect-updated',
      '2026-10-21T00:00:00.000Z',
      '--yes',
      ...JSON_ARGS,
    ]);

    const h = harness(server);
    const before = structuredClone(h.store.doc);

    await remove(h, { owner: OTHER, yes: true });

    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      owner: { id: OTHER, yours: false },
      status: 'deleted',
      appDeleted: false,
      remembered: true,
      next: [],
    });
    expect(h.server.writes()).toStrictEqual([`deletePreview:${OTHER}`]);
    expect(h.server.state.previews.size).toBe(0);
    expect(h.server.state.active.get(THIRD)).toBeNull();
    expect(h.store.writes).toBe(0);
    expect(h.store.doc).toStrictEqual(before);
    expect(h.entry()).toStrictEqual(stateEntry());
    expect(h.text()).toContain("✓ Deleted Bo B's preview of Acme");
  });

  it('preview delete warns that it deletes the app when the app has no releases, and reports appDeleted', async () => {
    const only = { live: null, previews: { [USER]: yourPreview() } } satisfies ServerOptions;
    const dry = harness(only);

    await remove(dry);

    const plan = dry.json();

    expect(plan).toMatchObject({ dryRun: true, deletesApp: true });
    expect(plan.warnings).toStrictEqual([DELETES_APP_WARNING('Acme')]);
    expect(plan.warnings).toStrictEqual([
      'This preview is the only version of Acme, so deleting it deletes the whole app from this business, with its settings and secrets.',
    ]);

    expect(plan.applyArgv).toContain('--delete-app');

    const h = harness(only);

    await remove(h, { yes: true, deleteApp: true });

    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      deletesApp: true,
      status: 'deleted',
      appDeleted: true,
    });
    expect(h.server.state.exists).toBe(false);
    expect(h.server.calls).toStrictEqual([
      'listApps',
      'listApps',
      `deletePreview:${USER}`,
      'listApps',
    ]);
    expect(h.text()).toContain('Acme had no other version, so it was deleted from this business.');

    const shared = harness({
      live: null,
      previews: { [USER]: yourPreview(), [OTHER]: bosPreview() },
    });

    await remove(shared, { yes: true });

    const kept = shared.json();

    expect(kept).toMatchObject({ deletesApp: false, appDeleted: false, warnings: [] });
    expect(shared.server.state.exists).toBe(true);

    const unread = harness(only);
    const listApps = unread.server.api.listApps.getMockImplementation();

    if (listApps === undefined) {
      throw new Error('no listApps');
    }

    unread.server.api.listApps.mockImplementation((search) =>
      unread.server.api.listApps.mock.calls.length === 3
        ? Promise.reject(new Error('socket hang up'))
        : listApps(search),
    );

    await remove(unread, { yes: true, deleteApp: true });

    expect(unread.server.writes()).toStrictEqual([`deletePreview:${USER}`]);

    expect(unread.json()).toMatchObject({
      ok: true,
      status: 'deleted',
      appDeleted: null,
      warnings: [
        DELETES_APP_WARNING('Acme'),
        "The preview was deleted, but whether the app still exists couldn't be checked: socket hang up",
      ],
    });
  });

  it("preview delete that deletes the app clears the folder's recorded bases", async () => {
    const recorded = (): ReturnType<typeof stateEntry> =>
      stateEntry({
        lastPushedSourceHash: 'hash-pushed',
        conflictedPaths: ['src/a.js'],
        extra: 'kept',
      });
    const forgotten = {
      ...KEY,
      lastPushedSourceHash: null,
      conflictedPaths: ['src/a.js'],
      extra: 'kept',
    };

    const h = harness({ live: null }, { state: [recorded()] });

    await remove(h, { yes: true, deleteApp: true });

    expect(h.json()).toMatchObject({ ok: true, appDeleted: true, remembered: true });
    expect(h.server.state.exists).toBe(false);
    expect(h.entry()).toStrictEqual(forgotten);

    const theirs = harness(
      { live: null, previews: { [OTHER]: bosPreview() } },
      {
        state: [recorded()],
      },
    );

    await remove(theirs, { yes: true, deleteApp: true, owner: OTHER });

    expect(theirs.json()).toMatchObject({ ok: true, appDeleted: true, remembered: true });
    expect(theirs.entry()).toStrictEqual(forgotten);

    const unread = harness({ live: null }, { state: [recorded()] });
    const listApps = unread.server.api.listApps.getMockImplementation();

    if (listApps === undefined) {
      throw new Error('no listApps');
    }

    unread.server.api.listApps.mockImplementation((search) =>
      unread.server.api.listApps.mock.calls.length === 3
        ? Promise.reject(new Error('socket hang up'))
        : listApps(search),
    );
    await remove(unread, { yes: true, deleteApp: true });

    expect(unread.json()).toMatchObject({ ok: true, appDeleted: null });
    expect(unread.entry()).toMatchObject({ folderBaseLiveVersion: '3' });
  });

  it("preview delete that deletes the app clears every user's recorded bases for that app", async () => {
    const OTHER_KEY = { ...KEY, userId: OTHER };
    const OTHER_APP_KEY = { ...KEY, baseApiName: 'other_app' };
    const othersEntry = (): ReturnType<typeof stateEntry> =>
      stateEntry({
        userId: OTHER,
        previewSourcePackageId: 'src-bo',
        lastPushedSourceHash: 'hash-bo',
        conflictedPaths: ['src/b.js'],
        extra: 'kept',
      });
    const otherAppEntry = (): ReturnType<typeof stateEntry> =>
      stateEntry({ baseApiName: 'other_app', lastPushedSourceHash: 'hash-other-app' });
    const stored = (h: Harness, key: typeof KEY): string | undefined =>
      JSON.stringify(
        h.store.doc.entries.find(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            Object.entries(key).every(
              ([field, value]) => (entry as Record<string, unknown>)[field] === value,
            ),
        ),
      );

    for (const [name, state] of [
      ['the caller has an entry', [stateEntry(), othersEntry(), otherAppEntry()]],
      ['the caller has no entry', [othersEntry(), otherAppEntry()]],
    ] as const) {
      const h = harness({ live: null }, { state: [...state] });
      const otherAppBefore = stored(h, OTHER_APP_KEY);

      await remove(h, { yes: true, deleteApp: true });

      expect(h.json(), name).toMatchObject({ ok: true, appDeleted: true, remembered: true });
      expect(h.entry(OTHER_KEY), name).toStrictEqual({
        ...OTHER_KEY,
        lastPushedSourceHash: null,
        conflictedPaths: ['src/b.js'],
        extra: 'kept',
      });
      expect(h.entry(), name).toStrictEqual(
        name === 'the caller has an entry' ? { ...KEY, lastPushedSourceHash: null } : undefined,
      );
      expect(stored(h, OTHER_APP_KEY), name).toBe(otherAppBefore);
      expect(h.store.writes, name).toBe(1);
    }
  });

  it('preview delete that leaves the app keeps the folder base', async () => {
    const h = harness(
      { live: null, previews: { [USER]: yourPreview(), [OTHER]: bosPreview() } },
      {
        state: [
          (() => {
            const entry = stateEntry({
              folderBaseLiveVersion: null,
              lastPushedSourceHash: 'hash-pushed',
            });

            delete entry.folderBaseSourcePackageId;

            return entry;
          })(),
        ],
      },
    );

    await remove(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, appDeleted: false });
    expect(h.server.state.exists).toBe(true);
    expect(h.entry()).toStrictEqual({
      ...KEY,
      folderBaseLiveVersion: null,
      lastPushedSourceHash: 'hash-pushed',
    });
  });

  it('preview delete re-checks right before deleting', async () => {
    const gone = harness();
    const goneRun = await planOf(gone);

    gone.server.state.previews.delete(USER);

    expect(await applyPreviewDelete(goneRun.context, goneRun.plan, gone.deps)).toMatchObject({
      ok: false,
      code: 'not_found',
      message: 'Your preview of acme no longer exists, so nothing was deleted.',
    });
    expect(gone.server.api.deletePreview).not.toHaveBeenCalled();

    const pushed = harness();
    const pushedRun = await planOf(pushed);
    const preview = pushed.server.state.previews.get(USER);

    if (preview === undefined) {
      throw new Error('no preview');
    }

    preview.updated = NOW;

    expect(await applyPreviewDelete(pushedRun.context, pushedRun.plan, pushed.deps)).toMatchObject({
      ok: false,
      code: 'preview_changed',
    });
    expect(pushed.server.api.deletePreview).not.toHaveBeenCalled();

    const last = harness({
      live: null,
      previews: { [USER]: yourPreview(), [OTHER]: bosPreview() },
    });
    const lastRun = await planOf(last);

    expect(lastRun.plan.deletesApp).toBe(false);
    last.server.state.previews.delete(OTHER);

    expect(await applyPreviewDelete(lastRun.context, lastRun.plan, last.deps)).toStrictEqual({
      ok: false,
      code: 'preview_changed',
      message: NOW_DELETES_APP_MESSAGE(lastRun.plan.owner),
    });
    expect(last.server.api.deletePreview).not.toHaveBeenCalled();
    expect(last.server.state.exists).toBe(true);

    const control = harness();
    const controlRun = await planOf(control);

    expect(
      await applyPreviewDelete(controlRun.context, controlRun.plan, control.deps),
    ).toMatchObject({ ok: true });
    expect(control.server.writes()).toStrictEqual([`deletePreview:${USER}`]);

    const headless = harness();
    const listApps = headless.server.api.listApps.getMockImplementation();

    if (listApps === undefined) {
      throw new Error('no listApps');
    }

    headless.server.api.listApps.mockImplementationOnce(async (search) => {
      const rows = await listApps(search);
      const own = headless.server.state.previews.get(USER);

      if (own !== undefined) {
        own.updated = NOW;
      }

      return rows;
    });

    await remove(headless, { yes: true });

    expect(headless.json()).toMatchObject({
      ok: false,
      code: 'preview_changed',
      next: [
        {
          step: 'preview delete',
          argv: ['appbuilder', 'app', 'preview', 'delete', '--owner', USER, ...JSON_ARGS],
        },
      ],
    });
    expect(headless.exitCodes).toStrictEqual([1]);
    expect(headless.server.writes()).toStrictEqual([]);
    expect(headless.store.writes).toBe(0);
  });

  it('preview delete needs --allow-production on go and fmo', async () => {
    for (const environment of ['go', 'fmo'] as const) {
      const onProduction = (): Harness =>
        harness({}, { credentials: { environment }, state: [stateEntry({ environment })] });

      const refused = onProduction();

      await remove(refused, { yes: true });

      expect(refused.json()).toMatchObject({ ok: false, code: 'production_requires_flag' });
      expect(refused.server.writes()).toStrictEqual([]);

      const dry = onProduction();

      await remove(dry);

      expect(dry.json()).toMatchObject({ dryRun: true, requiresProductionConsent: true });
      expect(dry.json().applyArgv).toContain('--allow-production');

      const allowed = onProduction();

      await remove(allowed, { yes: true, allowProduction: true });

      expect(allowed.json()).toMatchObject({ ok: true, applied: true, status: 'deleted' });
      expect(allowed.server.writes()).toStrictEqual([`deletePreview:${USER}`]);
    }
  });

  it('preview delete with no such preview is not_found', async () => {
    const cases: [string, Harness, Extra, string][] = [
      [
        'an app not on this business',
        harness({ exists: false, previews: {} }),
        {},
        "acme isn't published to this business yet, so it has no preview to delete.",
      ],
      [
        'no preview of yours',
        harness({ previews: {} }),
        {},
        NO_PREVIEW_TO_DELETE_MESSAGE('acme', USER, true),
      ],
      [
        'no preview of that owner',
        harness(),
        { owner: OTHER },
        NO_PREVIEW_TO_DELETE_MESSAGE('acme', OTHER, false),
      ],
      [
        'a name instead of an id',
        harness({ previews: { [USER]: yourPreview(), [OTHER]: bosPreview() } }),
        { owner: 'Bo B' },
        NO_PREVIEW_TO_DELETE_MESSAGE('acme', 'Bo B', false),
      ],
    ];

    for (const [name, h, extra, message] of cases) {
      await remove(h, { yes: true, ...extra });

      expect(h.json(), name).toMatchObject({ ok: false, code: 'not_found', message });
      expect(h.exitCodes, name).toStrictEqual([1]);
      expect(h.server.writes(), name).toStrictEqual([]);
      expect(h.store.writes, name).toBe(0);
    }

    const blank = harness();

    await remove(blank, { owner: ' ', yes: true });
    expect(blank.json()).toMatchObject({ ok: false, code: 'usage_error' });
    expect(blank.server.writes()).toStrictEqual([]);
  });

  it('preview delete with invalid credentials fails before any request', async () => {
    const missingEnv = harness({}, { environmentSource: 'missing' });

    await remove(missingEnv, { yes: true, allowProduction: true });

    expect(missingEnv.json()).toMatchObject({ ok: false, code: 'credentials_invalid' });
    expect(missingEnv.server.calls).toStrictEqual([]);
    expect(missingEnv.mocks.businessApps).not.toHaveBeenCalled();
  });

  it('Ctrl+C before the delete starts no request', async () => {
    const before = harness();
    const beforeRun = await planOf(before);
    const planned = [...before.server.calls];

    expect(
      await applyPreviewDelete(beforeRun.context, beforeRun.plan, before.deps, {
        isAborted: () => true,
      }),
    ).toMatchObject({ ok: false, code: 'local_error', message: 'Cancelled.' });
    expect(before.server.calls).toStrictEqual(planned);

    const during = harness();
    const duringRun = await planOf(during);
    const reads = during.server.api.listApps.mock.calls.length;

    expect(
      await applyPreviewDelete(duringRun.context, duringRun.plan, during.deps, {
        isAborted: () => during.server.api.listApps.mock.calls.length > reads,
      }),
    ).toMatchObject({ ok: false, code: 'local_error', message: 'Cancelled.' });
    expect(during.server.api.deletePreview).not.toHaveBeenCalled();
    expect(during.server.writes()).toStrictEqual([]);
    expect(during.store.writes).toBe(0);
  });
  it('a headless applyArgv refuses a preview pushed again since the dry run', async () => {
    const h = harness({ previews: { [USER]: yourPreview(), [OTHER]: bosPreview() } });

    await remove(h, { owner: OTHER });

    const { applyArgv } = h.json();

    const bo = h.server.state.previews.get(OTHER);

    if (bo === undefined) {
      throw new Error('no preview');
    }

    bo.updated = NOW;
    await runArgv(h, applyArgv);

    const owner = { id: OTHER, fullName: 'Bo B', yours: false };

    expect(h.json()).toStrictEqual({
      ok: false,
      code: 'preview_changed',
      message: PREVIEW_PUSHED_MESSAGE(owner),
      next: [
        {
          step: 'preview delete',
          argv: ['appbuilder', 'app', 'preview', 'delete', '--owner', OTHER, ...JSON_ARGS],
        },
      ],
    });
    expect(PREVIEW_PUSHED_MESSAGE(owner)).toBe(
      `Bo B's preview was pushed again after this delete was reviewed, so nothing was deleted. Run \`appbuilder app preview delete --owner ${OTHER}\` to review it as it is now.`,
    );
    expect(h.exitCodes).toStrictEqual([1]);
    expect(h.server.writes()).toStrictEqual([]);
    expect(h.server.state.previews.has(OTHER)).toBe(true);

    const control = harness({ previews: { [USER]: yourPreview(), [OTHER]: bosPreview() } });

    await remove(control, { owner: OTHER });
    await runArgv(control, control.json().applyArgv);
    expect(control.json()).toMatchObject({ ok: true, status: 'deleted' });
    expect(control.server.writes()).toStrictEqual([`deletePreview:${OTHER}`]);
  });

  it('a headless applyArgv refuses to delete the app when the dry run said it stays', async () => {
    const h = harness({ live: null, previews: { [USER]: yourPreview(), [OTHER]: bosPreview() } });

    await remove(h);

    const plan = h.json();

    expect(plan).toMatchObject({ deletesApp: false, warnings: [] });

    h.server.state.previews.delete(OTHER);
    await runArgv(h, plan.applyArgv);

    const owner = { id: USER, fullName: 'Ada L', yours: true };

    expect(h.json()).toStrictEqual({
      ok: false,
      code: 'preview_changed',
      message: NOW_DELETES_APP_MESSAGE(owner),
      next: [
        {
          step: 'preview delete',
          argv: ['appbuilder', 'app', 'preview', 'delete', '--owner', USER, ...JSON_ARGS],
        },
      ],
    });
    expect(NOW_DELETES_APP_MESSAGE(owner)).toContain(
      `\`appbuilder app preview delete --owner ${USER}\``,
    );
    expect(h.server.writes()).toStrictEqual([]);
    expect(h.server.state.exists).toBe(true);
  });

  it('--delete-app is only emitted when the dry run deletes the app', async () => {
    const only = { live: null, previews: { [USER]: yourPreview() } } satisfies ServerOptions;
    const shared = {
      live: null,
      previews: { [USER]: yourPreview(), [OTHER]: bosPreview() },
    } satisfies ServerOptions;

    const deleting = harness(only);

    await remove(deleting);
    expect(deleting.json().applyArgv).toContain('--delete-app');

    for (const server of [{}, shared]) {
      const staying = harness(server);

      await remove(staying);
      expect(staying.json().applyArgv).not.toContain('--delete-app');
    }

    const unasked = harness(only);

    await remove(unasked, { yes: true });
    expect(unasked.json()).toMatchObject({
      ok: false,
      code: 'preview_changed',
      next: [
        {
          step: 'preview delete',
          argv: ['appbuilder', 'app', 'preview', 'delete', '--owner', USER, ...JSON_ARGS],
        },
      ],
    });
    expect(unasked.server.writes()).toStrictEqual([]);
    expect(unasked.server.state.exists).toBe(true);

    const survived = harness(only);

    await remove(survived);

    const { applyArgv } = survived.json();

    survived.server.state.previews.set(OTHER, bosPreview());
    await runArgv(survived, applyArgv);

    const result = survived.json();

    expect(result).toMatchObject({
      ok: true,
      status: 'deleted',
      deletesApp: false,
      appDeleted: false,
    });
    expect(result.warnings).not.toContain(DELETES_APP_WARNING('Acme'));
    expect(survived.server.state.exists).toBe(true);
  });

  it('a dry run of a preview with no last update has no applyArgv', async () => {
    const h = harness({ previews: { [USER]: yourPreview({ updated: null }) } });

    await remove(h);

    const result = h.json();

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { updated: null },
      notices: [UNPINNED_PREVIEW_NOTICE],
      next: [],
    });
    expect(result).not.toHaveProperty('applyArgv');
    expect(result).not.toHaveProperty('requiresProductionConsent');
    expect(h.stderr.join('')).toContain(UNPINNED_PREVIEW_NOTICE);
    expect(h.exitCodes).toStrictEqual([]);
    expect(h.server.writes()).toStrictEqual([]);

    const pinned = harness();

    await remove(pinned);

    const pinnedResult = pinned.json();

    expect(pinnedResult.notices).toStrictEqual([]);
    expect(pinnedResult.applyArgv).toContain('--expect-updated');
  });
});
