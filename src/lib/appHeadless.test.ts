import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginValidationError } from '@kizenapps/packager';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MergeOutcome, MergePlan } from './appMerge.js';
import {
  BASE_UNKNOWN_HINT,
  CONTINUE_PREVIEW_LABEL,
  createDefaultAppDeps,
  UNREVIEWED_RELEASE_WARNING,
  GONE_BASE_NOTICE,
  PREVIEW_BASE_NOTICE,
  PREVIEW_CHANGED_BASE_NOTICE,
  PREVIEW_SOURCE_UNREADABLE_HINT,
  PROMOTED_PREVIEW_NOTICE,
  RELEASE_UNCONFIRMED_WARNING,
  REPLACED_BASE_NOTICE,
  REPLACED_PREVIEW_WARNING,
  zipFileHashes,
} from './appFlow.js';
import { createOAuthCommandDeps } from './commandCore.js';
import {
  runAppMergeHeadless,
  runAppPublishHeadless,
  runAppPullHeadless,
  runAppPushHeadless,
  runAppRollbackHeadless,
  runAppVersionsHeadless,
} from './appHeadless.js';
import {
  AppStateChangedError,
  findAppStateEntry,
  readAppState,
  writeAppState,
  type AppStateEntry,
} from './appState.js';
import { createBusinessAppsApi, type BusinessAppsApi } from './businessApps.js';
import type { Environment } from './credentials.js';
import { KizenApiError } from './kizenClient.js';
import type { KizenClient } from './kizenTypes.js';
import { createOAuthStore, type OAuthSession } from './oauthStore.js';
import {
  readSourceLineage,
  SourceZipIgnoredDirError,
  SourceZipTooLargeError,
  unzipToDir,
} from './sourceZip.js';

import {
  CWD,
  USER,
  OTHER,
  BIZ,
  BASE,
  APP_API,
  API_KEY,
  JSON_ARGS,
  PNG,
  KEY,
  stateEntry,
  folderOnlyEntry,
  type Files,
  zipOf,
  versionFiles,
  STRIPPED_SERVICES,
  definition,
  type FakeServer,
  releasesUpTo,
  makeServer,
  deployable,
  type Harness,
  makeHarness,
  sha,
  publishedBody,
  yourPreview,
  readyPlan,
  mergedOutcome,
  conflictsOutcome,
  lineageOf,
  sourceZipOf,
  type LineageFixture,
} from '../test/appHarness.js';

type Extra = Record<string, unknown>;

const REAL_IO_TIMEOUT = 30_000;

const zipEntryNames = (bytes: Uint8Array): string[] => Object.keys(unzipSync(bytes));

const push = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppPushHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

const publish = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppPublishHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

const rollback = (h: Harness, version: string, extra: Extra = {}): Promise<void> =>
  runAppRollbackHeadless(version, { json: true, ...API_KEY, ...extra }, h.deps);

const merge = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppMergeHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

const pull = (h: Harness, version: string, extra: Extra = {}): Promise<void> =>
  runAppPullHeadless(version, { json: true, ...API_KEY, ...extra }, h.deps);

const versions = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppVersionsHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

describe('app publish: conflict check', () => {
  it("publish refuses when Live moved past the preview's base", async () => {
    const server = makeServer({ live: '4', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(server.writes()).toStrictEqual([]);
    expect(h.exitCodes).toStrictEqual([1]);

    const result = h.json();

    expect(result).toMatchObject({
      ok: false,
      code: 'publish_conflict',
      conflict: {
        conflict: true,
        reason: 'live_moved',
        baseLiveVersion: '3',
        liveVersion: '4',
        livePublishedBy: 'Grace H',
        livePublishedAt: '2026-09-13T00:00:00.000Z',
      },
      next: [{ step: 'merge', argv: ['appbuilder', 'app', 'merge', ...JSON_ARGS] }],
    });
    expect(result.message).toBe(
      'Live is v4 (published by Grace H at 2026-09-13T00:00:00.000Z), but your preview is based on v3. Publishing would overwrite the changes in between.',
    );
    expect(result.hint).toContain('appbuilder app merge');
    expect(h.store.writes).toBe(0);
  });

  it('a conflict for a preview pushed before the app had a Live version never reads "based on no Live version"', async () => {
    const server = makeServer({
      live: '1',
      previews: { [USER]: yourPreview({ lineage: lineageOf(null) }) },
    });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(server.api.promotePreview).not.toHaveBeenCalled();

    const result = h.json();

    expect(result).toMatchObject({
      ok: false,
      code: 'publish_conflict',
      conflict: { reason: 'live_moved', baseLiveVersion: null, liveVersion: '1' },
    });
    expect(result.message).toBe(
      'Live is v1 (published by Grace H at 2026-09-10T00:00:00.000Z), but your preview was pushed before the app had a Live version. Publishing would overwrite the changes in between.',
    );
    expect(result.message).not.toContain('based on no Live version');
  });

  it('publish refuses in a dry run too, so an agent learns of the conflict before --yes', async () => {
    const server = makeServer({ live: '4', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { dryRun: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'publish_conflict' });
  });

  it("publish proceeds when Live equals the preview's base", async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(h.exitCodes).toStrictEqual([]);
    expect(server.api.promotePreview).toHaveBeenCalledOnce();
    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      liveVersion: '4',
      previousLiveVersion: '3',
      conflictCheck: { conflict: false, reason: null },
    });
  });

  it('publish proceeds when the app has never been published', async () => {
    const server = makeServer({
      live: null,
      previews: { [USER]: yourPreview({ lineage: lineageOf(null) }) },
    });
    const h = makeHarness({ server });

    await publish(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, applied: true, liveVersion: '1' });
  });

  it("publish treats a preview's base ahead of Live as a conflict", async () => {
    const server = makeServer({
      live: '3',
      releases: releasesUpTo('5'),
      previews: { [USER]: yourPreview({ lineage: lineageOf('5') }) },
    });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(h.json()).toMatchObject({
      code: 'publish_conflict',
      conflict: { reason: 'base_ahead', baseLiveVersion: '5', liveVersion: '3' },
    });
  });

  it('publish compares versions as numbers, not strings', async () => {
    const server = makeServer({
      live: '10',
      previews: { [USER]: yourPreview({ lineage: lineageOf('9') }) },
    });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(h.json()).toMatchObject({
      code: 'publish_conflict',
      conflict: { reason: 'live_moved' },
    });
  });

  it('publish --force skips only the conflict check, not --yes / --allow-production', async () => {
    const setup = (environment: Environment): { server: FakeServer; h: Harness } => {
      const server = makeServer({ live: '4', previews: { [USER]: yourPreview() } });
      const h = makeHarness({
        server,
        credentials: { environment },
        state: [stateEntry({ environment })],
      });

      return { server, h };
    };

    const noYes = setup('staging');

    await publish(noYes.h, { force: true });

    expect(noYes.server.api.promotePreview).not.toHaveBeenCalled();
    expect(noYes.h.json()).toMatchObject({
      ok: true,
      applied: false,
      reason: 'no_yes',
      forced: true,
    });

    const prod = setup('go');

    await publish(prod.h, { force: true, yes: true });

    expect(prod.server.api.promotePreview).not.toHaveBeenCalled();
    expect(prod.h.json()).toMatchObject({ ok: false, code: 'production_requires_flag' });

    const all = setup('go');

    await publish(all.h, { force: true, yes: true, allowProduction: true });

    expect(all.server.api.promotePreview).toHaveBeenCalledOnce();

    const result = all.h.json();

    expect(result).toMatchObject({ ok: true, applied: true, forced: true, liveVersion: '5' });
    expect(result.warnings).toContainEqual(expect.stringContaining('because of --force'));
  });

  it('publish after merge without push refuses with publish_conflict', async () => {
    for (const mergeFlags of [{ yes: true }, { acceptLiveBase: true, yes: true }]) {
      const server = makeServer({ live: '3' });
      const h = makeHarness({
        server,
        state: [folderOnlyEntry()],
      });

      await push(h, { yes: true });

      expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '3' });

      server.release();
      server.release();
      h.mocks.planMerge.mockResolvedValue(readyPlan());
      h.mocks.applyMerge.mockResolvedValue(mergedOutcome);
      h.reset();
      await merge(h, mergeFlags);

      expect(h.json()).toMatchObject({ ok: true, applied: true });
      expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '5' });

      h.reset();
      await publish(h, { yes: true });

      expect(server.api.promotePreview).not.toHaveBeenCalled();
      expect(h.json()).toMatchObject({
        code: 'publish_conflict',
        conflict: { baseLiveVersion: '3', liveVersion: '5' },
      });
    }
  });

  it('publish re-checks Live right before promoting', async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });
    const original = server.api.listApps.getMockImplementation();

    server.api.listApps.mockImplementationOnce(async (search) => {
      const rows = await (original as BusinessAppsApi['listApps'])(search);

      server.release();

      return rows;
    });

    await publish(h, { yes: true });

    expect(server.api.listApps).toHaveBeenCalledTimes(2);
    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(h.json()).toMatchObject({ code: 'publish_conflict', conflict: { liveVersion: '4' } });
  });

  it('state is keyed per environment, business, app and user', async () => {
    const others: AppStateEntry[] = [
      stateEntry({ environment: 'go' }),
      stateEntry({ businessId: 'other-biz' }),
      stateEntry({ baseApiName: 'other_app' }),
      stateEntry({ userId: OTHER }),
    ];

    const miss = makeHarness({
      server: makeServer({ live: '3', previews: { [USER]: yourPreview() } }),
      state: others,
    });

    await publish(miss, { yes: true });

    expect(miss.json()).toMatchObject({ ok: true, liveVersion: '4' });
    expect(miss.entry()).toBeUndefined();
    expect(miss.store.doc.entries).toStrictEqual(others);

    const hit = makeHarness({
      server: makeServer({ live: '3', previews: { [USER]: yourPreview() } }),
      state: [...others, stateEntry()],
    });

    await publish(hit, { yes: true });

    expect(hit.store.doc.entries).toHaveLength(5);
    expect(hit.store.doc.entries.slice(0, 4)).toStrictEqual(others);
    expect(hit.entry()?.folderBaseLiveVersion).toBe('4');
  });

  it('corrupt state is reported and ignored, so push asks for a base', async () => {
    const h = makeHarness({
      server: makeServer({ live: '3' }),
      stateNotice: '.kizenapp/apps.json is not valid JSON, so it was ignored.',
    });

    await push(h, { yes: true });

    expect(h.stderr.join('')).toContain('.kizenapp/apps.json is not valid JSON');
    expect(h.json()).toMatchObject({ code: 'base_required' });
  });

  it('a malformed entry for this key counts as no state, with a notice', async () => {
    const malformed = { ...stateEntry(), folderBaseLiveVersion: 3 } as unknown as AppStateEntry;
    const h = makeHarness({ server: makeServer({ live: '4' }), state: [malformed] });

    await push(h, { yes: true });

    expect(h.stderr.join('')).toContain('is malformed, so it was ignored');
    expect(h.json()).toMatchObject({ code: 'base_required' });
  });
});

describe('app publish: preview checks and effects', () => {
  it('a first release whose preview is pushed again between plan and promote is not published', async () => {
    const h = makeHarness({
      server: makeServer({ live: null, previews: { [USER]: yourPreview() } }),
    });
    const getPreview = h.server.api.getPreview.getMockImplementation();
    let reads = 0;

    h.server.api.getPreview.mockImplementation((apiName, owner) => {
      reads += 1;

      if (reads === 2) {
        h.server.state.previews.set(
          USER,
          yourPreview({
            def: { ...yourPreview().def, source_filesystem_package: 'src-elsewhere' },
          }),
        );
      }

      if (getPreview === undefined) {
        throw new Error('no getPreview fake');
      }

      return getPreview(apiName, owner);
    });

    await publish(h, { yes: true });

    expect(h.json()).toMatchObject({
      ok: false,
      code: 'publish_conflict',
      conflict: { reason: 'preview_replaced' },
      next: [{ step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] }],
    });
    expect(h.server.calls.filter((call) => call.startsWith('promote'))).toStrictEqual([]);
    expect(h.exitCodes).toStrictEqual([1]);
  });

  it('publish advances the base to the new Live version', async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const h = makeHarness({
      server,
      state: [stateEntry({ lastPushedSourceHash: 'h', note: 'kept' })],
    });

    await publish(h, { yes: true });

    expect(h.entry()).toStrictEqual({
      ...KEY,
      folderBaseLiveVersion: '4',
      folderBaseSourcePackageId: 'src-preview',
      lastPushedSourceHash: 'h',
      note: 'kept',
    });
  });

  it('publish dry run promises no specific release number', async () => {
    const server = makeServer({
      live: '3',
      deleted: ['4', '5'],
      previews: { [USER]: yourPreview() },
    });
    const dry = makeHarness({ server, state: [stateEntry()] });

    await runAppPublishHeadless({ ...API_KEY }, dry.deps);

    const text = dry.stdout.join('');

    expect(text).toContain('Publish: Live becomes the next release number (at least v4)');
    expect(text).not.toContain('Live becomes v4');

    const dryJson = makeHarness({ server, state: [stateEntry()] });

    await publish(dryJson);

    const plan = dryJson.json();

    expect(plan).toMatchObject({ nextReleaseAtLeast: '4' });
    expect(plan).not.toHaveProperty('expectedLiveVersion');

    const applied = makeHarness({ server, state: [stateEntry()] });

    await runAppPublishHeadless({ ...API_KEY, yes: true }, applied.deps);

    expect(applied.stdout.join('')).toContain('✓ Published Live v6 of Acme');
  });

  it('publish never re-uploads source', async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(server.writes()).toStrictEqual([`promote:${USER}`]);
    expect(server.api.uploadFile).not.toHaveBeenCalled();
    expect(server.api.publish).not.toHaveBeenCalled();
    expect(h.mocks.packageLocalPlugin).not.toHaveBeenCalled();
  });

  it('preview owner is the authenticated user id', async () => {
    const server = makeServer({
      live: '3',
      previews: { 'u-42': yourPreview(), [OTHER]: yourPreview({ ownerName: 'Grace H' }) },
    });
    const h = makeHarness({
      server,
      credentials: { userId: 'u-42' },
      state: [stateEntry({ userId: 'u-42' })],
    });

    await publish(h, { yes: true });

    expect(server.api.getPreview).toHaveBeenCalledWith(APP_API, 'u-42');
    expect(server.api.promotePreview).toHaveBeenCalledWith(APP_API, 'u-42');
    expect(server.state.previews.has(OTHER)).toBe(true);
  });

  it('publish without a preview of yours fails with no_preview', async () => {
    const server = makeServer({ live: '3', previews: { [OTHER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(h.json()).toMatchObject({ ok: false, code: 'no_preview' });
  });

  it('publish before the app exists fails with no_preview', async () => {
    const h = makeHarness({ server: makeServer({ exists: false, live: null }) });

    await publish(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'no_preview' });
  });

  it('publish without a thumbnail on the preview fails locally before promote', async () => {
    const server = makeServer({
      live: '3',
      previews: { [USER]: yourPreview({ def: definition(undefined, 'src-preview', null) }) },
    });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(h.json()).toMatchObject({ ok: false, code: 'thumbnail_required' });
  });

  it('publish without a source package on the preview fails before promote', async () => {
    const server = makeServer({
      live: '3',
      previews: { [USER]: yourPreview({ def: definition(undefined, null) }) },
    });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(h.json()).toMatchObject({ ok: false, code: 'preview_incomplete' });
  });

  it('publish warns when this folder changed since the last push', async () => {
    const pushed = { 'kizen.json': 'pushed' };
    const changed = makeHarness({
      server: makeServer({ live: '3', previews: { [USER]: yourPreview() } }),
      files: { 'kizen.json': 'edited' },
      state: [stateEntry({ lastPushedSourceHash: await sha(pushed) })],
    });

    await publish(changed, { dryRun: true });

    expect(changed.json()).toMatchObject({
      ok: true,
      applied: false,
      warnings: [expect.stringContaining('This folder changed since your last push')],
    });

    const same = makeHarness({
      server: makeServer({ live: '3', previews: { [USER]: yourPreview() } }),
      files: pushed,
      state: [stateEntry({ lastPushedSourceHash: await sha(pushed) })],
    });

    await publish(same, { dryRun: true });

    expect(same.json()).toMatchObject({ warnings: [] });
  });
});

describe('the folder base and the app it was recorded for', () => {
  const staleEntry = (): ReturnType<typeof stateEntry> =>
    stateEntry({
      folderBaseLiveVersion: '1',
      previewSourcePackageId: 'src-gone',
      lastPushedSourceHash: 'hash-gone',
    });

  it('push to a deleted-and-absent app ignores the stale recorded base and records none', async () => {
    const absent = (): Harness =>
      makeHarness({ server: makeServer({ exists: false, live: null }), state: [staleEntry()] });

    const looked = absent();

    await versions(looked);
    expect(looked.json()).toMatchObject({
      published: false,
      base: {
        folder: { recorded: false, version: null },
        liveMoved: false,
      },
    });

    const dry = absent();

    await push(dry);
    expect(dry.json()).toMatchObject({
      dryRun: true,
      base: { version: null, source: 'never_published', liveMoved: false },
      notices: [
        "The base recorded for this folder (v1) is from a version of the app that's no longer on this business, so it's ignored.",
      ],
    });

    const h = absent();

    await push(h, { yes: true });
    expect(h.json()).toMatchObject({ ok: true, applied: true, base: { version: null } });
    expect(h.entry()).toMatchObject({
      folderBaseLiveVersion: null,
      previewSourcePackageId: 'file-1',
    });
    expect(h.entry()?.lastPushedSourceHash).not.toBe('hash-gone');

    h.server.release('Someone');
    h.reset();
    await publish(h, { yes: true });
    expect(h.json()).toMatchObject({ ok: false, code: 'publish_conflict' });
    expect(h.server.state.live).toBe('1');
  });

  it('recorded base is still honoured when the same app exists', async () => {
    const h = makeHarness({
      server: makeServer({ live: '3' }),
      state: [stateEntry({ folderBaseLiveVersion: '2' })],
    });

    await push(h);
    expect(h.json()).toMatchObject({
      dryRun: true,
      base: { version: '2', source: 'recorded', liveMoved: true },
      notices: [],
    });

    const looked = makeHarness({
      server: makeServer({ live: '3' }),
      state: [stateEntry({ folderBaseLiveVersion: '2' })],
    });

    await versions(looked);
    expect(looked.json()).toMatchObject({
      base: { folder: { recorded: true, version: '2' }, liveMoved: true },
    });
  });
});

describe('app push', () => {
  it('first push with Live and no recorded base fails with base_required and runnable choices', async () => {
    const server = makeServer({ live: '3' });
    const h = makeHarness({ server });

    await push(h, { yes: true });

    expect(h.exitCodes).toStrictEqual([2]);
    expect(server.writes()).toStrictEqual([]);
    expect(h.store.writes).toBe(0);
    expect(h.json()).toStrictEqual({
      ok: false,
      code: 'base_required',
      message:
        'No base version is recorded for this folder, and Live is v3. Merge Live into this folder, or record that it already contains Live, then push.',
      choice: 'base',
      choices: [
        {
          value: 'merge',
          label: 'Preview merging Live v3 into this folder',
          args: [],
          argv: ['appbuilder', 'app', 'merge', '--release', '3', ...JSON_ARGS],
        },
        {
          value: 'accept',
          label: 'This folder already contains Live v3',
          args: [],
          argv: [
            'appbuilder',
            'app',
            'merge',
            '--release',
            '3',
            '--accept-live-base',
            '--yes',
            ...JSON_ARGS,
          ],
        },
      ],
    });
  });

  it("each base choice's argv is a whole appbuilder command with the run's account flags", async () => {
    const expectArgv = (result: Record<string, unknown>, flags: string[]): void => {
      const choices = result.choices as { args: string[]; argv: string[] }[];

      expect(choices).toHaveLength(2);

      for (const choice of choices) {
        expect(choice.args).toStrictEqual([]);
        expect(choice.argv.slice(0, 3)).toStrictEqual(['appbuilder', 'app', 'merge']);
        expect(choice.argv.slice(-flags.length)).toStrictEqual(flags);
      }
    };

    const session = makeHarness({
      server: makeServer({ live: '3' }),
      deps: {
        oauth: {
          listSessions: vi.fn(() => Promise.resolve<Environment[]>(['staging'])),
          listAccounts: vi.fn(() =>
            Promise.resolve([
              { account: { businessId: BIZ, userId: USER }, session: undefined, current: false },
            ]),
          ),
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
      },
    });

    await runAppPushHeadless(
      { json: true, env: 'staging', business: BIZ, user: USER, yes: true },
      session.deps,
    );

    expectArgv(session.json(), ['--env', 'staging', '--business', BIZ, '--user', USER, '--json']);

    const keyFile = makeHarness({ server: makeServer({ live: '3' }) });

    await runAppPushHeadless(
      { json: true, credentials: '/home/me/creds.json', yes: true },
      keyFile.deps,
    );

    expectArgv(keyFile.json(), ['-c', '/home/me/creds.json', '--json']);

    const profile = makeHarness({ server: makeServer({ live: '3' }) });

    await push(profile, { yes: true });

    expectArgv(profile.json(), JSON_ARGS);
  });

  it('first push on a never-published app needs no base', async () => {
    const server = makeServer({ exists: false, live: null });
    const h = makeHarness({ server });

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      app: { apiName: null, liveVersion: null },
      base: { version: null, source: 'never_published' },
    });
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: null });
  });

  it('an exact match with a released version is auto-detected as the base', async () => {
    const server = makeServer({ live: '5' });
    const h = makeHarness({ server, files: versionFiles('4') });

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      base: { version: '4', source: 'detected', liveMoved: true },
      notices: [
        'No base is recorded for this folder, but its files match v4 exactly, so v4 is used as its base.',
      ],
    });
    expect(h.stderr.join('')).toContain('its files match v4 exactly');
    expect(server.calls.filter((call) => call.startsWith('getVersion'))).toStrictEqual([
      'getVersion:5',
      'getVersion:4',
    ]);
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '4' });
  });

  it('a partial match is never auto-detected', async () => {
    const partials: Files[] = [
      { ...versionFiles('4'), 'src/extra.js': 'x' },
      { ...versionFiles('4'), 'src/a.js': 'edited' },
      { 'kizen.json': versionFiles('4')['kizen.json'] ?? '' },
    ];

    for (const files of partials) {
      const server = makeServer({ live: '5' });
      const h = makeHarness({ server, files });

      await push(h, { dryRun: true });

      expect(h.json()).toMatchObject({ ok: false, code: 'base_required' });
      expect(server.writes()).toStrictEqual([]);
    }
  });

  it('base detection downloads at most five versions', async () => {
    const server = makeServer({ live: '8' });
    const h = makeHarness({ server, files: versionFiles('1') });

    await push(h, { dryRun: true });

    expect(h.json()).toMatchObject({ code: 'base_required' });
    expect(server.calls.filter((call) => call.startsWith('download'))).toHaveLength(5);
  });

  it('push records base on first push and preserves it on later pushes even if Live moved', async () => {
    const server = makeServer({ exists: false, live: null });
    const h = makeHarness({ server });

    await push(h, { yes: true });
    h.reset();
    await publish(h, { yes: true });

    expect(h.entry()?.folderBaseLiveVersion).toBe('1');

    server.release();
    h.local.files = { 'kizen.json': 'v1 plus my edits' };
    h.reset();
    await push(h, { yes: true });

    expect(h.json()).toMatchObject({
      ok: true,
      base: { version: '1', source: 'recorded', liveMoved: true },
      warnings: [expect.stringContaining('Publishing will stop on a conflict')],
    });
    expect(h.entry()).toMatchObject({
      folderBaseLiveVersion: '1',
      lastPushedSourceHash: await sha(h.local.files),
    });

    h.reset();
    await publish(h, { yes: true });

    expect(h.json()).toMatchObject({ code: 'publish_conflict' });
    expect(server.state.live).toBe('2');
  });

  it('push never publishes a release', async () => {
    const server = makeServer({ live: '3' });
    const h = makeHarness({ server, state: [stateEntry()] });

    await push(h, { yes: true });

    expect(server.api.publish).toHaveBeenCalledOnce();

    const body = publishedBody(server);

    expect(body.release).toBe(false);
    expect(body).not.toHaveProperty('version');
    expect(body.api_name).toBe(BASE);
    expect(body.source_filesystem_package).toBe('file-1');
    expect(body.thumbnail).toBe('file-2');
    const uploaded = server.state.files.get('file-1') ?? new Uint8Array();

    expect(zipFileHashes(uploaded)).toStrictEqual(zipFileHashes(zipOf(h.local.files)));
    expect(readSourceLineage(uploaded)).toStrictEqual(lineageOf('3'));
    expect(server.api.uploadFile).toHaveBeenCalledWith(PNG, {
      filename: 'thumbnail.png',
      contentType: 'image/png',
      source: 'public_image',
      isPublic: true,
    });
    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(server.state.previews.has(USER)).toBe(true);
    expect(h.json()).toMatchObject({ ok: true, applied: true, previewVersion: '0' });
  });

  it('push without a thumbnail uploads only the source and sends a null thumbnail', async () => {
    const server = makeServer({ live: '3' });
    const h = makeHarness({ server, thumbnail: null, state: [stateEntry()] });

    await push(h, { yes: true });

    expect(server.writes()).toStrictEqual(['upload:plugin_app_source_filesystem', 'publish:false']);
    expect(publishedBody(server).thumbnail).toBeNull();
  });

  it('push reports that it overwrites your existing preview', async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await push(h, { dryRun: true });

    expect(h.json()).toMatchObject({
      preview: { exists: true, updated: '2026-10-20T00:00:00.000Z' },
    });
  });

  it('push refuses while merged files still have conflict markers', async () => {
    const marked = {
      'kizen.json': '{}',
      'src/a.js': 'x\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> live\n',
    };
    const server = makeServer({ live: '3' });
    const h = makeHarness({
      server,
      files: marked,
      state: [stateEntry({ conflictedPaths: ['src/a.js', 'src/gone.js'] })],
    });

    await push(h, { yes: true });

    expect(server.writes()).toStrictEqual([]);
    expect(h.json()).toMatchObject({
      ok: false,
      code: 'unresolved_conflicts',
      message:
        'These files still have merge conflict markers: src/a.js. Resolve them. Only if the user explicitly wants to push them anyway: pass --force.',
    });

    h.reset();
    await push(h, { yes: true, force: true });

    expect(h.json()).toMatchObject({ ok: true, applied: true, conflictMarkers: ['src/a.js'] });
    expect(h.entry()?.conflictedPaths).toStrictEqual(['src/a.js']);

    h.local.files = { 'kizen.json': '{}', 'src/a.js': 'x\nmine\n' };
    h.reset();
    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, applied: true, conflictMarkers: [] });
    expect(h.entry()).not.toHaveProperty('conflictedPaths');
  });

  const pushWithIgnoreEdit = async (edit: (files: Files) => void): Promise<Harness> => {
    const h = makeHarness({
      server: makeServer({ live: '3' }),
      state: [folderOnlyEntry()],
      files: { 'kizen.json': '{"api_name":"acme"}', 'src/a.js': 'a', '.gitignore': 'x/\n' },
    });

    h.deps.ensureGitignore = vi.fn(() => {
      h.local.files['.gitignore'] = 'x/\n.kizenapp/\n';
      edit(h.local.files);

      return true;
    });

    await push(h, { yes: true });

    return h;
  };

  it('stops before any upload when files other than .gitignore changed since the plan', async () => {
    const h = await pushWithIgnoreEdit((files) => {
      files['src/a.js'] = 'edited while the confirm was open';
      files['src/new.js'] = 'new';
    });

    expect(h.json()).toStrictEqual({
      ok: false,
      code: 'local_error',
      message:
        'Files changed since this push was planned (src/a.js, src/new.js), so nothing was uploaded. Run `appbuilder app push` again to review and push them.',
    });
    expect(h.exitCodes).toStrictEqual([1]);
    expect(h.server.calls.filter((call) => call.startsWith('upload'))).toStrictEqual([]);
    expect(h.server.writes()).toStrictEqual([]);
    expect(h.store.writes).toBe(0);
  });

  it('uploads the re-zip when only .gitignore changed, and reports its source', async () => {
    const h = await pushWithIgnoreEdit(() => undefined);
    const uploaded = h.server.api.uploadFile.mock.calls.find(
      ([, opts]) => opts.source === 'plugin_app_source_filesystem',
    )?.[0];
    const result = h.json();

    expect(result).toMatchObject({ ok: true, applied: true });
    expect(uploaded).toBeDefined();
    expect(zipEntryNames(uploaded ?? new Uint8Array())).toContain('.gitignore');
    expect(zipFileHashes(uploaded ?? new Uint8Array())).toStrictEqual(
      zipFileHashes(zipOf(h.local.files)),
    );
    expect(result.source).toStrictEqual({
      files: 3,
      mode: 'git',
      bytes: zipOf(h.local.files).byteLength,
      hash: await sha(h.local.files),
    });
    expect(h.entry()?.lastPushedSourceHash).toBe(await sha(h.local.files));
  });

  it.each(['walk', 'git'] as const)(
    "a first push that adds the CLI's .gitignore entries doesn't make the next publish warn that the folder changed (%s mode)",
    async (mode) => {
      const tmp = await mkdtemp(join(tmpdir(), 'appbuilder-gitignore-'));

      try {
        const pluginDir = join(tmp, 'acme');

        await mkdir(join(pluginDir, 'src'), { recursive: true });
        await writeFile(join(pluginDir, 'kizen.json'), '{"api_name":"acme"}\n');
        await writeFile(join(pluginDir, 'src', 'a.js'), 'a\n');
        await writeFile(join(pluginDir, '.gitignore'), 'node_modules/\n');

        if (mode === 'git') {
          execFileSync('git', ['init', '-q'], {
            cwd: pluginDir,
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
          });
        }

        const real = createDefaultAppDeps(pluginDir);
        const h = makeHarness({
          server: makeServer({ live: '3' }),
          state: [folderOnlyEntry()],
          deps: {
            cwd: pluginDir,
            zipSourceDir: real.zipSourceDir,
            ensureGitignore: real.ensureGitignore,
            readTextFile: real.readTextFile,
          },
        });

        await push(h, { yes: true });

        expect(h.json()).toMatchObject({ ok: true });
        expect(await readFile(join(pluginDir, '.gitignore'), 'utf8')).toContain('.kizenapp/');

        h.reset();
        await publish(h, { dryRun: true });

        expect(h.json()).toMatchObject({ ok: true, applied: false, warnings: [] });

        const uploaded = h.server.state.files.get(
          publishedBody(h.server).source_filesystem_package,
        );

        expect(zipFileHashes(uploaded ?? new Uint8Array())).toStrictEqual(
          zipFileHashes((await real.zipSourceDir(pluginDir)).bytes),
        );
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
    REAL_IO_TIMEOUT,
  );

  it('push fails with validation_failed and makes no request when the plugin has errors', async () => {
    const issues = [{ rule: 'manifest/x', severity: 'error' as const, message: 'bad' }];
    const h = makeHarness({ packageError: new PluginValidationError(issues) });

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'validation_failed', issues });
    expect(h.server.calls).toStrictEqual([]);
  });

  it.each([new SourceZipIgnoredDirError(), new SourceZipTooLargeError('src/big.bin is too big')])(
    'push maps source zip errors to source_invalid before any upload (%s)',
    async (error) => {
      const h = makeHarness({ zipError: error });

      await push(h, { yes: true });

      expect(h.json()).toMatchObject({ ok: false, code: 'source_invalid', message: error.message });
      expect(h.server.calls).toStrictEqual([]);
    },
  );

  it('a push whose state write fails still succeeds, with a warning', async () => {
    const h = makeHarness({
      state: [stateEntry()],
      deps: { writeAppState: vi.fn(() => Promise.reject(new Error('EACCES'))) },
    });

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({
      ok: true,
      remembered: false,
      warnings: [expect.stringContaining('EACCES')],
    });
  });

  it('a state write retries once when another run changed the file', async () => {
    const h = makeHarness({ state: [stateEntry()] });

    h.mocks.writeAppState.mockImplementationOnce(() => Promise.reject(new AppStateChangedError()));

    await push(h, { yes: true });

    expect(h.mocks.writeAppState).toHaveBeenCalledTimes(2);
    expect(h.json()).toMatchObject({ ok: true, remembered: true });
    expect(h.entry()?.previewSourcePackageId).toBe('file-1');
  });
});

describe('every command', () => {
  const commands: [string, (h: Harness, extra: Extra) => Promise<void>][] = [
    ['versions', (h, extra) => versions(h, extra)],
    ['push', (h, extra) => push(h, extra)],
    ['publish', (h, extra) => publish(h, extra)],
    ['merge', (h, extra) => merge(h, extra)],
    ['rollback', (h, extra) => rollback(h, '2', extra)],
    ['pull', (h, extra) => pull(h, '2', extra)],
  ];

  it.each(commands)(
    'invalid credentials or environment fail before any upload or publish (%s)',
    async (_name, run) => {
      const missingEnv = makeHarness({
        environmentSource: 'missing',
        state: [stateEntry()],
        server: makeServer({ previews: { [USER]: yourPreview() } }),
      });

      await run(missingEnv, { yes: true, allowProduction: true, force: true });

      expect(missingEnv.json()).toMatchObject({ ok: false, code: 'credentials_invalid' });
      expect(missingEnv.server.calls).toStrictEqual([]);
      expect(missingEnv.mocks.businessApps).not.toHaveBeenCalled();
      expect(missingEnv.mocks.packageLocalPlugin).not.toHaveBeenCalled();
      expect(missingEnv.store.writes).toBe(0);

      const rejected = makeServer({ previews: { [USER]: yourPreview() } });

      rejected.api.listApps.mockRejectedValueOnce(
        new KizenApiError('auth_failed', 'GET /apps failed with 401', { status: 401 }),
      );

      const badKey = makeHarness({ server: rejected, state: [stateEntry()] });

      await run(badKey, { yes: true, allowProduction: true, force: true });

      expect(badKey.json()).toMatchObject({ ok: false, code: 'auth_failed' });
      expect(rejected.writes()).toStrictEqual([]);
      expect(badKey.store.writes).toBe(0);
    },
  );

  it.each(commands)(
    '403 surfaces the Business App Developer permission hint (%s)',
    async (_name, run) => {
      const server = makeServer();

      server.api.listApps.mockRejectedValueOnce(
        new KizenApiError('forbidden', 'GET /apps failed with 403', {
          status: 403,
          hint: 'The signed-in user needs edit access to this dashboard.',
        }),
      );

      const h = makeHarness({ server, state: [stateEntry()] });

      await run(h, { yes: true });

      expect(h.json()).toStrictEqual({
        ok: false,
        code: 'forbidden',
        message: 'GET /apps failed with 403',
        hint: 'Business Apps need the Marketplace › Business App Developer permission at the Delete/All level.',
      });
    },
  );

  it.each(commands)(
    "an environment without the Business Apps list says Business Apps aren't available there (%s)",
    async (_name, run) => {
      const requestJson = vi.fn((method: string, path: string) =>
        Promise.reject(
          new KizenApiError('not_found', `${method} ${path} failed with 404: Not found.`, {
            status: 404,
          }),
        ),
      );
      const client = { requestJson } as unknown as KizenClient;
      const h = makeHarness({
        state: [stateEntry()],
        deps: { businessApps: (_client, businessId) => createBusinessAppsApi(client, businessId) },
      });

      await run(h, { yes: true });

      expect(h.json()).toStrictEqual({
        ok: false,
        code: 'not_found',
        message: "Business Apps aren't available on this Kizen environment yet.",
        hint: 'Kizen has no Business Apps list on this environment (it answered 404). Use an environment where Business Apps are available, with --env.',
      });
      expect(h.exitCodes).toStrictEqual([1]);
      expect(requestJson.mock.calls.map(([method, path]) => `${method} ${path}`)).toStrictEqual([
        expect.stringMatching(/^GET \/external-integrations\/plugin-apps\/[^/]+\/apps\?search=/),
      ]);
      expect(h.store.writes).toBe(0);
    },
  );

  it('prints a needs_choice with re-run args when several sessions are signed in', async () => {
    const h = makeHarness({
      deps: {
        oauth: {
          listSessions: vi.fn(() => Promise.resolve<Environment[]>(['staging', 'go'])),
          listAccounts: vi.fn(() => Promise.resolve([])),
          connect: vi.fn(() => Promise.reject(new Error('unused'))),
        },
      },
    });

    await runAppRollbackHeadless('2', {}, h.deps);

    const text = h.stderr.join('');

    expect(text).toContain('appbuilder app rollback 2 --env staging');
    expect(text).toContain('appbuilder app rollback 2 --env go');
    expect(h.exitCodes).toStrictEqual([2]);
  });
});

describe('dry runs', () => {
  it.each([
    ['push', (h: Harness, extra: Extra) => push(h, extra)],
    ['publish', (h: Harness, extra: Extra) => publish(h, extra)],
    ['rollback', (h: Harness, extra: Extra) => rollback(h, '2', extra)],
    ['merge', (h: Harness, extra: Extra) => merge(h, extra)],
  ])('dry-run makes no writes (%s)', async (name, run) => {
    for (const flags of [{ dryRun: true, yes: true }, {}]) {
      const server = makeServer({
        live: '5',
        previews: { [USER]: yourPreview({ lineage: lineageOf('5') }) },
      });
      const base = name === 'merge' ? '3' : '5';
      const h = makeHarness({
        server,
        state: [stateEntry({ folderBaseLiveVersion: base })],
      });

      h.mocks.planMerge.mockResolvedValue(readyPlan());

      await run(h, flags);

      const result = h.json();

      expect(result).toMatchObject({ ok: true, applied: false, dryRun: true });
      expect(server.writes()).toStrictEqual([]);
      expect(h.store.writes).toBe(0);
      expect(h.mocks.applyMerge).not.toHaveBeenCalled();
      expect(h.mocks.writeAppState).not.toHaveBeenCalled();

      if (Object.keys(flags).length === 0) {
        expect(result.reason).toBe('no_yes');
        expect(h.stderr.join('')).toContain('Dry run only: pass --yes to write.');
      }
    }
  });
});

describe('app commands warn when managed agent skills are out of date', () => {
  const CLAUDE_STALE =
    'Claude files managed by appbuilder are out of date; run appbuilder setup-claude';
  const CODEX_STALE =
    'Codex files managed by appbuilder are out of date; run appbuilder setup-codex';

  const ready = (name: string, staleAgentFileWarnings: () => Promise<string[]>): Harness => {
    const base = name === 'merge' ? '3' : '5';
    const h = makeHarness({
      server: makeServer({
        live: '5',
        previews: { [USER]: yourPreview({ lineage: lineageOf('5') }) },
      }),
      state: [stateEntry({ folderBaseLiveVersion: base })],
      deps: { staleAgentFileWarnings: vi.fn(staleAgentFileWarnings) },
    });

    h.mocks.planMerge.mockResolvedValue(readyPlan());
    h.mocks.applyMerge.mockResolvedValue(mergedOutcome);

    return h;
  };

  const runs: [string, Extra, (h: Harness, extra: Extra) => Promise<void>][] = [
    ['versions', {}, (h, extra) => versions(h, extra)],
    ['push', {}, (h, extra) => push(h, extra)],
    ['push', { yes: true }, (h, extra) => push(h, extra)],
    ['publish', {}, (h, extra) => publish(h, extra)],
    ['publish', { yes: true }, (h, extra) => publish(h, extra)],
    ['merge', {}, (h, extra) => merge(h, extra)],
    ['merge', { yes: true }, (h, extra) => merge(h, extra)],
    ['rollback', {}, (h, extra) => rollback(h, '2', extra)],
    ['rollback', { yes: true }, (h, extra) => rollback(h, '2', extra)],
    ['pull', {}, (h, extra) => pull(h, '2', extra)],
  ];

  it.each(runs)(
    '%s %o carries both warnings and names each setup command',
    async (name, extra, run) => {
      const h = ready(name, () => Promise.resolve([CLAUDE_STALE, CODEX_STALE]));

      await run(h, extra);

      const result = h.json();

      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual(expect.arrayContaining([CLAUDE_STALE, CODEX_STALE]));
      expect(h.stderr.join('')).toContain(`Warning: ${CLAUDE_STALE}`);
      expect(h.stderr.join('')).toContain(`Warning: ${CODEX_STALE}`);
      expect(h.deps.staleAgentFileWarnings).toHaveBeenCalledWith(CWD);
      expect(h.exitCodes).toStrictEqual([]);

      if (extra.yes === true) {
        expect(result.applied).toBe(true);
      }
    },
  );

  it.each(runs)('%s %o adds nothing when the skills are current', async (name, extra, run) => {
    const h = ready(name, () => Promise.resolve([]));

    await run(h, extra);

    expect(h.json().warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining('managed by appbuilder')]),
    );
  });

  it.each(runs)('%s %o ignores a failing check and still succeeds', async (name, extra, run) => {
    const h = ready(name, () => Promise.reject(new Error('EACCES')));

    await run(h, extra);

    expect(h.json()).toMatchObject({ ok: true });
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('the default deps read the real folder', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'app-skill-'));

    try {
      await mkdir(join(pluginDir, '.agents', 'skills', 'kizen-business-apps'), { recursive: true });
      await writeFile(
        join(pluginDir, '.agents', 'skills', 'kizen-business-apps', 'SKILL.md'),
        'an older copy\n',
      );

      expect(await createDefaultAppDeps(pluginDir).staleAgentFileWarnings(pluginDir)).toStrictEqual(
        [CODEX_STALE],
      );
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
});

describe('app rollback', () => {
  it("rollback sets the preview base to current Live and overwrites only the caller's preview", async () => {
    const otherPreview = yourPreview({ ownerName: 'Grace H' });
    const server = makeServer({
      live: '5',
      previews: { [USER]: yourPreview(), [OTHER]: otherPreview },
    });
    const h = makeHarness({ server, state: [stateEntry({ lastPushedSourceHash: 'h' })] });

    await rollback(h, '2', { yes: true });

    expect(server.writes()).toStrictEqual([
      'upload:plugin_app_source_filesystem',
      'upload:public_image',
      'publish:false',
    ]);

    const body = publishedBody(server);

    expect(body.release).toBe(false);
    expect(body.source_filesystem_package).toBe('file-1');

    const restored = server.state.files.get('file-1') ?? new Uint8Array();

    expect(zipFileHashes(restored)).toStrictEqual(
      zipFileHashes(server.state.files.get('src-v2') ?? new Uint8Array()),
    );
    expect(readSourceLineage(restored)).toStrictEqual(lineageOf('5'));
    expect(body).not.toHaveProperty('version');
    expect(server.state.previews.get(OTHER)).toStrictEqual(otherPreview);
    expect(server.state.live).toBe('5');
    expect(h.entry()).toStrictEqual({
      ...KEY,
      folderBaseLiveVersion: '3',
      folderBaseSourcePackageId: 'src-v3',
      previewSourcePackageId: 'file-1',
      lastPushedSourceHash: null,
      previewRestoredFrom: '2',
    });
    expect(h.mocks.unzip).toHaveBeenCalledWith(
      server.state.files.get('src-v2'),
      '/tmp/appbuilder-version-x/source',
    );
    expect(h.mocks.packageLocalPlugin).toHaveBeenCalledWith('/tmp/appbuilder-version-x/source');
    expect(h.mocks.removeDir).toHaveBeenCalledWith('/tmp/appbuilder-version-x');

    const result = h.json();

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      version: '2',
      preview: { exists: true },
    });
    expect(result.warnings).toStrictEqual([
      'This replaces your current preview (last updated 2026-10-20T00:00:00.000Z).',
      "This folder's source isn't changed, and the next `appbuilder app push` replaces the restored preview with it. To keep working from version 2's source, publish this preview, then pull the new Live version with `appbuilder app pull`.",
    ]);
  });

  it("rollback of an app with services sends the version's full services (auth_credentials included)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'appbuilder-rollback-'));

    try {
      const server = makeServer({ live: '5' });
      const fullServices = [{ name: 'crm', auth_credentials: { client_secret: 'v2-secret' } }];

      server.state.files.set(
        'src-v2',
        zipOf({ 'kizen.json': JSON.stringify({ api_name: BASE, services: fullServices }) }),
      );

      const realDeps = createDefaultAppDeps(CWD);
      const h = makeHarness({
        server,
        state: [stateEntry()],
        deps: {
          makeTempDir: () => mkdtemp(join(tmp, 'v-')),
          removeDir: realDeps.removeDir,
          unzipToDir,
          packageLocalPlugin: async (dir) => {
            const manifest = JSON.parse(await readFile(join(dir, 'kizen.json'), 'utf8')) as {
              services: unknown[];
            };

            return { files: [], deployable: [deployable(PNG, manifest.services)], issues: [] };
          },
        },
      });

      await rollback(h, '2', { yes: true });

      expect(h.json()).toMatchObject({ ok: true, applied: true });
      expect(publishedBody(server).services).toStrictEqual(fullServices);
      expect(server.state.definitions.get('2')?.services).toStrictEqual(STRIPPED_SERVICES);
      expect(await readdir(tmp)).toStrictEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rollback fails clearly when the old version's source doesn't package", async () => {
    const issues = [{ rule: 'manifest/x', severity: 'error' as const, message: 'old rule' }];
    const h = makeHarness({
      state: [stateEntry()],
      deps: {
        packageLocalPlugin: () => Promise.reject(new PluginValidationError(issues)),
      },
    });

    await rollback(h, '2', { yes: true });

    const result = h.json();

    expect(result).toMatchObject({ ok: false, code: 'validation_failed', issues });
    expect(result.message).toMatch(
      /^Version 2's source couldn't be packaged, so it can't be restored: /,
    );
    expect(h.server.writes()).toStrictEqual([]);
    expect(h.mocks.removeDir).toHaveBeenCalledOnce();
  });

  it('publishing a restored preview needs no merge, and leaves the folder base alone', async () => {
    const server = makeServer({ live: '5', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await rollback(h, '2', { yes: true });
    h.reset();
    await publish(h, { yes: true });

    const result = h.json();

    expect(result).toMatchObject({
      ok: true,
      liveVersion: '6',
      conflictCheck: { conflict: false },
    });
    expect(result.warnings).toContainEqual(
      expect.stringContaining('restored with `appbuilder app rollback`'),
    );
    expect(server.state.definitions.get('6')?.source_filesystem_package).toBe('file-1');
    expect(result.conflictCheck).toMatchObject({ baseLiveVersion: '5' });
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '3' });
  });

  it("push after a rollback records this folder's own base, not the restored preview's", async () => {
    const server = makeServer({ live: '5', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await rollback(h, '2', { yes: true });
    h.reset();
    await push(h, { yes: true });

    expect(h.entry()).toStrictEqual({
      ...KEY,
      folderBaseLiveVersion: '3',
      folderBaseSourcePackageId: 'src-v3',
      previewSourcePackageId: 'file-3',
      lastPushedSourceHash: await sha(h.local.files),
    });

    h.reset();
    await publish(h, { yes: true });

    expect(h.json()).toMatchObject({
      code: 'publish_conflict',
      conflict: { baseLiveVersion: '3' },
    });
  });

  it('rollback to a version that does not exist fails with not_found', async () => {
    const server = makeServer({ live: '3' });
    const h = makeHarness({ server });

    await rollback(h, '9', { yes: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'not_found' });
    expect(server.writes()).toStrictEqual([]);
  });

  it.each(['0', 'abc', '1.5', '-2'])(
    'rollback rejects the version %s as a usage error',
    async (version) => {
      const h = makeHarness();

      await rollback(h, version, { yes: true });

      expect(h.json()).toMatchObject({ ok: false, code: 'usage_error' });
      expect(h.server.writes()).toStrictEqual([]);
    },
  );
});

describe('app merge', () => {
  it(
    'ignores the CLI-managed skill folders that older releases shipped, so they never conflict',
    async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'appbuilder-managed-merge-'));
      const skill = '.claude/skills/kizen-custom-block/SKILL.md';
      const codexSkill = '.agents/skills/kizen-business-apps/SKILL.md';

      try {
        const pluginDir = join(tmp, 'acme');
        const local = {
          'kizen.json': '{"api_name":"acme"}\n',
          'src/a.js': 'a3\n',
          [skill]: 'skill from the newest CLI\n',
          [codexSkill]: 'codex skill from the newest CLI\n',
          '.claude/skills/my-skill/SKILL.md': 'mine\n',
        };

        for (const [path, text] of Object.entries(local)) {
          await mkdir(join(pluginDir, dirname(path)), { recursive: true });
          await writeFile(join(pluginDir, path), text);
        }

        const server = makeServer({ live: '5' });

        server.state.files.set(
          'src-v3',
          zipOf({ 'kizen.json': local['kizen.json'], 'src/a.js': 'a3\n', [skill]: 'skill v1\n' }),
        );
        server.state.files.set(
          'src-v5',
          zipOf({
            'kizen.json': local['kizen.json'],
            'src/a.js': 'a5\n',
            [skill]: 'skill v1.5\n',
            [codexSkill]: 'codex skill v1\n',
          }),
        );

        const real = createDefaultAppDeps(pluginDir);
        const h = makeHarness({
          server,
          state: [stateEntry()],
          deps: {
            cwd: pluginDir,
            planMerge: real.planMerge,
            zipSourceDir: real.zipSourceDir,
            readTextFile: real.readTextFile,
            pathExists: real.pathExists,
          },
        });

        await merge(h, { dryRun: true });

        expect(h.json()).toMatchObject({
          ok: true,
          kind: 'merge',
          written: ['src/a.js'],
          deleted: [],
          conflicted: [],
          deletedOnLive: [],
          deletedLocally: [],
          ignoredIncoming: [],
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
    REAL_IO_TIMEOUT,
  );

  const mergeHarness = (state: AppStateEntry[] = [stateEntry()], files?: Files): Harness =>
    makeHarness({
      server: makeServer({ live: '5', previews: { [USER]: yourPreview() } }),
      state,
      ...(files === undefined ? {} : { files }),
    });

  it('merge passes the recorded base and Live sources to planMerge', async () => {
    const h = mergeHarness();

    h.mocks.planMerge.mockResolvedValue(readyPlan());

    await merge(h, { dryRun: true });

    expect(h.mocks.planMerge).toHaveBeenCalledWith({
      pluginDir: CWD,
      base: { version: '3', zip: h.server.state.files.get('src-v3') },
      live: { version: '5', zip: h.server.state.files.get('src-v5') },
    });
    expect(h.json()).toMatchObject({
      ok: true,
      applied: false,
      kind: 'merge',
      targetVersion: '5',
      baseVersion: '3',
      baseSource: 'recorded',
      conflicted: ['src/a.js'],
    });
  });

  it('merge advances the base only after a successful apply', async () => {
    const failing = mergeHarness();

    failing.mocks.planMerge.mockResolvedValue(readyPlan());
    failing.mocks.applyMerge.mockRejectedValue(new Error('The plugin folder changed'));

    await merge(failing, { yes: true });

    expect(failing.json()).toMatchObject({ ok: false, code: 'local_error' });
    expect(failing.store.writes).toBe(0);

    const ok = mergeHarness([stateEntry({ lastPushedSourceHash: 'h' })]);
    const order: string[] = [];

    ok.mocks.planMerge.mockResolvedValue(readyPlan());
    ok.mocks.applyMerge.mockImplementation(() => {
      order.push('applyMerge');

      return Promise.resolve(mergedOutcome);
    });
    ok.mocks.writeAppState.mockImplementation((_dir, doc) => {
      order.push('writeAppState');
      ok.store.doc = structuredClone(doc);

      return Promise.resolve();
    });

    await merge(ok, { yes: true });

    expect(order).toStrictEqual(['applyMerge', 'writeAppState']);
    expect(ok.entry()).toStrictEqual(
      stateEntry({
        folderBaseLiveVersion: '5',
        folderBaseSourcePackageId: 'src-v5',
        lastPushedSourceHash: 'h',
      }),
    );
  });

  it('merge with conflicts explains the markers and records the marked files', async () => {
    const h = mergeHarness();

    h.mocks.planMerge.mockResolvedValue(readyPlan());
    h.mocks.applyMerge.mockResolvedValue(conflictsOutcome);

    await runAppMergeHeadless({ ...API_KEY, yes: true }, h.deps);

    const text = h.stdout.join('');

    expect(text).toContain('Conflicted (2):\n  src/a.js\n  src/gone.js');
    expect(text).toContain(
      'the side marked <<<<<<< HEAD is your file and the side marked >>>>>>> live is Live v5',
    );
    expect(h.entry()?.conflictedPaths).toStrictEqual(['src/a.js']);
  });

  it('merge --release says v4, not Live v4', async () => {
    const h = mergeHarness();

    h.mocks.planMerge.mockResolvedValue(readyPlan({ liveVersion: '4' }));
    h.mocks.applyMerge.mockResolvedValue(conflictsOutcome);

    await runAppMergeHeadless({ ...API_KEY, release: '4', yes: true }, h.deps);

    const text = h.stdout.join('');

    expect(text).toContain('Merged v4 into this folder with conflicts.');
    expect(text).toContain('>>>>>>> live is v4.');
    expect(text).not.toContain('Live v4');
    expect(h.mocks.planMerge.mock.calls[0]?.[0].live.version).toBe('4');
    expect(h.entry()?.folderBaseLiveVersion).toBe('4');
  });

  it.each([
    ['no_base', { status: 'no_base' } as MergePlan],
    [
      'git_unavailable',
      { status: 'git_unavailable', reason: "git isn't installed or isn't on PATH." } as MergePlan,
    ],
  ])(
    'merge fallback (%s) downloads Live into .kizenapp and does not advance the base',
    async (reason, plan) => {
      const h = mergeHarness();

      h.mocks.planMerge.mockResolvedValue(plan);

      await merge(h, { yes: true });

      const dir = join(CWD, '.kizenapp', 'live-v5-20261027T120000Z');

      expect(h.mocks.unzip).toHaveBeenCalledWith(h.server.state.files.get('src-v5'), dir);
      expect(h.mocks.applyMerge).not.toHaveBeenCalled();
      expect(h.store.writes).toBe(0);
      expect(h.json()).toMatchObject({
        ok: true,
        applied: true,
        status: 'fallback',
        baseLiveVersion: '3',
        extracted: { dir },
        fallback: { reason },
        remembered: false,
      });
    },
  );

  it('merge with no recorded base and no exact match falls back with runnable --base choices', async () => {
    const h = mergeHarness([]);

    h.mocks.planMerge.mockImplementation((input) =>
      Promise.resolve(input.base === null ? { status: 'no_base' } : readyPlan()),
    );

    await merge(h, { yes: true });

    const result = h.json();

    expect(result).toMatchObject({
      status: 'fallback',
      baseSource: 'none',
      choices: [
        {
          value: 'base:4',
          args: [],
          argv: [
            'appbuilder',
            'app',
            'merge',
            '--release',
            '5',
            '--base',
            '4',
            '--yes',
            ...JSON_ARGS,
          ],
        },
        {
          value: 'base:3',
          args: [],
          argv: [
            'appbuilder',
            'app',
            'merge',
            '--release',
            '5',
            '--base',
            '3',
            '--yes',
            ...JSON_ARGS,
          ],
        },
        {
          value: 'base:2',
          args: [],
          argv: [
            'appbuilder',
            'app',
            'merge',
            '--release',
            '5',
            '--base',
            '2',
            '--yes',
            ...JSON_ARGS,
          ],
        },
        {
          value: 'base:1',
          args: [],
          argv: [
            'appbuilder',
            'app',
            'merge',
            '--release',
            '5',
            '--base',
            '1',
            '--yes',
            ...JSON_ARGS,
          ],
        },
        {
          value: 'accept',
          args: [],
          argv: [
            'appbuilder',
            'app',
            'merge',
            '--release',
            '5',
            '--accept-live-base',
            '--yes',
            ...JSON_ARGS,
          ],
        },
      ],
    });
    expect(h.stderr.join('')).toContain(
      'appbuilder app merge --release 5 --base 4 --yes --profile credentials',
    );
    expect(h.store.writes).toBe(0);
  });

  it('merge --base n performs a three-way merge from version n', async () => {
    const h = mergeHarness([]);

    h.mocks.planMerge.mockResolvedValue(readyPlan());
    h.mocks.applyMerge.mockResolvedValue(mergedOutcome);

    await merge(h, { base: '3', yes: true });

    expect(h.mocks.planMerge).toHaveBeenCalledWith({
      pluginDir: CWD,
      base: { version: '3', zip: h.server.state.files.get('src-v3') },
      live: { version: '5', zip: h.server.state.files.get('src-v5') },
    });
    expect(h.json()).toMatchObject({ status: 'merged', baseSource: 'flag', baseLiveVersion: '5' });
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '5' });
  });

  it('merge detects an exact-match base when none is recorded', async () => {
    const h = mergeHarness([], versionFiles('3'));

    h.mocks.planMerge.mockResolvedValue(readyPlan());

    await merge(h, { dryRun: true });

    expect(h.mocks.planMerge.mock.calls[0]?.[0].base?.version).toBe('3');
    expect(h.json()).toMatchObject({ baseSource: 'detected', baseVersion: '3' });
  });

  it('merge falls back when the recorded base version no longer exists', async () => {
    const h = mergeHarness();

    h.server.state.definitions.delete('3');
    h.mocks.planMerge.mockImplementation((input) =>
      Promise.resolve(input.base === null ? { status: 'no_base' } : readyPlan()),
    );

    await merge(h, { yes: true });

    expect(h.json()).toMatchObject({
      status: 'fallback',
      baseSource: 'none',
      baseLiveVersion: null,
      notices: [GONE_BASE_NOTICE('3')],
    });
  });

  it('merge --accept-live-base records the base only with --yes, without merging', async () => {
    const dry = mergeHarness();

    await merge(dry, { acceptLiveBase: true });

    expect(dry.json()).toMatchObject({
      ok: true,
      applied: false,
      kind: 'accept',
      targetVersion: '5',
    });
    expect(dry.store.writes).toBe(0);

    const h = mergeHarness();

    await merge(h, { acceptLiveBase: true, yes: true });

    expect(h.mocks.planMerge).not.toHaveBeenCalled();
    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      status: 'accepted',
      baseLiveVersion: '5',
    });
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '5' });
  });

  it('merge is a no-op when this folder is already based on Live', async () => {
    const h = mergeHarness([stateEntry({ folderBaseLiveVersion: '5' })]);

    await merge(h, { yes: true });

    expect(h.mocks.planMerge).not.toHaveBeenCalled();
    expect(h.server.calls.filter((call) => call.startsWith('download'))).toStrictEqual([]);
    expect(h.json()).toMatchObject({ ok: true, status: 'up_to_date', baseLiveVersion: '5' });
  });
});

describe('app versions', () => {
  it('versions reports an unpublished app as published: false and exits 0', async () => {
    const h = makeHarness({ server: makeServer({ exists: false, live: null }) });

    await versions(h);

    expect(h.exitCodes).toStrictEqual([]);
    expect(h.json()).toMatchObject({
      ok: true,
      published: false,
      app: { baseApiName: BASE, apiName: null, liveVersion: null },
      live: null,
      previews: [],
    });
  });

  it('versions marks your preview and warns when Live moved since your base', async () => {
    const server = makeServer({
      live: '4',
      previews: { [USER]: yourPreview(), [OTHER]: yourPreview({ ownerName: 'Grace H' }) },
    });
    const h = makeHarness({ server, state: [stateEntry()] });

    await versions(h);

    const result = h.json();

    expect(result).toMatchObject({
      published: true,
      live: { version: '4', publishedBy: 'Grace H' },
      released: [{ version: '3' }, { version: '2' }, { version: '1' }],
      yourPreview: { previewOwner: { id: USER }, yours: true },
      base: {
        folder: { recorded: true, version: '3' },
        liveMoved: true,
      },
      warnings: [
        'Live is now v4, but this folder is based on v3. Run `appbuilder app merge` before publishing.',
      ],
    });
    expect((result.previews as unknown[]).length).toBe(2);
  });

  it("versions fails when this folder's base version can't be read (other than a 404)", async () => {
    const server = makeServer({ live: '3' });

    server.api.getVersion.mockRejectedValue(
      new KizenApiError('api_error', 'GET /versions/3 failed with 500', { status: 500 }),
    );

    const h = makeHarness({ server, state: [stateEntry()] });

    await versions(h);

    expect(h.exitCodes).toStrictEqual([1]);
    expect(h.json()).toMatchObject({ ok: false, code: 'api_error' });
  });
});

describe('app pull', () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp !== undefined) {
      await rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it(
    'pull refuses an existing output dir and never writes safety-listed entries',
    async () => {
      tmp = await mkdtemp(join(tmpdir(), 'appbuilder-pull-'));

      const pluginDir = join(tmp, 'acme');
      const realDeps = createDefaultAppDeps(pluginDir);
      const server = makeServer({ live: '3' });

      server.state.files.set(
        'src-v2',
        zipOf({ 'kizen.json': '{}', 'src/a.js': 'a', '.env': 'SECRET=1', '.git/config': 'x' }),
      );
      await mkdir(pluginDir);
      await mkdir(join(tmp, 'taken'));

      const deps = {
        cwd: pluginDir,
        pathExists: realDeps.pathExists,
        unzipToDir,
        writeAppState,
      };
      const refused = makeHarness({ server, deps });

      await pull(refused, '2', { out: '../taken' });

      expect(refused.json()).toMatchObject({ ok: false, code: 'usage_error' });
      expect(server.calls.filter((call) => call.startsWith('download'))).toStrictEqual([]);
      expect(await readdir(join(tmp, 'taken'))).toStrictEqual([]);

      const h = makeHarness({ server, deps });

      await pull(h, '2');

      const dir = join(tmp, 'acme-v2');

      expect(h.json()).toMatchObject({
        ok: true,
        version: '2',
        dir,
        written: ['kizen.json', 'src/a.js'],
        skipped: expect.arrayContaining(['.env']) as unknown,
        remembered: true,
      });
      expect((await readdir(dir)).sort()).toStrictEqual(['.kizenapp', 'kizen.json', 'src']);
      expect(server.writes()).toStrictEqual([]);

      const found = findAppStateEntry((await readAppState(dir)).doc, KEY);

      expect(found).toStrictEqual({
        status: 'found',
        entry: {
          ...KEY,
          folderBaseLiveVersion: '2',
          folderBaseSourcePackageId: 'src-v2',
          lastPushedSourceHash: null,
        },
      });
    },
    REAL_IO_TIMEOUT,
  );

  it('push and publish from a pulled older version refuses with publish_conflict', async () => {
    const server = makeServer({ live: '5' });
    const h = makeHarness({ server, state: [stateEntry()] });

    await pull(h, '2');

    const dir = join('/work', 'acme-v2');
    const pulledState = h.otherDirs.get(dir);

    expect(pulledState).toBeDefined();

    const pulled = makeHarness({
      server,
      files: versionFiles('2'),
      state: (pulledState?.entries ?? []) as AppStateEntry[],
      deps: { cwd: CWD },
    });

    await push(pulled, { yes: true });

    expect(pulled.json()).toMatchObject({ ok: true, base: { version: '2', source: 'recorded' } });

    pulled.reset();
    await publish(pulled, { yes: true });

    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(pulled.json()).toMatchObject({
      code: 'publish_conflict',
      conflict: { baseLiveVersion: '2', liveVersion: '5' },
    });
  });

  it('pull warns when --out is inside the plugin folder', async () => {
    const h = makeHarness({ server: makeServer({ live: '3' }) });

    await pull(h, '2', { out: 'copy' });

    expect(h.mocks.unzip).toHaveBeenCalledWith(expect.any(Uint8Array), join(CWD, 'copy'));
    expect(h.json()).toMatchObject({
      warnings: [expect.stringContaining('is inside the plugin folder')],
    });
  });

  it('pull refuses an --out that contains the plugin folder', async () => {
    const h = makeHarness();

    await pull(h, '2', { out: '..' });

    expect(h.json()).toMatchObject({ ok: false, code: 'usage_error' });
  });
});

describe('round 3: preview identity, marker tracking, removed Live', () => {
  it("a preview replaced by another folder's push is judged by that push's own lineage, not preview_replaced", async () => {
    const server = makeServer({ live: '3' });
    const folderX = makeHarness({ server, state: [folderOnlyEntry()] });

    await push(folderX, { yes: true });

    expect(folderX.entry()).toMatchObject({ previewSourcePackageId: 'file-1' });

    const folderY = makeHarness({
      server,
      files: { 'kizen.json': 'folder Y' },
      state: [
        { ...folderOnlyEntry(), folderBaseLiveVersion: '2', folderBaseSourcePackageId: 'src-v2' },
      ],
    });

    await push(folderY, { yes: true });

    expect(publishedBody(server).source_filesystem_package).toBe('file-1');
    expect(server.state.previews.get(USER)?.def.source_filesystem_package).toBe('file-3');

    folderX.reset();
    await publish(folderX, { yes: true });

    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(server.state.live).toBe('3');
    expect(folderX.json()).toMatchObject({
      ok: false,
      code: 'publish_conflict',
      conflict: {
        reason: 'live_moved',
        baseLiveVersion: '2',
        previewSourceMatches: false,
      },
      next: [{ step: 'merge', argv: ['appbuilder', 'app', 'merge', ...JSON_ARGS] }],
    });

    folderX.reset();
    await push(folderX, { yes: true });
    folderX.reset();
    await publish(folderX, { yes: true });

    expect(folderX.json()).toMatchObject({ ok: true, liveVersion: '4' });
  });

  it("a preview restored in this folder and replaced by another folder's push on Live publishes, with a warning, and leaves this folder's base", async () => {
    const server = makeServer({ live: '5' });
    const folderX = makeHarness({ server, state: [stateEntry()] });

    await rollback(folderX, '2', { yes: true });

    expect(folderX.entry()).toMatchObject({ previewSourcePackageId: 'file-1' });

    const folderY = makeHarness({
      server,
      files: { 'kizen.json': 'unrelated' },
      state: [
        { ...folderOnlyEntry(), folderBaseLiveVersion: '5', folderBaseSourcePackageId: 'src-v5' },
      ],
    });

    await push(folderY, { yes: true });

    folderX.reset();
    await publish(folderX, { yes: true });

    expect(server.api.promotePreview).toHaveBeenCalledOnce();

    const result = folderX.json();

    expect(result).toMatchObject({
      ok: true,
      liveVersion: '6',
      conflictCheck: { conflict: false, previewSourceMatches: false },
    });
    expect(result.warnings).toStrictEqual([REPLACED_PREVIEW_WARNING]);
    expect(folderX.entry()).toMatchObject({ folderBaseLiveVersion: '3' });
  });

  it("publish re-checks the preview's identity right before promoting", async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });
    const original = server.api.getPreview.getMockImplementation();

    server.api.getPreview.mockImplementationOnce(async (apiName, owner) => {
      const current = await (original as BusinessAppsApi['getPreview'])(apiName, owner);

      server.state.previews.set(USER, yourPreview({ def: definition(undefined, 'src-elsewhere') }));

      return current;
    });

    await publish(h, { yes: true });

    expect(server.api.getPreview).toHaveBeenCalledTimes(2);
    expect(server.api.promotePreview).not.toHaveBeenCalled();
    expect(h.json()).toMatchObject({
      code: 'publish_conflict',
      conflict: { reason: 'preview_replaced' },
      next: [{ step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] }],
    });
  });

  it('publishing a preview saved from elsewhere leaves the folder base alone', async () => {
    const server = makeServer({
      live: '3',
      previews: { [USER]: yourPreview({ def: definition(undefined, 'src-elsewhere') }) },
    });
    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true });

    expect(h.json()).toMatchObject({
      ok: true,
      liveVersion: '4',
      conflictCheck: { previewSourceMatches: false },
    });
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '3' });
    expect(h.entry()).not.toHaveProperty('previewSourcePackageId');
  });

  it('a clean second merge keeps tracking files that still have markers from the first', async () => {
    const markers = 'x\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> live\n';
    const h = makeHarness({
      server: makeServer({ live: '5' }),
      files: { 'kizen.json': '{}', 'src/a.js': markers, 'src/b.js': 'resolved\n' },
      state: [
        stateEntry({ folderBaseLiveVersion: '4', conflictedPaths: ['src/a.js', 'src/b.js'] }),
      ],
    });

    h.mocks.planMerge.mockResolvedValue(readyPlan({ baseVersion: '4', conflicted: [] }));
    h.mocks.applyMerge.mockResolvedValue(mergedOutcome);

    await merge(h, { yes: true });

    const result = h.json();

    expect(result).toMatchObject({ ok: true, status: 'merged' });
    expect(result.warnings).toStrictEqual([
      'These files still have conflict markers from an earlier merge: src/a.js. Resolve them before pushing.',
    ]);
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '5', conflictedPaths: ['src/a.js'] });

    h.reset();
    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'unresolved_conflicts' });
    expect(h.server.writes()).toStrictEqual([]);
  });

  it('a conflicted merge adds its files to the ones still tracked', async () => {
    const markers = '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> live\n';
    const h = makeHarness({
      server: makeServer({ live: '5' }),
      files: { 'kizen.json': '{}', 'src/a.js': markers, 'src/c.js': markers },
      state: [stateEntry({ folderBaseLiveVersion: '4', conflictedPaths: ['src/c.js'] })],
    });

    h.mocks.planMerge.mockResolvedValue(readyPlan({ baseVersion: '4' }));
    h.mocks.applyMerge.mockResolvedValue({
      ...conflictsOutcome,
      written: ['src/a.js'],
      conflicted: ['src/a.js'],
      deletedOnLive: [],
    } as MergeOutcome);

    await merge(h, { yes: true });

    expect(h.entry()?.conflictedPaths).toStrictEqual(['src/a.js', 'src/c.js']);
  });

  it('publish with Live removed compares the preview base with the latest release', async () => {
    const removedLive = (lineage: LineageFixture = lineageOf('3')): FakeServer =>
      makeServer({
        live: null,
        releases: releasesUpTo('4'),
        previews: { [USER]: yourPreview({ lineage }) },
      });

    const behind = makeHarness({ server: removedLive(), state: [stateEntry()] });

    await publish(behind, { yes: true });

    expect(behind.server.api.promotePreview).not.toHaveBeenCalled();
    expect(behind.json()).toMatchObject({
      code: 'publish_conflict',
      message:
        "There's no Live version, and the latest release is v4, but your preview is based on v3. Publishing would overwrite the changes in between.",
      conflict: { reason: 'live_moved', liveVersion: null, comparedVersion: '4' },
    });

    const current = makeHarness({ server: removedLive(lineageOf('4')), state: [stateEntry()] });

    await publish(current, { yes: true });

    expect(current.json()).toMatchObject({ ok: true, liveVersion: '5' });

    const unknown = makeHarness({ server: removedLive(null) });

    await publish(unknown, { yes: true });

    expect(unknown.json()).toMatchObject({
      code: 'publish_conflict',
      conflict: { reason: 'base_unknown' },
    });

    const forced = makeHarness({ server: removedLive(), state: [stateEntry()] });

    await publish(forced, { yes: true, force: true });

    expect(forced.json()).toMatchObject({ ok: true, forced: true });
  });

  it('the --base choices say they need the release this folder was really copied from', async () => {
    const h = makeHarness({ server: makeServer({ live: '5' }) });

    h.mocks.planMerge.mockResolvedValue({ status: 'no_base' });

    await runAppMergeHeadless({ ...API_KEY, yes: true }, h.deps);

    const text = h.stdout.join('');

    expect(text).toContain('Use --base only with the release it was really copied from');
    expect(text).toContain(
      'Merge, if this folder was copied from v4  →  appbuilder app merge --release 5 --base 4 --yes --profile credentials',
    );
  });
});

describe('round 4: renamed conflict markers, unreadable ignore files', () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp !== undefined) {
      await chmod(join(tmp, 'acme', '.kizenignore'), 0o644).catch(() => undefined);
      await rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  const LINES = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`);
  const lines = (edit?: [number, string]): string =>
    `${LINES.map((line, index) => (index === edit?.[0] ? edit[1] : line)).join('\n')}\n`;
  const MANIFEST = '{"api_name":"acme"}\n';

  it(
    'push refuses a file with HEAD:old.js / live:new.js markers',
    async () => {
      tmp = await mkdtemp(join(tmpdir(), 'appbuilder-rename-'));

      const pluginDir = join(tmp, 'acme');

      await mkdir(join(pluginDir, 'src'), { recursive: true });
      await writeFile(join(pluginDir, 'kizen.json'), MANIFEST);
      await writeFile(join(pluginDir, 'src', 'old.js'), lines([4, 'local 5']));

      const server = makeServer({ live: '5' });

      server.state.files.set('src-v3', zipOf({ 'kizen.json': MANIFEST, 'src/old.js': lines() }));
      server.state.files.set(
        'src-v5',
        zipOf({ 'kizen.json': MANIFEST, 'src/new.js': lines([4, 'live 5']) }),
      );

      const real = createDefaultAppDeps(pluginDir);
      const h = makeHarness({
        server,
        state: [stateEntry()],
        deps: {
          cwd: pluginDir,
          planMerge: real.planMerge,
          applyMerge: real.applyMerge,
          readTextFile: real.readTextFile,
        },
      });

      await merge(h, { yes: true });

      expect(h.json()).toMatchObject({ ok: true, status: 'conflicts' });

      const merged = await readFile(join(pluginDir, 'src', 'new.js'), 'utf8');

      expect(merged).toContain('<<<<<<< HEAD:src/old.js');
      expect(merged).toContain('>>>>>>> live:src/new.js');
      expect(h.entry()?.conflictedPaths).toContain('src/new.js');

      h.reset();
      await push(h, { yes: true });

      expect(h.json()).toMatchObject({
        ok: false,
        code: 'unresolved_conflicts',
        message: expect.stringContaining('src/new.js') as unknown,
      });
      expect(server.writes()).toStrictEqual([]);
    },
    REAL_IO_TIMEOUT,
  );

  it('a later merge that renames a still-marked file keeps it tracked', async () => {
    const markers = 'x\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> live\n';
    const h = makeHarness({
      server: makeServer({ live: '5' }),
      files: { 'kizen.json': '{}', 'src/old.js': markers },
      state: [stateEntry({ folderBaseLiveVersion: '4', conflictedPaths: ['src/old.js'] })],
    });

    h.mocks.planMerge.mockResolvedValue(readyPlan({ baseVersion: '4', conflicted: [] }));
    h.mocks.applyMerge.mockImplementation(() => {
      h.local.files = { 'kizen.json': '{}', 'src/new.js': markers };

      return Promise.resolve({
        status: 'merged',
        written: ['src/new.js'],
        deleted: ['src/old.js'],
        ignoredIncoming: [],
      });
    });

    await merge(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, status: 'merged' });
    expect(h.entry()?.conflictedPaths).toStrictEqual(['src/new.js']);

    h.reset();
    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'unresolved_conflicts' });
  });

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable .kizenignore stops the zip instead of being skipped',
    async () => {
      tmp = await mkdtemp(join(tmpdir(), 'appbuilder-ignore-'));

      const pluginDir = join(tmp, 'acme');

      await mkdir(pluginDir);
      await writeFile(join(pluginDir, 'kizen.json'), MANIFEST);
      await writeFile(join(pluginDir, 'secret.txt'), 'do not upload');
      await writeFile(join(pluginDir, '.kizenignore'), 'secret.txt\n');
      await chmod(join(pluginDir, '.kizenignore'), 0o000);

      const server = makeServer({ live: '3' });
      const h = makeHarness({
        server,
        state: [stateEntry()],
        deps: { cwd: pluginDir, zipSourceDir: createDefaultAppDeps(pluginDir).zipSourceDir },
      });

      await push(h, { yes: true });

      const result = h.json();

      expect(result).toMatchObject({ ok: false, code: 'source_invalid' });
      expect(result.message).toMatch(
        /^\.kizenignore exists but couldn't be read \(EACCES\), so the files it excludes can't be left out of the source zip\. Nothing was uploaded; fix its permissions and try again\.$/,
      );
      expect(server.writes()).toStrictEqual([]);
    },
    REAL_IO_TIMEOUT,
  );
});

describe('agent contract', () => {
  const PUSH = ['appbuilder', 'app', 'push', ...JSON_ARGS];
  const PUBLISH = ['appbuilder', 'app', 'publish', ...JSON_ARGS];
  const MERGE = ['appbuilder', 'app', 'merge', ...JSON_ARGS];
  const MARKERS = { local: 'HEAD', incoming: 'live' };

  const argvsIn = (value: unknown): string[][] => {
    if (Array.isArray(value)) {
      return value.every((item) => typeof item === 'string')
        ? []
        : value.flatMap((item) => argvsIn(item));
    }

    if (typeof value !== 'object' || value === null) {
      return [];
    }

    return Object.entries(value).flatMap(([key, item]) =>
      (key === 'argv' || key === 'applyArgv') && Array.isArray(item)
        ? [item as string[]]
        : argvsIn(item),
    );
  };

  it('not signed in returns not_signed_in with a login argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appbuilder-app-oauth-'));

    try {
      const oauth = createOAuthCommandDeps(createOAuthStore(dir));
      const none = makeHarness({ deps: { oauth } });

      await runAppPushHeadless({ json: true, yes: true }, none.deps);

      expect(none.json()).toMatchObject({
        ok: false,
        code: 'not_signed_in',
        login: { argv: ['appbuilder', 'login'] },
      });
      expect(none.json().hint).toContain('`appbuilder login`');
      expect(none.exitCodes).toStrictEqual([1]);

      const staging = makeHarness({ deps: { oauth } });

      await runAppPublishHeadless({ json: true, env: 'staging' }, staging.deps);

      expect(staging.json()).toMatchObject({
        ok: false,
        code: 'not_signed_in',
        message:
          "You're not signed in to staging. Run `appbuilder login --env staging` to sign in.",
        login: { argv: ['appbuilder', 'login', '--env', 'staging'] },
      });
      expect(staging.json().hint).toContain('`appbuilder login --env staging`');
      expect(staging.exitCodes).toStrictEqual([1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a bad API-key file still returns credentials_invalid', async () => {
    const h = makeHarness({ environmentSource: 'missing' });

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'credentials_invalid' });
    expect(h.json()).not.toHaveProperty('login');
  });

  it("every choice carries a runnable argv with the run's account flags and --json", async () => {
    const saved = {
      account: { businessId: BIZ, userId: USER },
      session: { businessName: 'Acme Co' } as OAuthSession,
      current: false,
    };
    const several = makeHarness({
      deps: {
        oauth: {
          listSessions: vi.fn(() => Promise.resolve<Environment[]>([])),
          listAccounts: vi.fn((environment: Environment) =>
            Promise.resolve(environment === 'staging' || environment === 'go' ? [saved] : []),
          ),
          connect: vi.fn(() => Promise.reject(new Error('unused'))),
        },
        processEnv: { APPBUILDER_BUSINESS: 'Acme Co' },
      },
    });

    await runAppRollbackHeadless('2', { json: true, yes: true }, several.deps);

    const choices = several.json().choices as unknown[];

    expect(choices).toHaveLength(2);
    expect(choices).toStrictEqual(
      expect.arrayContaining([
        {
          value: 'staging',
          label: 'staging',
          args: ['--env', 'staging'],
          argv: [
            'appbuilder',
            'app',
            'rollback',
            '2',
            '--env',
            'staging',
            '--business',
            'Acme Co',
            '--json',
          ],
        },
        {
          value: 'go',
          label: 'go',
          args: ['--env', 'go'],
          argv: [
            'appbuilder',
            'app',
            'rollback',
            '2',
            '--env',
            'go',
            '--business',
            'Acme Co',
            '--json',
          ],
        },
      ]),
    );
    expect(several.exitCodes).toStrictEqual([2]);

    several.reset();
    await runAppRollbackHeadless('2', { yes: true }, several.deps);

    expect(several.stderr.join('')).toContain(
      "staging  →  appbuilder app rollback 2 --env staging --business 'Acme Co'",
    );

    const base = makeHarness({ server: makeServer({ live: '3' }) });

    await push(base, { yes: true });

    expect(argvsIn(base.json().choices)).toStrictEqual([
      ['appbuilder', 'app', 'merge', '--release', '3', ...JSON_ARGS],
      ['appbuilder', 'app', 'merge', '--release', '3', '--accept-live-base', '--yes', ...JSON_ARGS],
    ]);
  });

  it('needs_choice and base_required exit 2; other failures exit 1', async () => {
    const base = makeHarness({ server: makeServer({ live: '3' }) });

    await push(base, { yes: true });

    expect(base.json()).toMatchObject({ code: 'base_required' });
    expect(base.exitCodes).toStrictEqual([2]);

    const conflict = makeHarness({
      server: makeServer({ live: '4', previews: { [USER]: yourPreview() } }),
      state: [stateEntry()],
    });

    await publish(conflict, { yes: true });

    expect(conflict.json()).toMatchObject({ code: 'publish_conflict' });
    expect(conflict.exitCodes).toStrictEqual([1]);
  });

  it('merge conflicts return structured next steps with marker labels', async () => {
    const h = makeHarness({ server: makeServer({ live: '5' }), state: [stateEntry()] });

    h.mocks.planMerge.mockResolvedValue(readyPlan());
    h.mocks.applyMerge.mockResolvedValue(conflictsOutcome);

    await merge(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, status: 'conflicts' });
    expect(h.json().next).toStrictEqual([
      { step: 'resolve', files: ['src/a.js'], markers: MARKERS },
      { step: 'push', argv: PUSH },
      { step: 'publish', argv: PUBLISH },
    ]);

    const clean = makeHarness({ server: makeServer({ live: '5' }), state: [stateEntry()] });

    clean.mocks.planMerge.mockResolvedValue(readyPlan({ conflicted: [] }));
    clean.mocks.applyMerge.mockResolvedValue(mergedOutcome);

    await merge(clean, { yes: true });

    expect(clean.json()).toMatchObject({ ok: true, status: 'merged' });
    expect(clean.json().next).toStrictEqual([
      { step: 'push', argv: PUSH },
      { step: 'publish', argv: PUBLISH },
    ]);
  });

  it('unresolved_conflicts lists files', async () => {
    const h = makeHarness({
      files: {
        'kizen.json': '{}',
        'src/a.js': '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> live\n',
        'src/b.js': 'resolved\n',
      },
      state: [stateEntry({ conflictedPaths: ['src/a.js', 'src/b.js'] })],
    });

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({
      ok: false,
      code: 'unresolved_conflicts',
      files: ['src/a.js'],
    });
    expect(h.exitCodes).toStrictEqual([1]);
  });

  it('publish_conflict offers the merge argv but not --force', async () => {
    const run = async (json: boolean): Promise<Harness> => {
      const h = makeHarness({
        server: makeServer({ live: '4', previews: { [USER]: yourPreview() } }),
        state: [stateEntry()],
      });

      await runAppPublishHeadless({ ...API_KEY, json, yes: true }, h.deps);

      return h;
    };

    const h = await run(true);
    const result = h.json();

    expect(result).toMatchObject({ ok: false, code: 'publish_conflict' });
    expect(result.next).toStrictEqual([{ step: 'merge', argv: MERGE }]);
    expect(result).not.toHaveProperty('choices');
    expect(argvsIn(result).flat()).not.toContain('--force');
    expect(result.hint).toContain('--force');

    const text = await run(false);

    expect(text.stderr.join('')).toContain(
      'Next:\n  merge  →  appbuilder app merge --profile credentials\n',
    );
  });

  it('dry runs return applyArgv', async () => {
    const staging = (): Harness =>
      makeHarness({
        server: makeServer({
          live: '5',
          previews: { [USER]: yourPreview({ lineage: lineageOf('5') }) },
        }),
        state: [stateEntry({ folderBaseLiveVersion: '5' })],
      });

    const pushed = staging();

    await push(pushed, { force: true });

    expect(pushed.json()).toMatchObject({
      dryRun: true,
      applyArgv: ['appbuilder', 'app', 'push', '--force', '--yes', ...JSON_ARGS],
      requiresProductionConsent: false,
    });

    const published = staging();

    await publish(published, { dryRun: true, yes: true });

    expect(published.json()).toMatchObject({
      dryRun: true,
      reason: 'flag',
      applyArgv: [
        'appbuilder',
        'app',
        'publish',
        '--expect-preview',
        'src-preview',
        '--yes',
        ...JSON_ARGS,
      ],
      requiresProductionConsent: false,
    });

    const rolledBack = staging();

    await rollback(rolledBack, '2');

    expect(rolledBack.json()).toMatchObject({
      applyArgv: ['appbuilder', 'app', 'rollback', '2', '--yes', ...JSON_ARGS],
      requiresProductionConsent: false,
    });

    const merged = makeHarness({ server: makeServer({ live: '5' }), state: [stateEntry()] });

    merged.mocks.planMerge.mockResolvedValue(readyPlan());

    await merge(merged, { release: '4' });

    expect(merged.json()).toMatchObject({
      applyArgv: ['appbuilder', 'app', 'merge', '--release', '4', '--yes', ...JSON_ARGS],
      requiresProductionConsent: false,
    });
  });

  it('a production dry run asks for consent: applyArgv carries --allow-production', async () => {
    const h = makeHarness({
      server: makeServer({
        live: '5',
        previews: { [USER]: yourPreview({ lineage: lineageOf('5') }) },
      }),
      credentials: { environment: 'go' },
      state: [stateEntry({ environment: 'go', folderBaseLiveVersion: '5' })],
    });

    await publish(h);

    expect(h.json()).toMatchObject({
      dryRun: true,
      applyArgv: [
        'appbuilder',
        'app',
        'publish',
        '--expect-preview',
        'src-preview',
        '--yes',
        '--allow-production',
        ...JSON_ARGS,
      ],
      requiresProductionConsent: true,
    });

    const merged = makeHarness({
      server: makeServer({ live: '5' }),
      credentials: { environment: 'go' },
      state: [stateEntry({ environment: 'go' })],
    });

    merged.mocks.planMerge.mockResolvedValue(readyPlan());

    await merge(merged);

    expect(merged.json()).toMatchObject({
      applyArgv: ['appbuilder', 'app', 'merge', '--release', '5', '--yes', ...JSON_ARGS],
      requiresProductionConsent: false,
    });
  });

  it('push and publish success results name the next step', async () => {
    const h = makeHarness({
      server: makeServer({ live: '5', previews: { [USER]: yourPreview() } }),
      state: [stateEntry({ folderBaseLiveVersion: '5' })],
    });

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, applied: true });
    expect(h.json().next).toStrictEqual([{ step: 'publish', argv: PUBLISH }]);

    h.reset();
    await publish(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, applied: true, next: [] });
  });

  it('a lone ======= line in a tracked file counts as an unresolved marker', async () => {
    const h = makeHarness({
      files: { 'kizen.json': '{}', 'src/a.js': 'mine\n=======\ntheirs\n' },
      state: [stateEntry({ conflictedPaths: ['src/a.js'] })],
    });

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ code: 'unresolved_conflicts', files: ['src/a.js'] });
  });

  it('a lone ======= line outside the tracked files is ordinary text', async () => {
    const heading = 'Title\n=======\n';

    const untracked = makeHarness({
      server: makeServer({ live: '5' }),
      files: { 'kizen.json': '{}', 'README.md': heading },
      state: [stateEntry({ folderBaseLiveVersion: '5' })],
    });

    await push(untracked, { yes: true });

    expect(untracked.json()).toMatchObject({ ok: true, applied: true });

    const merged = makeHarness({
      server: makeServer({ live: '5' }),
      files: { 'kizen.json': '{}', 'README.md': heading },
      state: [stateEntry()],
    });

    merged.mocks.planMerge.mockResolvedValue(readyPlan({ conflicted: [] }));
    merged.mocks.applyMerge.mockResolvedValue({ ...mergedOutcome, written: ['README.md'] });

    await merge(merged, { yes: true });

    expect(merged.entry()).not.toHaveProperty('conflictedPaths');
    expect(merged.json().next).toStrictEqual([
      { step: 'push', argv: PUSH },
      { step: 'publish', argv: PUBLISH },
    ]);
  });

  it('network errors under a Codex network-disabled sandbox say how to escalate', async () => {
    const run = async (processEnv: Record<string, string>): Promise<Record<string, unknown>> => {
      const h = makeHarness({
        deps: {
          processEnv,
          oauth: {
            listSessions: vi.fn(() => Promise.resolve<Environment[]>(['staging'])),
            listAccounts: vi.fn(() => Promise.resolve([])),
            connect: vi.fn(() =>
              Promise.reject(new KizenApiError('network_error', "Couldn't reach Kizen: ENOTFOUND")),
            ),
          },
        },
      });

      await runAppVersionsHeadless({ json: true, env: 'staging' }, h.deps);

      expect(h.exitCodes).toStrictEqual([1]);

      return h.json();
    };

    const sandboxed = await run({ CODEX_SANDBOX_NETWORK_DISABLED: '1' });

    expect(sandboxed).toMatchObject({ code: 'network_error', sandbox: 'codex_network_disabled' });
    expect(sandboxed.hint).toContain('sandbox_permissions: "require_escalated"');
    expect(sandboxed.hint).toContain('prefix_rule: ["appbuilder"]');

    for (const env of [{}, { CODEX_COMPANION_SESSION_ID: 'x', CODEX_CI: '1' }]) {
      const plain = await run(env);

      expect(plain).toMatchObject({ code: 'network_error' });
      expect(plain).not.toHaveProperty('sandbox');
      expect(plain).not.toHaveProperty('hint');
    }
  });
});

describe('agent contract: printed commands do what the run showed', () => {
  const VALUE_FLAGS: Record<string, string> = {
    '--env': 'env',
    '--business': 'business',
    '--user': 'user',
    '--profile': 'profile',
    '-c': 'credentials',
    '--release': 'release',
    '--base': 'base',
    '--out': 'out',
    '--expect-preview': 'expectPreview',
  };
  const BOOLEAN_FLAGS: Record<string, string> = {
    '--yes': 'yes',
    '--json': 'json',
    '--dry-run': 'dryRun',
    '--force': 'force',
    '--allow-production': 'allowProduction',
    '--accept-live-base': 'acceptLiveBase',
  };

  const runArgv = async (argv: unknown, h: Harness): Promise<void> => {
    const [program, group, command, ...rest] = argv as string[];
    const options: Record<string, string | boolean> = {};
    const positional: string[] = [];

    expect([program, group]).toStrictEqual(['appbuilder', 'app']);

    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] ?? '';
      const valueKey = VALUE_FLAGS[arg];
      const booleanKey = BOOLEAN_FLAGS[arg];

      if (valueKey !== undefined) {
        index += 1;
        options[valueKey] = rest[index] ?? '';
      } else if (booleanKey !== undefined) {
        options[booleanKey] = true;
      } else if (arg.startsWith('-')) {
        throw new Error(`unknown flag ${arg}`);
      } else {
        positional.push(arg);
      }
    }

    switch (command ?? '') {
      case 'merge':
        return runAppMergeHeadless(options, h.deps);
      case 'publish':
        return runAppPublishHeadless(options, h.deps);
      case 'push':
        return runAppPushHeadless(options, h.deps);
      case 'rollback':
        return runAppRollbackHeadless(positional[0] ?? '', options, h.deps);
      default:
        throw new Error(`unexpected command ${String(command)}`);
    }
  };

  it("a merge's applyArgv records or merges the version its dry run showed, after Live moves", async () => {
    const server = makeServer({ live: '4' });
    const accept = makeHarness({ server, state: [stateEntry()] });

    await merge(accept, { acceptLiveBase: true });

    const acceptArgv = accept.json().applyArgv;

    expect(acceptArgv).toStrictEqual([
      'appbuilder',
      'app',
      'merge',
      '--release',
      '4',
      '--accept-live-base',
      '--yes',
      ...JSON_ARGS,
    ]);

    server.release();
    accept.reset();
    await runArgv(acceptArgv, accept);

    expect(accept.json()).toMatchObject({ ok: true, status: 'accepted', targetVersion: '4' });
    expect(accept.entry()?.folderBaseLiveVersion).toBe('4');

    const moving = makeServer({ live: '4' });
    const plain = makeHarness({ server: moving, state: [stateEntry()] });

    plain.mocks.planMerge.mockResolvedValue(readyPlan({ liveVersion: '4' }));
    plain.mocks.applyMerge.mockResolvedValue(mergedOutcome);
    await merge(plain);

    const plainArgv = plain.json().applyArgv;

    moving.release();
    plain.reset();
    await runArgv(plainArgv, plain);

    expect(plain.mocks.planMerge.mock.calls.map(([input]) => input.live.version)).toStrictEqual([
      '4',
      '4',
    ]);
    expect(plain.json()).toMatchObject({ ok: true, status: 'merged' });
    expect(plain.entry()?.folderBaseLiveVersion).toBe('4');
  });

  it("a merge's applyArgv keeps a base that came from --base, and replaces the run's --release", async () => {
    const h = makeHarness({ server: makeServer({ live: '5' }) });

    h.mocks.planMerge.mockResolvedValue(readyPlan());
    await merge(h, { base: '2' });

    expect(h.json().applyArgv).toStrictEqual([
      'appbuilder',
      'app',
      'merge',
      '--release',
      '5',
      '--base',
      '2',
      '--yes',
      ...JSON_ARGS,
    ]);
  });

  it('applyArgv acts as the account the dry run did, even after a switch to another', async () => {
    const OTHER = { businessId: 'biz-other', userId: 'user-other' };
    const pointer = { current: { businessId: BIZ, userId: USER } };
    const saved = [
      { account: { businessId: BIZ, userId: USER }, session: undefined, current: false },
      { account: OTHER, session: undefined, current: false },
    ];
    const connect = vi.fn(
      (_environment: Environment, account?: { businessId: string; userId: string }) => {
        const who = account ?? pointer.current;

        return Promise.resolve({
          identity: {
            ...who,
            businessName: undefined,
            fullName: undefined,
            email: undefined,
          },
          client: { fakeUser: who.userId } as unknown as KizenClient,
        });
      },
    );
    const h = makeHarness({
      server: makeServer({ live: '3', previews: { [USER]: yourPreview() } }),
      state: [stateEntry()],
      deps: {
        oauth: {
          listSessions: vi.fn(() => Promise.resolve<Environment[]>(['staging'])),
          listAccounts: vi.fn(() => Promise.resolve(saved)),
          connect,
        },
      },
    });

    await runAppPublishHeadless({ json: true }, h.deps);

    const { applyArgv } = h.json();

    expect(applyArgv).toStrictEqual([
      'appbuilder',
      'app',
      'publish',
      '--expect-preview',
      'src-preview',
      '--yes',
      '--env',
      'staging',
      '--business',
      BIZ,
      '--user',
      USER,
      '--json',
    ]);

    pointer.current = OTHER;
    h.reset();
    await runArgv(applyArgv, h);

    expect(connect).toHaveBeenLastCalledWith('staging', { businessId: BIZ, userId: USER });
    expect(h.json()).toMatchObject({ ok: true, applied: true, businessId: BIZ, userId: USER });
    expect(h.server.api.promotePreview).toHaveBeenCalledOnce();
  });

  it('publish --yes --expect-preview refuses when the preview changed since the dry run', async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const dry = makeHarness({ server, state: [stateEntry()] });

    await publish(dry);

    const { applyArgv } = dry.json();

    server.state.previews.set(
      USER,
      yourPreview({ def: { ...yourPreview().def, source_filesystem_package: 'src-elsewhere' } }),
    );

    for (const extra of [[], ['--force']]) {
      const h = makeHarness({ server, state: [stateEntry()] });

      await runArgv([...(applyArgv as string[]), ...extra], h);

      expect(h.json(), extra.join(' ')).toMatchObject({
        ok: false,
        code: 'publish_conflict',
        conflict: { reason: 'preview_replaced' },
        next: [{ step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] }],
      });
      expect(h.server.api.promotePreview).not.toHaveBeenCalled();
    }

    const first = makeServer({ live: null, previews: { [USER]: yourPreview() } });
    const firstDry = makeHarness({ server: first });

    await publish(firstDry);
    first.state.previews.set(
      USER,
      yourPreview({ def: { ...yourPreview().def, source_filesystem_package: 'src-elsewhere' } }),
    );

    const firstApply = makeHarness({ server: first });

    await runArgv(firstDry.json().applyArgv, firstApply);
    expect(firstApply.json()).toMatchObject({ code: 'publish_conflict' });
    expect(first.api.promotePreview).not.toHaveBeenCalled();
  });

  it('publish --yes --expect-preview publishes when the preview is the one the dry run showed', async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const dry = makeHarness({ server, state: [stateEntry()] });

    await publish(dry);

    const h = makeHarness({ server, state: [stateEntry()] });

    await runArgv(dry.json().applyArgv, h);

    expect(h.json()).toMatchObject({ ok: true, applied: true, liveVersion: '4' });
    expect(h.entry()?.folderBaseLiveVersion).toBe('4');
  });

  const replacedBeforePromote = (): Harness => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });

    server.release();

    const h = makeHarness({ server, state: [stateEntry()] });
    const getPreview = h.server.api.getPreview.getMockImplementation();
    let reads = 0;

    h.server.api.getPreview.mockImplementation((apiName, owner) => {
      reads += 1;

      if (reads === 2) {
        h.server.state.previews.set(
          USER,
          yourPreview({
            def: { ...yourPreview().def, source_filesystem_package: 'src-elsewhere' },
          }),
        );
      }

      if (getPreview === undefined) {
        throw new Error('no getPreview fake');
      }

      return getPreview(apiName, owner);
    });

    return h;
  };

  it('a --force publish refuses a preview replaced between plan and apply, pinned or not', async () => {
    for (const pin of [{}, { expectPreview: 'src-preview' }]) {
      const h = replacedBeforePromote();

      await runAppPublishHeadless(
        { ...API_KEY, json: true, yes: true, force: true, ...pin },
        h.deps,
      );

      expect(h.json()).toMatchObject({
        ok: false,
        code: 'publish_conflict',
        conflict: { reason: 'preview_replaced' },
        next: [{ step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] }],
      });
      expect(h.server.api.promotePreview).not.toHaveBeenCalled();
      expect(h.entry()?.folderBaseLiveVersion).toBe('3');
    }
  });

  const replacedDuringPromote = (): Harness => {
    const h = makeHarness({
      server: makeServer({ live: '3', previews: { [USER]: yourPreview() } }),
      state: [stateEntry()],
    });
    const promote = h.server.api.promotePreview.getMockImplementation();

    h.server.api.promotePreview.mockImplementation((apiName, owner) => {
      h.server.state.previews.set(
        USER,
        yourPreview({
          def: { ...yourPreview().def, source_filesystem_package: 'src-elsewhere' },
        }),
      );

      if (promote === undefined) {
        throw new Error('no promotePreview fake');
      }

      return promote(apiName, owner);
    });

    return h;
  };

  it("a preview replaced during the promote request doesn't advance the folder base", async () => {
    const control = makeHarness({
      server: makeServer({ live: '3', previews: { [USER]: yourPreview() } }),
      state: [stateEntry()],
    });

    await publish(control, { yes: true });
    expect(control.json()).toMatchObject({ ok: true, applied: true, liveVersion: '4' });
    expect(control.json().warnings).not.toContain(UNREVIEWED_RELEASE_WARNING);
    expect(control.entry()?.folderBaseLiveVersion).toBe('4');

    const h = replacedDuringPromote();

    await publish(h, { yes: true });

    const result = h.json() as { warnings: string[] };

    expect(result).toMatchObject({ ok: true, applied: true, liveVersion: '4' });
    expect(result.warnings).toContain(UNREVIEWED_RELEASE_WARNING);
    expect(h.server.calls).toContain('getVersion:4');
    expect(h.entry()?.folderBaseLiveVersion).toBe('3');
    expect(h.entry()?.previewSourcePackageId).toBeUndefined();
  });

  it("a release whose source can't be read after the promote doesn't advance the folder base", async () => {
    const h = makeHarness({
      server: makeServer({ live: '3', previews: { [USER]: yourPreview() } }),
      state: [stateEntry()],
    });
    const getVersion = h.server.api.getVersion.getMockImplementation();

    h.server.api.getVersion.mockImplementation((apiName, version) =>
      String(version) === '4'
        ? Promise.reject(new KizenApiError('network_error', 'GET /versions/4 failed', {}))
        : (getVersion?.(apiName, version) ?? Promise.reject(new Error('no getVersion fake'))),
    );

    await publish(h, { yes: true });

    const result = h.json() as { warnings: string[] };

    expect(result).toMatchObject({ ok: true, applied: true, liveVersion: '4' });
    expect(result.warnings).toContain(RELEASE_UNCONFIRMED_WARNING('4', 'GET /versions/4 failed'));
    expect(h.exitCodes).toStrictEqual([]);
    expect(h.entry()?.folderBaseLiveVersion).toBe('3');
  });

  it('every app result has next: versions points on, pull and dry runs leave it empty', async () => {
    const moved = makeHarness({ server: makeServer({ live: '5' }), state: [stateEntry()] });

    await versions(moved);

    expect(moved.json().next).toStrictEqual([
      { step: 'merge', argv: ['appbuilder', 'app', 'merge', ...JSON_ARGS] },
    ]);

    const current = makeHarness({ server: makeServer({ live: '3' }), state: [stateEntry()] });

    await versions(current);

    expect(current.json().next).toStrictEqual([
      { step: 'push', argv: ['appbuilder', 'app', 'push', ...JSON_ARGS] },
      { step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] },
    ]);

    const pulled = makeHarness({ server: makeServer({ live: '5' }), state: [stateEntry()] });

    await pull(pulled, '2');

    expect(pulled.json()).toMatchObject({ ok: true, next: [] });

    const dry = makeHarness({ server: makeServer({ live: '3' }), state: [stateEntry()] });

    await push(dry);

    expect(dry.json()).toMatchObject({ dryRun: true, next: [] });
  });
});

describe("lineage: the preview's base, read from its source on the server", () => {
  const LOCAL: Files = { 'kizen.json': '{"api_name":"acme","local":true}' };

  const DIVERGED: Files = { 'kizen.json': '{"api_name":"acme","local":true}', 'src/new.js': 'x' };

  const previewZip = (server: FakeServer): Uint8Array => {
    const id = server.state.previews.get(USER)?.def.source_filesystem_package;
    const zip = id === null || id === undefined ? undefined : server.state.files.get(id);

    if (zip === undefined) {
      throw new Error('no preview source on the server');
    }

    return zip;
  };

  const downloads = (server: FakeServer): string[] =>
    server.calls.filter((call) => call.startsWith('download:'));

  const expectLineage = (h: Harness, base: string | null): void => {
    const expected =
      base === null
        ? { baseLiveVersion: null, baseSourcePackageId: null }
        : {
            baseLiveVersion: base,
            baseSourcePackageId: h.server.state.definitions.get(base)?.source_filesystem_package,
          };

    expect(readSourceLineage(previewZip(h.server))).toStrictEqual(expected);
  };

  it("publish from a machine with no state uses the preview's server lineage and succeeds when Live hasn't moved", async () => {
    const server = makeServer({ live: '3' });
    const pushed = server.pushPreviewFrom(USER, LOCAL, lineageOf('3'));
    const h = makeHarness({ server });

    await publish(h);

    expect(h.json()).toMatchObject({
      ok: true,
      dryRun: true,
      conflictCheck: {
        conflict: false,
        reason: null,
        baseLiveVersion: '3',
        baseSourcePackageId: 'src-v3',
        comparedSourcePackageId: 'src-v3',
      },
      applyArgv: [
        'appbuilder',
        'app',
        'publish',
        '--expect-preview',
        pushed,
        '--yes',
        ...JSON_ARGS,
      ],
    });
    expect(downloads(server)).toStrictEqual([`download:${pushed}`]);

    h.reset();
    server.calls.length = 0;
    await publish(h, { yes: true, expectPreview: pushed });

    expect(h.exitCodes).toStrictEqual([]);
    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      liveVersion: '4',
      conflictCheck: { conflict: false, baseLiveVersion: '3' },
    });
    expect(downloads(server)).toStrictEqual([`download:${pushed}`]);
    expect(server.state.live).toBe('4');
  });

  it('publish from a machine with no state conflicts (live_moved) from the server lineage when Live moved', async () => {
    const server = makeServer({ live: '3' });

    server.pushPreviewFrom(USER, LOCAL, lineageOf('3'));
    server.release();

    for (const extra of [{}, { yes: true }]) {
      const h = makeHarness({ server });

      await publish(h, extra);

      expect(server.writes()).toStrictEqual([]);
      expect(h.exitCodes).toStrictEqual([1]);
      expect(h.json()).toMatchObject({
        ok: false,
        code: 'publish_conflict',
        conflict: {
          conflict: true,
          reason: 'live_moved',
          baseLiveVersion: '3',
          liveVersion: '4',
        },
        next: [{ step: 'merge', argv: ['appbuilder', 'app', 'merge', ...JSON_ARGS] }],
      });
    }

    expect(server.state.live).toBe('4');
  });

  it('a preview pushed from another machine is judged by its own lineage', async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });

    server.pushPreviewFrom(USER, DIVERGED, lineageOf('3'));
    await publish(h, { yes: true });

    const result = h.json();

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      liveVersion: '4',
      conflictCheck: {
        conflict: false,
        reason: null,
        previewSourceMatches: false,
      },
    });
    expect(result.warnings).toContain(REPLACED_PREVIEW_WARNING);
    expect(h.entry()).toMatchObject({
      folderBaseLiveVersion: '3',
      folderBaseSourcePackageId: 'src-v3',
    });

    const raced = makeServer({ live: '3' });
    const reviewed = raced.pushPreviewFrom(USER, LOCAL, lineageOf('3'));
    const racedHarness = makeHarness({ server: raced });
    const original = raced.api.getPreview.getMockImplementation();
    let reads = 0;

    raced.api.getPreview.mockImplementation(async (apiName, owner) => {
      reads += 1;

      if (reads === 2) {
        raced.pushPreviewFrom(USER, DIVERGED, lineageOf('3'));
      }

      return (original as BusinessAppsApi['getPreview'])(apiName, owner);
    });
    await publish(racedHarness, { yes: true, expectPreview: reviewed });

    expect(raced.calls.filter((call) => call.startsWith('promote'))).toStrictEqual([]);
    expect(racedHarness.json()).toMatchObject({
      ok: false,
      code: 'publish_conflict',
      conflict: { reason: 'preview_replaced' },
      next: [{ step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] }],
    });
  });

  it('recreated app: lineage base package differs from the current same-numbered version, so publish conflicts (base_replaced)', async () => {
    const server = makeServer({ live: '3' });

    server.recreate('3');
    server.pushPreviewFrom(USER, LOCAL, lineageOf('3', 'src-v3'));

    const h = makeHarness({ server });

    await publish(h, { yes: true });

    expect(server.calls.filter((call) => call.startsWith('promote'))).toStrictEqual([]);
    expect(h.exitCodes).toStrictEqual([1]);

    const result = h.json();

    expect(result).toMatchObject({
      ok: false,
      code: 'publish_conflict',
      conflict: {
        conflict: true,
        reason: 'base_replaced',
        baseLiveVersion: '3',
        comparedVersion: '3',
        baseSourcePackageId: 'src-v3',
        comparedSourcePackageId: 'src-r2-v3',
      },
      next: [{ step: 'merge', argv: ['appbuilder', 'app', 'merge', ...JSON_ARGS] }],
    });
    expect(result.message).toBe(
      "Live is v3, and your preview is based on v3, but v3 on this business isn't the version your preview was based on (the app or that version was deleted and created again). Publishing could overwrite changes your preview doesn't have.",
    );

    for (const [recreate, sourceId] of [
      [false, 'src-v3'],
      [true, 'src-r2-v3'],
    ] as const) {
      const fine = makeServer({ live: '3' });

      if (recreate) {
        fine.recreate('3');
      }

      fine.pushPreviewFrom(USER, LOCAL, lineageOf('3', sourceId));

      const ok = makeHarness({ server: fine });

      await publish(ok, { yes: true });
      expect(ok.json()).toMatchObject({
        ok: true,
        conflictCheck: { conflict: false },
      });
    }
  });

  it('a preview whose source has no lineage is a conflict whose way on is pushing this folder', async () => {
    for (const state of [[stateEntry()], []]) {
      const server = makeServer({
        live: '3',
        previews: { [USER]: yourPreview({ lineage: null }) },
      });
      const h = makeHarness({ server, state });

      await publish(h, { yes: true });

      expect(server.calls.filter((call) => call.startsWith('promote'))).toStrictEqual([]);
      expect(h.exitCodes).toStrictEqual([1]);

      const result = h.json();

      expect(result).toMatchObject({
        ok: false,
        code: 'publish_conflict',
        conflict: { conflict: true, reason: 'base_unknown', baseLiveVersion: null },
        hint: BASE_UNKNOWN_HINT,
        next: [{ step: 'push', argv: ['appbuilder', 'app', 'push', ...JSON_ARGS] }],
      });
    }

    const server = makeServer({ live: '3', previews: { [USER]: yourPreview({ lineage: null }) } });
    const h = makeHarness({ server, state: [stateEntry()] });

    await push(h, { yes: true });
    h.reset();
    await publish(h, { yes: true });
    expect(h.json()).toMatchObject({ ok: true, liveVersion: '4' });

    const forcedServer = makeServer({
      live: '3',
      previews: { [USER]: yourPreview({ lineage: null }) },
    });
    const forced = makeHarness({ server: forcedServer, state: [stateEntry()] });

    await publish(forced, { yes: true, force: true });

    const result = forced.json();

    expect(result).toMatchObject({ ok: true, forced: true, liveVersion: '4' });
    expect(result.warnings).toContainEqual(expect.stringContaining('because of --force'));

    const first = makeHarness({
      server: makeServer({ live: null, previews: { [USER]: yourPreview({ lineage: null }) } }),
    });

    await publish(first, { yes: true });
    expect(first.json()).toMatchObject({ ok: true, liveVersion: '1' });
  });

  it('lineage file is never extracted by pull, merge fallback, or rollback, and never affects content detection', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'appbuilder-lineage-'));

    try {
      const lineaged = (): FakeServer => {
        const made = makeServer({ live: '5' });

        for (const version of ['1', '2', '3', '4', '5']) {
          made.state.files.set(
            `src-v${version}`,
            sourceZipOf(versionFiles(version), lineageOf(version === '1' ? null : '1')),
          );
        }

        return made;
      };

      const server = lineaged();

      const pulled = makeHarness({ server, deps: { unzipToDir } });
      const pullDir = join(tmp, 'pulled');

      await pull(pulled, '2', { out: pullDir });
      expect(pulled.json()).toMatchObject({
        ok: true,
        written: ['kizen.json', 'src/a.js'],
        skipped: [],
      });
      expect((await readdir(pullDir)).sort()).toStrictEqual(['kizen.json', 'src']);

      const pluginDir = join(tmp, 'plugin');

      await mkdir(pluginDir);

      const merged = makeHarness({ server, deps: { cwd: pluginDir, unzipToDir } });

      merged.mocks.planMerge.mockResolvedValue({ status: 'no_base' });
      await merge(merged, { yes: true });

      const fallbackDir = join(pluginDir, '.kizenapp', 'live-v5-20261027T120000Z');

      expect(merged.json()).toMatchObject({
        status: 'fallback',
        extracted: { dir: fallbackDir, skipped: [] },
      });
      expect((await readdir(fallbackDir)).sort()).toStrictEqual(['kizen.json', 'src']);

      const extractedSeen: string[][] = [];
      const rolled = makeHarness({
        server,
        state: [stateEntry()],
        deps: {
          makeTempDir: () => mkdtemp(join(tmp, 'v-')),
          removeDir: (dir) => rm(dir, { recursive: true, force: true }),
          unzipToDir,
          packageLocalPlugin: async (dir) => {
            extractedSeen.push((await readdir(dir)).sort());

            return { files: [], deployable: [deployable()], issues: [] };
          },
        },
      });

      await rollback(rolled, '2', { yes: true });
      expect(rolled.json()).toMatchObject({ ok: true, applied: true });
      expect(extractedSeen).toStrictEqual([['kizen.json', 'src']]);

      const detected = makeHarness({ server: lineaged(), files: versionFiles('2') });

      await push(detected);
      expect(detected.json()).toMatchObject({
        ok: true,
        dryRun: true,
        base: { version: '2', source: 'detected' },
      });
      expect(zipFileHashes(server.state.files.get('src-v2') ?? new Uint8Array())).toStrictEqual(
        zipFileHashes(zipOf(versionFiles('2'))),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("every uploading path writes the preview's base as its lineage", async () => {
    const recorded = makeHarness({ server: makeServer({ live: '3' }), state: [stateEntry()] });

    await push(recorded, { yes: true });
    expect(recorded.json()).toMatchObject({ ok: true, base: { source: 'recorded' } });
    expectLineage(recorded, '3');
    expect(recorded.entry()?.folderBaseLiveVersion).toBe('3');

    const first = makeHarness({ server: makeServer({ live: null }) });

    await push(first, { yes: true });
    expect(first.json()).toMatchObject({ ok: true, base: { source: 'never_published' } });
    expectLineage(first, null);
    expect(first.entry()?.folderBaseLiveVersion).toBeNull();

    const detected = makeHarness({ server: makeServer({ live: '3' }), files: versionFiles('2') });

    await push(detected, { yes: true });
    expect(detected.json()).toMatchObject({ ok: true, base: { version: '2', source: 'detected' } });
    expectLineage(detected, '2');

    const viaPreview = makeServer({ live: '4' });

    viaPreview.pushPreviewFrom(USER, LOCAL, lineageOf('3'));

    const fromPreview = makeHarness({ server: viaPreview });

    await push(fromPreview, { yes: true });
    expect(fromPreview.json()).toMatchObject({
      ok: true,
      base: { version: '3', source: 'preview' },
    });
    expectLineage(fromPreview, '3');

    const chosen = makeServer({ live: '4' });
    const chosenId = chosen.pushPreviewFrom(USER, LOCAL, lineageOf('3'));
    const continued = makeHarness({ server: chosen, files: DIVERGED });

    await push(continued, { yes: true, baseFromPreview: chosenId });
    expect(continued.json()).toMatchObject({
      ok: true,
      base: { version: '3', source: 'base_from_preview' },
    });
    expectLineage(continued, '3');

    const mergedThenPushed = makeHarness({
      server: makeServer({ live: '5' }),
      state: [stateEntry()],
    });

    await merge(mergedThenPushed, { yes: true, acceptLiveBase: true });
    mergedThenPushed.reset();
    await push(mergedThenPushed, { yes: true });
    expect(mergedThenPushed.entry()?.folderBaseLiveVersion).toBe('5');
    expectLineage(mergedThenPushed, '5');

    const rolledBack = makeHarness({ server: makeServer({ live: '5' }), state: [stateEntry()] });

    await rollback(rolledBack, '2', { yes: true });
    expectLineage(rolledBack, '5');
    expect(rolledBack.entry()?.folderBaseLiveVersion).toBe('3');

    const noLive = makeHarness({
      server: makeServer({ live: null, releases: releasesUpTo('3') }),
      state: [stateEntry()],
    });

    await rollback(noLive, '2', { yes: true });
    expect(noLive.json()).toMatchObject({ ok: true, applied: true });
    expectLineage(noLive, null);
  });

  it("push on a machine with no state whose folder equals the caller's preview takes the preview's lineage base", async () => {
    const server = makeServer({ live: '4' });

    server.pushPreviewFrom(USER, LOCAL, lineageOf('3'));

    const h = makeHarness({ server });

    await push(h);

    expect(h.json()).toMatchObject({
      ok: true,
      dryRun: true,
      base: { version: '3', source: 'preview', liveMoved: true },
      notices: [PREVIEW_BASE_NOTICE('3')],
    });
    expect(downloads(server)).toHaveLength(1);
    expect(server.writes()).toStrictEqual([]);

    h.reset();
    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, applied: true });
    expect(h.entry()).toMatchObject({
      folderBaseLiveVersion: '3',
      folderBaseSourcePackageId: 'src-v3',
    });
    expectLineage(h, '3');

    h.reset();
    await publish(h, { yes: true });
    expect(h.json()).toMatchObject({
      code: 'publish_conflict',
      conflict: { reason: 'live_moved', baseLiveVersion: '3' },
    });
  });

  it('push with a diverged folder and a preview with lineage offers the continue-preview choice and never auto-selects it', async () => {
    const server = makeServer({ live: '4' });
    const previewId = server.pushPreviewFrom(USER, LOCAL, lineageOf('3'));
    const h = makeHarness({ server, files: DIVERGED });

    await push(h, { yes: true });

    expect(h.exitCodes).toStrictEqual([2]);
    expect(server.writes()).toStrictEqual([]);
    expect(h.store.writes).toBe(0);

    const result = h.json();

    expect(result).toMatchObject({
      ok: false,
      code: 'base_required',
      choice: 'base',
      choices: [
        { value: 'merge' },
        { value: 'accept' },
        {
          value: 'preview',
          label: CONTINUE_PREVIEW_LABEL('3'),
          args: [],
          argv: ['appbuilder', 'app', 'push', '--base-from-preview', previewId, ...JSON_ARGS],
        },
      ],
    });
    expect(result.choices).toHaveLength(3);
    expect(downloads(server)).toContain(`download:${previewId}`);

    const choice = (result.choices as { value: string; argv: string[] }[]).find(
      (candidate) => candidate.value === 'preview',
    );

    h.reset();
    await push(h, { baseFromPreview: previewId });
    expect(choice?.argv).not.toContain('--yes');
    expect(h.json()).toMatchObject({
      ok: true,
      dryRun: true,
      base: { version: '3', source: 'base_from_preview' },
      applyArgv: [
        'appbuilder',
        'app',
        'push',
        '--base-from-preview',
        previewId,
        '--yes',
        ...JSON_ARGS,
      ],
    });
    expect(server.writes()).toStrictEqual([]);

    server.pushPreviewFrom(USER, { 'kizen.json': 'elsewhere' }, lineageOf('2'));
    h.reset();
    await push(h, { yes: true, baseFromPreview: previewId });
    expect(h.exitCodes).toStrictEqual([2]);
    expect(server.writes()).toStrictEqual([]);
    expect(h.json()).toMatchObject({
      code: 'base_required',
      message: expect.stringContaining(PREVIEW_CHANGED_BASE_NOTICE) as unknown,
    });

    const again = makeHarness({ server, files: DIVERGED });

    await push(again, { yes: true });
    expect(again.exitCodes).toStrictEqual([2]);
    expect(again.json()).toMatchObject({ code: 'base_required' });
  });

  it('new user with no preview: first push behaviour unchanged (release match, and base_required)', async () => {
    const server = makeServer({ live: '3', previews: { [OTHER]: yourPreview() } });
    const matched = makeHarness({ server, files: versionFiles('2') });

    await push(matched, { yes: true });
    expect(matched.json()).toMatchObject({
      ok: true,
      base: { version: '2', source: 'detected' },
    });
    expect(server.calls.filter((call) => call.startsWith('getPreview'))).toStrictEqual([]);

    const diverged = makeHarness({ server: makeServer({ live: '3' }), files: DIVERGED });

    await push(diverged, { yes: true });
    expect(diverged.exitCodes).toStrictEqual([2]);
    expect(diverged.json()).toMatchObject({
      code: 'base_required',
      message:
        'No base version is recorded for this folder, and Live is v3. Merge Live into this folder, or record that it already contains Live, then push.',
      choices: [{ value: 'merge' }, { value: 'accept' }],
    });
    expect(diverged.json().choices).toHaveLength(2);
  });

  it('unreadable or malformed lineage is treated as none', async () => {
    const malformed: LineageFixture[] = [
      { raw: 'not json' },
      { raw: JSON.stringify({ format: 2, baseLiveVersion: '3', baseSourcePackageId: 'src-v3' }) },
      {
        raw: JSON.stringify({ format: 1, baseLiveVersion: 'v3', baseSourcePackageId: 'src-v3' }),
      },
      { raw: JSON.stringify({ format: 1, baseLiveVersion: null, baseSourcePackageId: 'x' }) },
      { raw: JSON.stringify({ format: 1, baseLiveVersion: '3' }) },
      { raw: JSON.stringify([1, '3']) },
      { raw: `{"format":1,"baseLiveVersion":"3","baseSourcePackageId":"${'x'.repeat(5000)}"}` },
    ];

    for (const lineage of malformed) {
      const server = makeServer({ live: '3', previews: { [USER]: yourPreview({ lineage }) } });
      const recorded = makeHarness({ server, state: [stateEntry()] });

      expect(readSourceLineage(previewZip(server))).toBeNull();
      await publish(recorded, { yes: true });
      expect(recorded.json()).toMatchObject({
        code: 'publish_conflict',
        conflict: { reason: 'base_unknown' },
      });

      const pushed = makeHarness({
        server: makeServer({
          live: '3',
          previews: { [USER]: yourPreview({ lineage, files: LOCAL }) },
        }),
      });

      await push(pushed, { yes: true });
      expect(pushed.json()).toMatchObject({ code: 'base_required' });
      expect(pushed.json().choices).toHaveLength(2);
    }
  });

  it('a recorded base whose version now has another source package is ignored by push and merge', async () => {
    const stale = stateEntry({ folderBaseSourcePackageId: 'src-v3' });
    const server = makeServer({ live: '3' });

    server.recreate('3');

    const pushed = makeHarness({ server, state: [stale], files: DIVERGED });

    await push(pushed, { yes: true });
    expect(pushed.exitCodes).toStrictEqual([2]);
    expect(server.writes()).toStrictEqual([]);
    expect(pushed.json()).toMatchObject({
      code: 'base_required',
      message: expect.stringContaining(REPLACED_BASE_NOTICE('3')) as unknown,
    });

    const merged = makeHarness({ server, state: [stale], files: DIVERGED });

    merged.mocks.planMerge.mockImplementation((input) =>
      Promise.resolve(input.base === null ? { status: 'no_base' } : readyPlan()),
    );
    await merge(merged);
    expect(merged.json()).toMatchObject({
      ok: true,
      dryRun: true,
      kind: 'fallback',
      baseSource: 'none',
      notices: [REPLACED_BASE_NOTICE('3')],
    });

    const fine = makeHarness({
      server,
      state: [stateEntry({ folderBaseSourcePackageId: 'src-r2-v3' })],
      files: DIVERGED,
    });

    await push(fine);
    expect(fine.json()).toMatchObject({ ok: true, base: { version: '3', source: 'recorded' } });
  });
});

describe('a preview pushed from here and published outside the CLI', () => {
  const promotedElsewhere = async (): Promise<Harness> => {
    const server = makeServer({ live: '1' });
    const h = makeHarness({
      server,
      state: [stateEntry({ folderBaseLiveVersion: '1' })],
    });

    await push(h, { yes: true });
    expect(h.json()).toMatchObject({ ok: true, applied: true });

    const pushed = h.entry()?.previewSourcePackageId;

    await server.api.promotePreview(APP_API, USER);
    expect(server.state.live).toBe('2');
    expect(server.state.definitions.get('2')?.source_filesystem_package).toBe(pushed);
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '1' });
    h.reset();

    return h;
  };

  it('preview pushed from here and promoted outside the CLI advances the folder base to that Live version, with no merge warning', async () => {
    const h = await promotedElsewhere();

    await versions(h);

    const report = h.json();

    expect(report).toMatchObject({
      ok: true,
      base: {
        folder: { recorded: true, version: '2' },
        liveMoved: false,
      },
      next: [
        { step: 'push', argv: ['appbuilder', 'app', 'push', ...JSON_ARGS] },
        { step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] },
      ],
    });
    expect(JSON.stringify(report.warnings)).not.toContain('appbuilder app merge');
    expect(h.stderr.join('')).toContain(PROMOTED_PREVIEW_NOTICE('2'));

    h.reset();
    h.server.calls.length = 0;
    await push(h);

    const planned = h.json();

    expect(planned).toMatchObject({
      ok: true,
      dryRun: true,
      base: { version: '2', source: 'recorded', liveMoved: false },
    });
    expect(JSON.stringify(planned.warnings)).not.toContain('appbuilder app merge');
    expect(h.server.calls.filter((call) => call === 'getVersion:2')).toHaveLength(1);

    h.reset();
    await merge(h);
    expect(h.json()).toMatchObject({
      ok: true,
      kind: 'up_to_date',
      targetVersion: '2',
      baseVersion: '2',
      baseSource: 'recorded',
    });

    const edited = await promotedElsewhere();

    edited.local.files = { ...edited.local.files, 'src/later.js': 'later' };
    await push(edited);
    expect(edited.json()).toMatchObject({
      ok: true,
      base: { version: '2', source: 'recorded', liveMoved: false },
    });
  });

  it('promoted outside the CLI after the folder merged another base keeps the recorded base', async () => {
    const server = makeServer({ live: '2' });
    const h = makeHarness({
      server,
      state: [stateEntry({ folderBaseLiveVersion: '1' })],
    });

    await push(h, { yes: true });
    h.reset();
    await merge(h, { yes: true, acceptLiveBase: true });
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '2' });

    await server.api.promotePreview(APP_API, USER);
    expect(server.state.live).toBe('3');
    h.reset();
    await versions(h);

    expect(h.json()).toMatchObject({
      base: { folder: { recorded: true, version: '2' }, liveMoved: true },
      warnings: [expect.stringContaining('appbuilder app merge') as unknown],
    });
    expect(h.stderr.join('')).not.toContain(PROMOTED_PREVIEW_NOTICE('3'));
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '2' });
  });

  it('a preview you no longer have: its recorded fields go on the next write', async () => {
    const h = await promotedElsewhere();
    const entry = h.entry();

    if (entry === undefined) {
      throw new Error('no entry');
    }

    h.store.doc = {
      ...h.store.doc,
      entries: [
        {
          ...entry,
          folderBaseLiveVersion: '2',
          folderBaseSourcePackageId: entry.previewSourcePackageId,
        },
      ],
    };
    expect(h.server.state.previews.has(USER)).toBe(false);

    await versions(h);
    expect(h.json()).toMatchObject({
      base: { folder: { recorded: true, version: '2' }, liveMoved: false },
      yourPreview: null,
    });

    h.reset();
    await merge(h, { yes: true, acceptLiveBase: true });
    expect(h.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '2' });
    expect(h.entry()).not.toHaveProperty('previewSourcePackageId');
  });

  it('persisted on the next write', async () => {
    const h = await promotedElsewhere();
    const pushed = h.entry()?.previewSourcePackageId;
    const writesBefore = h.store.writes;

    await versions(h);
    expect(h.store.writes).toBe(writesBefore);
    expect(h.entry()).toMatchObject({ folderBaseLiveVersion: '1' });

    h.reset();
    await rollback(h, '1', { yes: true });
    expect(h.json()).toMatchObject({ ok: true, applied: true });
    expect(h.entry()).toMatchObject({
      folderBaseLiveVersion: '2',
      folderBaseSourcePackageId: pushed,
      previewRestoredFrom: '1',
    });
  });
});

describe('recorded bases that no longer name a version', () => {
  const LOCAL: Files = { 'kizen.json': '{"api_name":"acme","local":true}' };
  const DIVERGED: Files = { ...LOCAL, 'src/new.js': 'x' };

  it('a recorded base whose version no longer exists is ignored by push: base_required, nothing uploaded, recorded package kept', async () => {
    const recorded = stateEntry({ folderBaseSourcePackageId: 'src-v3' });

    const unlisted = makeServer({ live: '2', deleted: ['3'] });
    const unreadable = makeServer({ live: '3' });

    unreadable.state.definitions.delete('3');

    for (const server of [unlisted, unreadable]) {
      const h = makeHarness({ server, state: [recorded], files: DIVERGED });

      await push(h, { yes: true });

      expect(h.exitCodes).toStrictEqual([2]);
      expect(server.writes()).toStrictEqual([]);
      expect(h.store.writes).toBe(0);
      expect(h.json()).toMatchObject({
        code: 'base_required',
        message: expect.stringContaining(GONE_BASE_NOTICE('3')) as unknown,
        choices: [{ value: 'merge' }, { value: 'accept' }],
      });
      expect(h.entry()).toMatchObject({
        folderBaseLiveVersion: '3',
        folderBaseSourcePackageId: 'src-v3',
      });
    }
  });

  it('folder adopted a promoted version that was then deleted: versions/push/merge/publish give one working path (accept, then push and publish succeed)', async () => {
    const server = makeServer({ live: '1', deleted: ['2'] });
    const h = makeHarness({
      server,
      state: [
        {
          ...KEY,
          folderBaseLiveVersion: '2',
          folderBaseSourcePackageId: 'file-9',
          lastPushedSourceHash: null,
        },
      ],
    });

    await versions(h);
    expect(h.json()).toMatchObject({
      base: { folder: { recorded: false, version: null }, liveMoved: false },
      warnings: [GONE_BASE_NOTICE('2')],
      next: [
        { step: 'push', argv: ['appbuilder', 'app', 'push', ...JSON_ARGS] },
        { step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] },
      ],
    });

    h.reset();
    await push(h, { yes: true });
    expect(h.exitCodes).toStrictEqual([2]);
    expect(server.writes()).toStrictEqual([]);

    const required = h.json();

    expect(required).toMatchObject({ code: 'base_required' });

    h.reset();
    h.mocks.planMerge.mockResolvedValue({ status: 'no_base' });
    await merge(h);
    expect(h.json()).toMatchObject({
      dryRun: true,
      kind: 'fallback',
      baseSource: 'none',
      notices: [GONE_BASE_NOTICE('2')],
    });

    h.reset();
    await publish(h, { yes: true });
    expect(h.json()).toMatchObject({ code: 'no_preview' });

    const accept = (required.choices as { value: string; argv: string[] }[]).find(
      (choice) => choice.value === 'accept',
    );

    expect(accept?.argv).toContain('--accept-live-base');
    h.reset();
    await merge(h, { yes: true, release: '1', acceptLiveBase: true });
    expect(h.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(h.entry()).toMatchObject({
      folderBaseLiveVersion: '1',
      folderBaseSourcePackageId: 'src-v1',
    });

    h.reset();
    await push(h, { yes: true });
    expect(h.json()).toMatchObject({ ok: true, base: { version: '1', source: 'recorded' } });

    h.reset();
    await publish(h, { yes: true });
    expect(h.json()).toMatchObject({
      ok: true,
      liveVersion: '3',
      conflictCheck: { conflict: false },
    });
  });

  it('a restored preview promoted outside the CLI does not move the folder base', async () => {
    const server = makeServer({ live: '3' });
    const h = makeHarness({ server, state: [stateEntry()] });

    await rollback(h, '1', { yes: true });
    expect(h.entry()).toMatchObject({ previewRestoredFrom: '1' });
    await server.api.promotePreview(APP_API, USER);
    expect(server.state.live).toBe('4');

    h.reset();
    await push(h);
    expect(h.json()).toMatchObject({
      ok: true,
      base: { version: '3', source: 'recorded', liveMoved: true },
    });
    expect(h.stderr.join('')).not.toContain(PROMOTED_PREVIEW_NOTICE('4'));
  });

  it('push never takes a base from a lineage whose package no longer matches', async () => {
    const server = makeServer({ live: '3' });

    server.recreate('3');
    server.pushPreviewFrom(USER, LOCAL, lineageOf('3', 'src-v3'));

    const h = makeHarness({ server });

    await push(h, { yes: true });
    expect(h.exitCodes).toStrictEqual([2]);
    expect(server.writes()).toStrictEqual([]);

    const result = h.json();

    expect(result).toMatchObject({ code: 'base_required' });
    expect(result.choices).toHaveLength(2);
  });

  it('an unreadable preview source stops publish, --force included, with a hint', async () => {
    const server = makeServer({ live: '3', previews: { [USER]: yourPreview() } });

    server.api.downloadFile.mockRejectedValue(
      new KizenApiError('api_error', 'GET /files failed with 500', { status: 500 }),
    );

    const h = makeHarness({ server, state: [stateEntry()] });

    await publish(h, { yes: true, force: true });
    expect(server.calls.filter((call) => call.startsWith('promote'))).toStrictEqual([]);
    expect(h.json()).toMatchObject({
      ok: false,
      code: 'api_error',
      hint: PREVIEW_SOURCE_UNREADABLE_HINT,
    });
  });
});
