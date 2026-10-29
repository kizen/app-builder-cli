import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DeployablePlugin } from '@kizenapps/packager';
import { PREVIEW_ONLY_LINK_HINT } from '../lib/appActions.js';
import {
  runAppPublishHeadless,
  runAppPushHeadless,
  runAppVersionsHeadless,
} from '../lib/appHeadless.js';
import { applyMerge } from '../lib/appMerge.js';
import { KizenApiError } from '../lib/kizenClient.js';
import {
  API_KEY,
  CONTACTS,
  conflictsOutcome,
  DEALS,
  definition,
  deployable,
  jsAction,
  makeHarness,
  makeServer,
  OLD_DEALS,
  OTHER,
  readyPlan,
  stateEntry,
  USER,
  versionFiles,
  withJsActions,
  lineageOf,
  yourPreview,
  type HarnessOptions,
  type ServerOptions,
  type StoredAssociation,
  type Harness,
} from '../test/appHarness.js';
import {
  choiceStep,
  createAppFlow,
  isFinalAppPhase,
  withoutForceAdvice,
  type AppFlow,
  type AppPhase,
  type AppRequest,
} from './appUiFlow.js';
import {
  CONTINUE_PREVIEW_LABEL,
  createDefaultAppDeps,
  DELETES_APP_WARNING,
  NOT_YOUR_PREVIEW_WARNING,
  PREVIEW_CHANGED_HINT,
  PREVIEW_CHANGED_MESSAGE,
  PREVIEW_IN_USE_WARNING,
} from '../lib/appFlow.js';
import { EMPTY_SESSION, interrupt, type Session } from './commandSession.js';

type PhaseOf<T extends AppPhase['type']> = Extract<AppPhase, { type: T }>;

interface FlowRun {
  flow: AppFlow;
  phases: AppPhase[];
  state: { session: Session };
  until: <T extends AppPhase['type']>(type: T) => Promise<PhaseOf<T>>;
}

function startFlow(h: Harness, request: AppRequest): FlowRun {
  const phases: AppPhase[] = [];
  const state: { session: Session } = { session: EMPTY_SESSION };
  const waiting = new Set<() => boolean>();
  let consumed = -1;

  const record = (phase: AppPhase): void => {
    phases.push(phase);

    for (const check of [...waiting]) {
      if (check()) {
        waiting.delete(check);
      }
    }
  };

  const flow = createAppFlow(
    request,
    h.deps,
    (next) => {
      if (typeof next !== 'function') {
        record(next);

        return;
      }

      const previous = phases.at(-1);

      if (previous === undefined) {
        throw new Error('a phase update before any phase');
      }

      record(next(previous));
    },
    (next) => {
      state.session = typeof next === 'function' ? next(state.session) : next;
    },
  );

  const until = <T extends AppPhase['type']>(type: T): Promise<PhaseOf<T>> =>
    new Promise((resolve, reject) => {
      const check = (): boolean => {
        for (let index = consumed + 1; index < phases.length; index += 1) {
          const phase = phases[index];

          if (phase?.type === type) {
            consumed = index;
            resolve(phase as PhaseOf<T>);

            return true;
          }

          if (phase !== undefined && isFinalAppPhase(phase)) {
            reject(new Error(`expected a ${type} phase, but the flow ended on ${shown(phase)}`));

            return true;
          }
        }

        return false;
      };

      if (!check()) {
        waiting.add(check);
      }
    });

  flow.start();

  return { flow, phases, state, until };
}

const shown = (phase: AppPhase): string =>
  JSON.stringify(phase, (key, value: unknown) =>
    key === 'apply' || key === 'run' ? undefined : value,
  );

function conflictHarness(): Harness {
  const server = makeServer({ live: '3', previews: { 'user-1': yourPreview() } });

  server.release();

  return makeHarness({ server, state: [stateEntry()] });
}

const nothingWritten = (h: Harness): void => {
  expect(h.server.writes()).toStrictEqual([]);
  expect(h.store.writes).toBe(0);
  expect(h.mocks.applyMerge).not.toHaveBeenCalled();
  expect(
    h.mocks.unzip.mock.calls.map(([, dir]) => dir).filter((dir) => !dir.startsWith('/tmp/')),
  ).toStrictEqual([]);
};

describe('app UI flow', () => {
  it('push happy path: plan, confirm, save the preview, then point at publish', async () => {
    const server = makeServer({ live: '3', previews: { 'user-1': yourPreview() } });
    const h = makeHarness({ server, state: [stateEntry()] });
    const { flow, until, state } = startFlow(h, { command: 'push', options: { ...API_KEY } });

    const confirm = await until('confirm');

    expect(confirm.isProduction).toBe(false);
    expect(confirm.prompt).toBe('Push? (Y/n)');
    expect(confirm.lines).toStrictEqual([
      'Environment: staging',
      'Business: biz',
      'App: Acme (acme_abc123)',
      'Live: v3',
      expect.stringMatching(/^Source: 1 files \(git\), \d+ bytes$/) as string,
      'Thumbnail: yes',
      'Preview: replaces yours (last updated 2026-10-20T00:00:00.000Z)',
      'Base: v3 (recorded for this folder)',
    ]);
    expect(state.session.credentials).toStrictEqual({ environment: 'staging', businessId: 'biz' });
    nothingWritten(h);

    flow.accept(confirm);

    const done = await until('done');

    expect(done.outcome).toMatchObject({
      title: '✓ Saved your preview of Acme (acme_abc123)',
      tone: 'success',
      next: 'appbuilder app publish --profile credentials',
    });
    expect(h.server.writes()).toStrictEqual([
      'upload:plugin_app_source_filesystem',
      'upload:public_image',
      'publish:false',
    ]);
    expect(h.entry()).toMatchObject({
      folderBaseLiveVersion: '3',
      previewSourcePackageId: 'file-1',
    });
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('push on production requires the strict confirm', async () => {
    const onGo = (): Harness =>
      makeHarness({
        server: makeServer({ live: null }),
        credentials: { environment: 'go' },
      });

    const asked = onGo();
    const confirm = await startFlow(asked, { command: 'push', options: { ...API_KEY } }).until(
      'confirm',
    );

    expect(confirm.isProduction).toBe(true);
    expect(confirm.productionPrompt).toBe('Type y to push to production (y/N)');

    const yesOnly = onGo();

    await startFlow(yesOnly, { command: 'push', options: { ...API_KEY, yes: true } }).until(
      'confirm',
    );
    nothingWritten(yesOnly);

    const allowed = onGo();

    await startFlow(allowed, {
      command: 'push',
      options: { ...API_KEY, yes: true, allowProduction: true },
    }).until('done');
    expect(allowed.server.writes()).toContain('publish:false');

    const staging = await startFlow(makeHarness({ server: makeServer({ live: null }) }), {
      command: 'push',
      options: { ...API_KEY },
    }).until('confirm');

    expect(staging.isProduction).toBe(false);
  });

  it('push --dry-run shows the plan and writes nothing', async () => {
    const h = makeHarness({ server: makeServer({ live: null }) });
    const done = await startFlow(h, {
      command: 'push',
      options: { ...API_KEY, dryRun: true },
    }).until('done');

    expect(done.outcome).toMatchObject({ title: 'Dry run: nothing was written.', tone: 'warning' });
    expect(done.outcome.lines).toContain('Preview: new');
    nothingWritten(h);
  });

  it('publish conflict offers merge, never --force', async () => {
    const h = conflictHarness();
    const { flow, until } = startFlow(h, { command: 'publish', options: { ...API_KEY } });
    const choose = await until('choose');

    expect(choose.choices.map((choice) => choice.value)).toStrictEqual(['merge', 'exit']);
    expect(choose.message).toContain('Live is v4');
    expect(choose.message).toContain('your preview is based on v3');
    expect(shown(choose)).not.toContain('--force');
    expect(
      choose.choices.flatMap((choice) => [...choice.args, ...(choice.argv ?? [])]),
    ).not.toContain('--force');
    nothingWritten(h);

    h.mocks.planMerge.mockResolvedValue(readyPlan({ liveVersion: '4' }));

    const merge = choose.choices.find((choice) => choice.value === 'merge');

    if (merge === undefined) {
      throw new Error('no merge choice');
    }

    flow.choose(choose, merge);

    const confirm = await until('confirm');

    expect(confirm.prompt).toBe('Merge? (Y/n)');
    expect(confirm.lines).toContain('Merge Live v4 into this folder (base v3).');
    expect(h.mocks.planMerge.mock.calls[0]?.[0].live.version).toBe('4');
    nothingWritten(h);
  });

  it('a conflict found just before publishing merges the Live it found', async () => {
    const h = makeHarness({
      server: makeServer({ live: '3', previews: { 'user-1': yourPreview() } }),
      state: [stateEntry()],
    });
    const { flow, until } = startFlow(h, { command: 'publish', options: { ...API_KEY } });
    const confirm = await until('confirm');

    h.server.release();
    flow.accept(confirm);

    const choose = await until('choose');
    const merge = choose.choices.find((choice) => choice.value === 'merge');

    if (merge === undefined) {
      throw new Error('no merge choice');
    }

    expect(h.server.writes()).toStrictEqual([]);
    h.mocks.planMerge.mockResolvedValue(readyPlan({ liveVersion: '4' }));
    flow.choose(choose, merge);
    await until('confirm');
    expect(h.mocks.planMerge.mock.calls[0]?.[0].live.version).toBe('4');
  });

  it('publish conflict: exit ends without publishing', async () => {
    const h = conflictHarness();
    const { flow, until } = startFlow(h, { command: 'publish', options: { ...API_KEY } });
    const choose = await until('choose');
    const exit = choose.choices.find((choice) => choice.value === 'exit');

    if (exit === undefined) {
      throw new Error('no exit choice');
    }

    flow.choose(choose, exit);

    const error = await until('error');

    expect(error.view.message).toBe(choose.message);
    expect(h.exitCodes).toStrictEqual([1]);
    nothingWritten(h);
  });

  it('a publish of a preview whose base is unknown offers pushing this folder, never --force', async () => {
    const server = makeServer({
      live: '3',
      previews: { 'user-1': yourPreview({ lineage: null }) },
    });
    const h = makeHarness({ server, state: [stateEntry()] });
    const choose = await startFlow(h, { command: 'publish', options: { ...API_KEY } }).until(
      'choose',
    );

    expect(choose.choices.map((choice) => choice.value)).toStrictEqual(['push', 'exit']);
    expect(choose.message).toContain("doesn't say what it's based on");
    expect(shown(choose)).not.toContain('--force');
    nothingWritten(h);
  });

  it('base_required picker runs the chosen step', async () => {
    const h = makeHarness({ server: makeServer({ live: '3' }) });
    const { flow, until, state } = startFlow(h, { command: 'push', options: { ...API_KEY } });
    const choose = await until('choose');

    expect(choose.choices.map((choice) => choice.value)).toStrictEqual(['merge', 'accept']);

    const accept = choose.choices.find((choice) => choice.value === 'accept');

    if (accept === undefined) {
      throw new Error('no accept choice');
    }

    flow.choose(choose, accept);

    const confirm = await until('confirm');

    expect(h.entry()?.folderBaseLiveVersion).toBe('3');
    expect(state.session.notices).toContain("✓ Recorded v3 as this folder's base.");
    expect(confirm.prompt).toBe('Push? (Y/n)');
    expect(confirm.lines).toContain('Base: v3 (recorded for this folder)');
    expect(h.server.writes()).toStrictEqual([]);

    const again = makeHarness({ server: makeServer({ live: '3' }) });
    const second = startFlow(again, { command: 'push', options: { ...API_KEY } });
    const picker = await second.until('choose');
    const merge = picker.choices.find((choice) => choice.value === 'merge');

    if (merge === undefined) {
      throw new Error('no merge choice');
    }

    again.mocks.planMerge.mockResolvedValue(readyPlan({ baseVersion: '3', liveVersion: '3' }));
    second.flow.choose(picker, merge);
    await vi.waitFor(() => {
      expect(again.mocks.planMerge).toHaveBeenCalled();
    });
    expect(again.store.writes).toBe(0);
  });

  it('choiceStep reads the step a choice prints', () => {
    expect(
      choiceStep({
        value: 'accept',
        label: 'x',
        args: [],
        argv: ['appbuilder', 'app', 'merge', '--release', '5', '--accept-live-base', '--yes'],
      }),
    ).toStrictEqual({ command: 'merge', options: { version: '5', acceptLiveBase: true } });
    expect(
      choiceStep({
        value: 'base:3',
        label: 'x',
        args: [],
        argv: ['appbuilder', 'app', 'merge', '--release', '5', '--base', '3', '--yes'],
      }),
    ).toStrictEqual({ command: 'merge', options: { version: '5', base: '3' } });
    expect(
      choiceStep({ value: 'push', label: 'x', args: [], argv: ['appbuilder', 'app', 'push'] }),
    ).toStrictEqual({ command: 'push' });
    expect(choiceStep({ value: 'go', label: 'go', args: ['--env', 'go'] })).toBeNull();
  });

  it('merge with conflicts shows files and marker meaning', async () => {
    const server = makeServer({ live: '3' });

    server.release();

    const h = makeHarness({ server, state: [stateEntry()] });

    h.mocks.planMerge.mockResolvedValue(readyPlan({ liveVersion: '4' }));
    h.mocks.applyMerge.mockResolvedValue(conflictsOutcome);

    const { flow, until } = startFlow(h, { command: 'merge', options: { ...API_KEY } });
    const confirm = await until('confirm');

    expect(confirm.lines).toEqual(
      expect.arrayContaining([
        'Merge Live v4 into this folder (base v3).',
        'Conflicted (1):',
        '  src/a.js',
        'Conflicted files get git conflict markers: <<<<<<< HEAD is your file and >>>>>>> live is Live v4.',
      ]),
    );
    nothingWritten(h);

    flow.accept(confirm);

    const done = await until('done');

    expect(done.outcome.tone).toBe('warning');
    expect(done.outcome.title).toBe('Merged Live v4 into this folder with conflicts.');
    expect(done.outcome.lines).toEqual(
      expect.arrayContaining([
        'Conflicted (2):',
        '  src/a.js',
        '  src/gone.js',
        'Resolve the conflict markers in the files above: the side marked <<<<<<< HEAD is your file and the side marked >>>>>>> live is Live v4. Then run `appbuilder app push` and `appbuilder app publish`.',
      ]),
    );
    expect(h.entry()?.folderBaseLiveVersion).toBe('4');
  });

  it('cancel at any confirm writes nothing', async () => {
    const live = (): Harness =>
      makeHarness({
        server: makeServer({ live: '3', previews: { 'user-1': yourPreview() } }),
        state: [stateEntry()],
      });
    const moved = (): Harness => {
      const h = makeHarness({ server: makeServer({ live: '3' }), state: [stateEntry()] });

      h.server.release();
      h.mocks.planMerge.mockResolvedValue(readyPlan({ liveVersion: '4' }));
      h.mocks.applyMerge.mockResolvedValue(conflictsOutcome);

      return h;
    };

    const cases: [AppRequest, () => Harness][] = [
      [{ command: 'push', options: { ...API_KEY } }, live],
      [{ command: 'publish', options: { ...API_KEY } }, live],
      [{ command: 'merge', options: { ...API_KEY } }, moved],
      [{ command: 'rollback', version: '2', options: { ...API_KEY } }, live],
    ];

    for (const [request, harness] of cases) {
      const h = harness();
      const { flow, until } = startFlow(h, request);

      await until('confirm');
      flow.cancel();

      const error = await until('error');

      expect(error.view.message, request.command).toBe('Cancelled.');
      expect(h.exitCodes, request.command).toStrictEqual([1]);
      nothingWritten(h);
    }
  });

  it('versions shows the report, yours marked', async () => {
    const h = makeHarness({
      server: makeServer({ live: '3', previews: { 'user-1': yourPreview() } }),
      state: [stateEntry()],
    });
    const report = await startFlow(h, { command: 'versions', options: { ...API_KEY } }).until(
      'report',
    );

    expect(report.lines).toContain('Live: v3 (published 2026-09-12T00:00:00.000Z by Grace H)');
    expect(report.lines).toContain('  Ada L (yours), updated 2026-10-20T00:00:00.000Z');
    expect(report.lines).toContain('Folder base: v3');
  });

  it("versions ends in the error frame when this folder's base version can't be read", async () => {
    const h = makeHarness({ server: makeServer({ live: '3' }), state: [stateEntry()] });

    h.server.api.getVersion.mockRejectedValue(
      new KizenApiError('api_error', 'GET /versions/3 failed with 500', { status: 500 }),
    );

    const error = await startFlow(h, { command: 'versions', options: { ...API_KEY } }).until(
      'error',
    );

    expect(error.view.message).toContain('failed with 500');
    expect(h.exitCodes).toStrictEqual([1]);
  });

  it('not signed in names the login command for the person, not the agent hint', async () => {
    const h = makeHarness();
    const error = await startFlow(h, { command: 'versions', options: {} }).until('error');

    expect(error.view.message).toContain("You're not signed in");
    expect(error.view.hint).toBe('Sign in with: appbuilder login');
    expect(h.exitCodes).toStrictEqual([1]);
  });

  it('a thrown API error ends in the error frame with the Business App hint', async () => {
    const h = makeHarness();

    h.server.api.listApps.mockRejectedValue(
      new KizenApiError('forbidden', 'GET /business-apps failed with 403', { status: 403 }),
    );

    const error = await startFlow(h, { command: 'versions', options: { ...API_KEY } }).until(
      'error',
    );

    expect(error.view.hint).toContain('Business App Developer');
  });

  it('a picked push on production stops at the strict confirm', async () => {
    const server = makeServer({
      live: '3',
      previews: { 'user-1': yourPreview({ lineage: null }) },
    });
    const h = makeHarness({
      server,
      credentials: { environment: 'go' },
      state: [stateEntry({ environment: 'go' })],
    });
    const { flow, until } = startFlow(h, {
      command: 'publish',
      options: { ...API_KEY, yes: true },
    });
    const choose = await until('choose');
    const push = choose.choices.find((choice) => choice.value === 'push');

    if (push === undefined) {
      throw new Error('no push choice');
    }

    flow.choose(choose, push);

    const confirm = await until('confirm');

    expect(confirm.isProduction).toBe(true);
    expect(confirm.productionPrompt).toBe('Type y to push to production (y/N)');
    nothingWritten(h);
  });

  it('Esc on a base_required picker cancels with no writes (exit 1)', async () => {
    const h = makeHarness({ server: makeServer({ live: '3' }) });
    const { flow, until } = startFlow(h, { command: 'push', options: { ...API_KEY } });
    const choose = await until('choose');

    flow.dismiss(choose);

    const error = await until('error');

    expect(error.view.message).toBe('Cancelled.');
    expect(h.exitCodes).toStrictEqual([1]);
    nothingWritten(h);
  });

  it('a --force publish at a terminal refuses a preview replaced while its confirm is open', async () => {
    const server = makeServer({ live: '3', previews: { 'user-1': yourPreview() } });

    server.release();

    const h = makeHarness({ server, state: [stateEntry()] });
    const { flow, until } = startFlow(h, {
      command: 'publish',
      options: { ...API_KEY, force: true },
    });
    const confirm = await until('confirm');

    h.server.state.previews.set(
      'user-1',
      yourPreview({ def: { ...yourPreview().def, source_filesystem_package: 'src-elsewhere' } }),
    );
    flow.accept(confirm);

    const error = await until('error');

    expect(error.view).toMatchObject({
      message: PREVIEW_CHANGED_MESSAGE,
      hint: PREVIEW_CHANGED_HINT,
    });
    expect(h.server.calls.filter((call) => call.startsWith('promote'))).toStrictEqual([]);
    expect(h.server.state.live).toBe('4');
    expect(h.exitCodes).toStrictEqual([1]);
  });

  it('the pre-promote re-check catches a replaced preview on a first release', async () => {
    const h = makeHarness({
      server: makeServer({ live: null, previews: { 'user-1': yourPreview() } }),
    });
    const { flow, until } = startFlow(h, { command: 'publish', options: { ...API_KEY } });
    const confirm = await until('confirm');

    h.server.state.previews.set(
      'user-1',
      yourPreview({ def: { ...yourPreview().def, source_filesystem_package: 'src-elsewhere' } }),
    );
    flow.accept(confirm);

    const error = await until('error');

    expect(error.view).toMatchObject({
      message: PREVIEW_CHANGED_MESSAGE,
      hint: PREVIEW_CHANGED_HINT,
    });
    expect(h.server.calls.filter((call) => call.startsWith('promote'))).toStrictEqual([]);
    expect(h.server.state.live).toBeNull();
    expect(h.exitCodes).toStrictEqual([1]);
  });

  describe('Ctrl+C', () => {
    const gated = (h: Harness): (() => void) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = h.deps.readAppState;

      h.deps.readAppState = vi.fn(async (dir: string) => {
        await gate;

        return read(dir);
      });

      return release;
    };

    const drain = async (): Promise<void> => {
      for (let tick = 0; tick < 5; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const pushHarness = (): Harness =>
      makeHarness({
        server: makeServer({ live: '3', previews: { 'user-1': yourPreview() } }),
        state: [stateEntry()],
      });

    it('Ctrl+C before apply starts no write', async () => {
      const control = pushHarness();
      const releaseControl = gated(control);

      startFlow(control, { command: 'push', options: { ...API_KEY, yes: true } });
      await vi.waitFor(() => {
        expect(control.deps.readAppState).toHaveBeenCalled();
      });
      releaseControl();
      await drain();
      expect(control.server.writes()).toContain('publish:false');

      const h = pushHarness();
      const release = gated(h);
      const { flow, phases } = startFlow(h, {
        command: 'push',
        options: { ...API_KEY, yes: true },
      });

      await vi.waitFor(() => {
        expect(h.deps.readAppState).toHaveBeenCalled();
      });

      const shownBefore = phases.length;

      interrupt(flow.abort, h.deps.setExitCode);
      release();
      await drain();

      nothingWritten(h);
      expect(h.exitCodes).toStrictEqual([130]);
      expect(phases).toHaveLength(shownBefore);
    });

    it('Ctrl+C shows nothing more, a decision included', async () => {
      const h = makeHarness({ server: makeServer({ live: '3' }) });
      const download = h.server.api.downloadFile.getMockImplementation();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      h.server.api.downloadFile.mockImplementation(async (id) => {
        await gate;

        if (download === undefined) {
          throw new Error('no downloadFile fake');
        }

        return download(id);
      });

      const { flow, phases } = startFlow(h, { command: 'push', options: { ...API_KEY } });

      await vi.waitFor(() => {
        expect(h.server.api.downloadFile).toHaveBeenCalled();
      });

      const shownBefore = phases.length;

      interrupt(flow.abort, h.deps.setExitCode);
      release();
      await drain();

      expect(phases).toHaveLength(shownBefore);
      expect(phases.some((phase) => phase.type === 'choose')).toBe(false);
      expect(h.exitCodes).toStrictEqual([130]);
    });

    interface Held {
      wait: () => Promise<void>;
      arrived: Promise<void>;
      release: () => void;
    }

    const hold = (): Held => {
      let release: () => void = () => undefined;
      let arrive: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
      });

      return {
        wait: () => {
          arrive();

          return gate;
        },
        arrived,
        release,
      };
    };

    const interruptDuringApply = async (
      h: Harness,
      request: AppRequest,
      held: Held,
      { control }: { control: boolean },
    ): Promise<void> => {
      const { flow, until } = startFlow(h, request);
      const confirm = await until('confirm');

      flow.accept(confirm);
      await held.arrived;

      if (!control) {
        interrupt(flow.abort, h.deps.setExitCode);
      }

      held.release();
      await drain();
    };

    it('Ctrl+C while publishing re-checks the preview starts no promote', async () => {
      const run = async (control: boolean): Promise<Harness> => {
        const h = pushHarness();
        const held = hold();
        const getPreview = h.server.api.getPreview.getMockImplementation();
        let reads = 0;

        h.server.api.getPreview.mockImplementation(async (apiName, owner) => {
          reads += 1;

          if (reads === 2) {
            await held.wait();
          }

          if (getPreview === undefined) {
            throw new Error('no getPreview fake');
          }

          return getPreview(apiName, owner);
        });
        await interruptDuringApply(h, { command: 'publish', options: { ...API_KEY } }, held, {
          control,
        });

        return h;
      };

      expect((await run(true)).server.writes()).toStrictEqual(['promote:user-1']);

      const h = await run(false);

      expect(h.server.writes()).toStrictEqual([]);
      expect(h.server.state.live).toBe('3');
      expect(h.store.writes).toBe(0);
      expect(h.exitCodes).toStrictEqual([130]);
    });

    it('Ctrl+C after uploads starts no preview save', async () => {
      const run = async (control: boolean): Promise<Harness> => {
        const h = pushHarness();
        const held = hold();
        const upload = h.server.api.uploadFile.getMockImplementation();

        h.server.api.uploadFile.mockImplementation(async (bytes, opts) => {
          if (opts.source === 'plugin_app_source_filesystem') {
            await held.wait();
          }

          if (upload === undefined) {
            throw new Error('no uploadFile fake');
          }

          return upload(bytes, opts);
        });
        await interruptDuringApply(h, { command: 'push', options: { ...API_KEY } }, held, {
          control,
        });

        return h;
      };

      expect((await run(true)).server.writes()).toContain('publish:false');

      const h = await run(false);

      expect(h.server.writes()).not.toContain('publish:false');
      expect(h.store.writes).toBe(0);
      expect(h.exitCodes).toStrictEqual([130]);
    });

    it('Ctrl+C while a push re-zips after adding .gitignore entries starts no upload', async () => {
      const run = async (control: boolean): Promise<Harness> => {
        const h = pushHarness();
        const held = hold();
        const zip = h.deps.zipSourceDir;
        let zips = 0;

        h.deps.ensureGitignore = vi.fn(() => true);
        h.deps.zipSourceDir = vi.fn(async (dir: string) => {
          zips += 1;

          if (zips === 2) {
            await held.wait();
          }

          return zip(dir);
        });
        await interruptDuringApply(h, { command: 'push', options: { ...API_KEY } }, held, {
          control,
        });

        return h;
      };

      expect((await run(true)).server.writes()).toContain('publish:false');

      const h = await run(false);

      expect(h.server.writes()).toStrictEqual([]);
      expect(h.store.writes).toBe(0);
      expect(h.exitCodes).toStrictEqual([130]);
    });

    it('Ctrl+C after the rollback thumbnail upload starts no preview save', async () => {
      const run = async (control: boolean): Promise<Harness> => {
        const h = pushHarness();
        const held = hold();
        const upload = h.server.api.uploadFile.getMockImplementation();

        h.server.api.uploadFile.mockImplementation(async (bytes, opts) => {
          await held.wait();

          if (upload === undefined) {
            throw new Error('no uploadFile fake');
          }

          return upload(bytes, opts);
        });
        await interruptDuringApply(
          h,
          { command: 'rollback', version: '2', options: { ...API_KEY } },
          held,
          { control },
        );

        return h;
      };

      expect((await run(true)).server.writes()).toContain('publish:false');

      const h = await run(false);

      expect(h.server.writes()).not.toContain('publish:false');
      expect(h.store.writes).toBe(0);
      expect(h.exitCodes).toStrictEqual([130]);
    });

    it(
      'Ctrl+C while a merge prepares its apply writes no source file',
      { timeout: 30_000 },
      async () => {
        const tmp = await mkdtemp(join(tmpdir(), 'appbuilder-ui-merge-'));
        const original = versionFiles('3');

        const run = async (control: boolean): Promise<{ h: Harness; pluginDir: string }> => {
          const pluginDir = await mkdtemp(join(tmp, 'acme-'));

          for (const [path, text] of Object.entries(original)) {
            await mkdir(dirname(join(pluginDir, path)), { recursive: true });
            await writeFile(join(pluginDir, path), text);
          }

          const server = makeServer({ live: '3' });

          server.release();

          const real = createDefaultAppDeps(pluginDir);
          const held = hold();
          let applying: Promise<unknown> = Promise.resolve();
          const h = makeHarness({
            server,
            state: [stateEntry()],
            deps: {
              cwd: pluginDir,
              planMerge: real.planMerge,
              readTextFile: real.readTextFile,
              applyMerge: (plan, applyControl) => {
                const applied = applyMerge(plan, {
                  ...applyControl,
                  stat: async (path, follow) => {
                    await held.wait();

                    return follow ? stat(path, { bigint: true }) : lstat(path, { bigint: true });
                  },
                });

                applying = applied.catch(() => undefined);

                return applied;
              },
            },
          });

          await interruptDuringApply(h, { command: 'merge', options: { ...API_KEY } }, held, {
            control,
          });
          await applying;
          await drain();

          return { h, pluginDir };
        };

        try {
          const merged = await run(true);

          expect(await readFile(join(merged.pluginDir, 'src', 'a.js'), 'utf8')).toBe('a4');

          const { h, pluginDir } = await run(false);

          for (const [path, text] of Object.entries(original)) {
            expect(await readFile(join(pluginDir, path), 'utf8')).toBe(text);
          }

          expect((await readdir(pluginDir)).sort()).toStrictEqual(['kizen.json', 'src']);
          expect(h.store.writes).toBe(0);
          expect(h.exitCodes).toStrictEqual([130]);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      },
    );

    it('Ctrl+C while pulling starts no extraction', async () => {
      const run = async (control: boolean): Promise<Harness> => {
        const h = pushHarness();
        const held = hold();
        const download = h.server.api.downloadFile.getMockImplementation();

        h.server.api.downloadFile.mockImplementation(async (id) => {
          await held.wait();

          if (download === undefined) {
            throw new Error('no downloadFile fake');
          }

          return download(id);
        });

        const { flow } = startFlow(h, { command: 'pull', version: '2', options: { ...API_KEY } });

        await held.arrived;

        if (!control) {
          interrupt(flow.abort, h.deps.setExitCode);
        }

        held.release();
        await drain();

        return h;
      };

      expect((await run(true)).mocks.unzip).toHaveBeenCalled();

      const h = await run(false);

      expect(h.mocks.unzip).not.toHaveBeenCalled();
      expect(h.mocks.writeAppState).not.toHaveBeenCalled();
      expect(h.exitCodes).toStrictEqual([130]);
    });

    it('Ctrl+C at a confirm, then accept, starts no write', async () => {
      const h = pushHarness();
      const { flow, until } = startFlow(h, { command: 'push', options: { ...API_KEY } });
      const confirm = await until('confirm');

      interrupt(flow.abort, h.deps.setExitCode);
      flow.accept(confirm);
      await drain();

      nothingWritten(h);
      expect(h.exitCodes).toStrictEqual([130]);
    });

    it('Ctrl+C keeps exit code 130 even if a step fails afterwards', async () => {
      const h = pushHarness();
      let fail: () => void = () => undefined;
      const failing = new Promise<never>((_resolve, reject) => {
        fail = () => {
          reject(new KizenApiError('network_error', 'GET /business-apps failed', {}));
        };
      });

      h.server.api.listApps.mockReturnValue(failing);

      const { flow, phases } = startFlow(h, {
        command: 'push',
        options: { ...API_KEY, yes: true },
      });

      await vi.waitFor(() => {
        expect(h.server.api.listApps).toHaveBeenCalled();
      });
      interrupt(flow.abort, h.deps.setExitCode);
      fail();
      await drain();

      expect(h.exitCodes).toStrictEqual([130]);
      expect(phases.some((phase) => phase.type === 'error')).toBe(false);
    });

    it('abort during the lineage download writes nothing', async () => {
      const LOCAL = { 'kizen.json': '{"api_name":"acme","local":true}' };
      const run = async (request: AppRequest, control: boolean): Promise<Harness> => {
        const server = makeServer({ live: '3' });
        const previewId = server.pushPreviewFrom(USER, LOCAL, lineageOf('3'));
        const h = makeHarness({ server });
        const held = hold();
        const download = h.server.api.downloadFile.getMockImplementation();

        h.server.api.downloadFile.mockImplementation(async (id) => {
          if (id === previewId) {
            await held.wait();
          }

          if (download === undefined) {
            throw new Error('no downloadFile fake');
          }

          return download(id);
        });

        const { flow } = startFlow(h, request);

        await held.arrived;

        if (!control) {
          interrupt(flow.abort, h.deps.setExitCode);
        }

        held.release();
        await drain();

        return h;
      };

      const publishRequest: AppRequest = { command: 'publish', options: { ...API_KEY, yes: true } };

      expect((await run(publishRequest, true)).server.writes()).toStrictEqual(['promote:user-1']);

      const published = await run(publishRequest, false);

      nothingWritten(published);
      expect(published.exitCodes).toStrictEqual([130]);

      const pushRequest: AppRequest = { command: 'push', options: { ...API_KEY, yes: true } };

      expect((await run(pushRequest, true)).server.writes()).toContain('publish:false');

      const pushed = await run(pushRequest, false);

      nothingWritten(pushed);
      expect(pushed.exitCodes).toStrictEqual([130]);
    });

    it('Ctrl+C during a rollback upload saves no preview', async () => {
      const run = async (control: boolean): Promise<Harness> => {
        const h = pushHarness();
        const held = hold();
        const upload = h.server.api.uploadFile.getMockImplementation();

        h.server.api.uploadFile.mockImplementation(async (bytes, opts) => {
          if (opts.source === 'plugin_app_source_filesystem') {
            await held.wait();
          }

          if (upload === undefined) {
            throw new Error('no uploadFile fake');
          }

          return upload(bytes, opts);
        });
        await interruptDuringApply(
          h,
          { command: 'rollback', version: '2', options: { ...API_KEY } },
          held,
          { control },
        );

        return h;
      };

      expect((await run(true)).server.writes()).toContain('publish:false');

      const h = await run(false);

      expect(h.server.writes()).not.toContain('publish:false');
      expect(h.store.writes).toBe(0);
      expect(h.exitCodes).toStrictEqual([130]);
    });
  });

  it('withoutForceAdvice drops only the --force sentence', () => {
    expect(
      withoutForceAdvice(
        'Live is v4. Push this folder as your preview, then publish. Only if the user explicitly wants to publish the preview as it is: pass --force.',
      ),
    ).toBe('Live is v4. Push this folder as your preview, then publish.');
  });
});

describe('app UI flow: JS actions', () => {
  const LIVE_ACTIONS = ['hello_action', 'other_action'];

  const HELLO_LINK: StoredAssociation = {
    id: 'assoc-1',
    template: 'hello_action',
    objectId: CONTACTS.id,
    includePerformAction: true,
  };

  const OTHER_LINK: StoredAssociation = {
    id: 'assoc-9',
    template: 'other_action',
    objectId: DEALS.id,
    includePerformAction: false,
  };

  const actionsHarness = (server: ServerOptions = {}, options: HarnessOptions = {}): Harness =>
    makeHarness({
      server: makeServer({
        live: '3',
        jsActions: { '3': LIVE_ACTIONS },
        associations: [HELLO_LINK],
        objects: [CONTACTS, DEALS, OLD_DEALS],
        previews: {
          [USER]: yourPreview({
            def: withJsActions(definition(undefined, 'src-preview'), [
              ...LIVE_ACTIONS,
              'new_action',
            ]),
          }),
        },
        ...server,
      }),
      state: [stateEntry()],
      ...options,
    });

  const appWithActions = (): DeployablePlugin =>
    ({
      ...deployable(),
      artifacts: {
        custom_blocks: [],
        js_action_templates: [
          jsAction('hello_action'),
          jsAction('other_action'),
          jsAction('new_action'),
        ],
      },
    }) as unknown as DeployablePlugin;

  const UNLINKED_WARNING =
    "These JS actions aren't linked to any object: other_action. Link them: with `--json`, run an action's `linkArgv`, `linkMenuArgv` or `linkNoMenuArgv`; at a terminal, run `appbuilder app actions link` to pick them.";

  const choose = (
    flow: AppFlow,
    phase: Extract<AppPhase, { type: 'choose' }>,
    value: string,
  ): void => {
    const choice = phase.choices.find((candidate) => candidate.value === value);

    if (choice === undefined) {
      throw new Error(`no ${value} choice in ${shown(phase)}`);
    }

    flow.choose(phase, choice);
  };

  const headless = async (
    run: (h: Harness) => Promise<void>,
    harness: () => Harness,
  ): Promise<Record<string, unknown>> => {
    const h = harness();

    await run(h);

    return h.json();
  };

  it('interactive actions link with no args picks an action, an object and the menu setting, then writes once after confirm', async () => {
    const h = actionsHarness();
    const { flow, until } = startFlow(h, { command: 'actions link', options: { ...API_KEY } });

    const actions = await until('choose');

    expect(actions.title).toBe('JS action to link');
    expect(actions.choices.map((choice) => choice.label)).toStrictEqual([
      'hello_action (Action hello_action): linked',
      'other_action (Action other_action): not linked',
      "new_action (Action new_action): not in Live, links can't be listed",
    ]);
    expect(actions.initial).toBe('other_action');
    expect(actions.searchable).toBe(true);
    choose(flow, actions, 'other_action');

    const objects = await until('choose');

    expect(objects.title).toBe('Object for other_action');
    expect(objects.choices.map((choice) => [choice.value, choice.label])).toStrictEqual([
      [CONTACTS.id, 'Contacts (client_client)'],
      [DEALS.id, 'Deals (deal_pipeline)'],
      [OLD_DEALS.id, 'Deals (old_deals)'],
    ]);
    expect(objects.initial).toBe(CONTACTS.id);
    expect(objects.searchable).toBe(true);
    choose(flow, objects, DEALS.id);

    const menu = await until('choose');

    expect(menu.choices.map((choice) => choice.value)).toStrictEqual(['no', 'yes']);
    expect(menu.initial).toBe('no');
    choose(flow, menu, 'yes');

    const confirm = await until('confirm');

    expect(confirm.lines).toContain(
      'Link other_action to Deals (deal_pipeline), shown in its Perform Action menus.',
    );
    expect(confirm.prompt).toBe('Link it? (Y/n)');
    expect(confirm.isProduction).toBe(false);
    nothingWritten(h);

    flow.accept(confirm);

    const done = await until('done');

    expect(done.outcome).toMatchObject({
      title: '✓ Linked other_action to Deals',
      tone: 'success',
      next: 'appbuilder app actions list --profile credentials',
    });
    expect(h.server.writes()).toStrictEqual([`createAssociation:other_action:${DEALS.id}`]);
    expect(h.server.state.associations).toContainEqual(
      expect.objectContaining({
        template: 'other_action',
        objectId: DEALS.id,
        includePerformAction: true,
      }),
    );
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('an object argument that matches several objects is picked among them', async () => {
    const h = actionsHarness();
    const { flow, until } = startFlow(h, {
      command: 'actions link',
      action: 'other_action',
      object: 'Deals',
      options: { ...API_KEY, menu: false },
    });
    const objects = await until('choose');

    expect(objects.choices.map((choice) => choice.value)).toStrictEqual([DEALS.id, OLD_DEALS.id]);
    choose(flow, objects, OLD_DEALS.id);

    const confirm = await until('confirm');

    expect(confirm.lines).toContain(
      'Link other_action to Deals (old_deals), not shown in its Perform Action menus.',
    );
    nothingWritten(h);
  });

  it('interactive actions unlink picks an existing link and deletes it after confirm', async () => {
    const h = actionsHarness({ associations: [HELLO_LINK, OTHER_LINK] });
    const { flow, until } = startFlow(h, { command: 'actions unlink', options: { ...API_KEY } });
    const links = await until('choose');

    expect(links.title).toBe('Link to remove');
    expect(links.choices.map((choice) => [choice.value, choice.label])).toStrictEqual([
      ['assoc-1', 'hello_action → Contacts (client_client)'],
      ['assoc-9', 'other_action → Deals (deal_pipeline)'],
    ]);
    choose(flow, links, 'assoc-1');

    const confirm = await until('confirm');

    expect(confirm.lines).toContain('Unlink hello_action from Contacts (client_client).');
    expect(confirm.prompt).toBe('Unlink it? (Y/n)');
    nothingWritten(h);

    flow.accept(confirm);

    const done = await until('done');

    expect(done.outcome).toMatchObject({
      title: '✓ Unlinked hello_action from Contacts',
      next: 'appbuilder app actions list --profile credentials',
    });
    expect(h.server.writes()).toStrictEqual(['deleteAssociation:assoc-1']);
    expect(h.server.state.associations).toStrictEqual([OTHER_LINK]);
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('cancel at any actions picker or confirm writes nothing', async () => {
    const cancelAfter = async (
      request: AppRequest,
      picks: string[],
      at: 'choose' | 'confirm',
    ): Promise<void> => {
      const h = actionsHarness({ associations: [HELLO_LINK, OTHER_LINK] });
      const { flow, until } = startFlow(h, request);
      const label = `${request.command} after ${picks.join(', ') || 'nothing'}`;

      for (const value of picks) {
        choose(flow, await until('choose'), value);
      }

      if (at === 'choose') {
        flow.dismiss(await until('choose'));
      } else {
        await until('confirm');
        flow.cancel();
      }

      const error = await until('error');

      expect(error.view.message, label).toBe('Cancelled.');
      expect(h.exitCodes, label).toStrictEqual([1]);
      nothingWritten(h);
    };

    const link: AppRequest = { command: 'actions link', options: { ...API_KEY } };
    const unlink: AppRequest = { command: 'actions unlink', options: { ...API_KEY } };

    await cancelAfter(link, [], 'choose');
    await cancelAfter(link, ['other_action'], 'choose');
    await cancelAfter(link, ['other_action', DEALS.id], 'choose');
    await cancelAfter(link, ['other_action', DEALS.id, 'yes'], 'confirm');
    await cancelAfter(unlink, [], 'choose');
    await cancelAfter(unlink, ['assoc-1'], 'confirm');
    await cancelAfter(
      {
        command: 'actions link',
        action: 'other_action',
        object: 'client_client',
        options: { ...API_KEY },
      },
      [],
      'confirm',
    );
    await cancelAfter(
      {
        command: 'actions unlink',
        action: 'hello_action',
        object: 'client_client',
        options: { ...API_KEY },
      },
      [],
      'confirm',
    );
  });

  it('actions link on production needs the strict confirm', async () => {
    const onGo = (): Harness =>
      actionsHarness(
        {},
        { credentials: { environment: 'go' }, state: [stateEntry({ environment: 'go' })] },
      );
    const request = (options: Record<string, unknown>): AppRequest => ({
      command: 'actions link',
      action: 'other_action',
      object: 'client_client',
      options: { ...API_KEY, ...options },
    });

    const asked = onGo();
    const confirm = await startFlow(asked, request({})).until('confirm');

    expect(confirm.isProduction).toBe(true);
    expect(confirm.productionPrompt).toBe('Type y to link it on production (y/N)');
    nothingWritten(asked);

    const yesOnly = onGo();

    await startFlow(yesOnly, request({ yes: true })).until('confirm');
    nothingWritten(yesOnly);

    const allowed = onGo();

    await startFlow(allowed, request({ yes: true, allowProduction: true })).until('done');
    expect(allowed.server.writes()).toStrictEqual([
      `createAssociation:other_action:${CONTACTS.id}`,
    ]);

    const unlink = await startFlow(onGo(), {
      command: 'actions unlink',
      action: 'hello_action',
      object: 'client_client',
      options: { ...API_KEY, yes: true },
    }).until('confirm');

    expect(unlink.isProduction).toBe(true);
    expect(unlink.productionPrompt).toBe('Type y to unlink it on production (y/N)');
  });

  it('interactive push, publish and versions show the unlinked-actions warning', async () => {
    const pushHarness = (): Harness => actionsHarness({}, { deployable: appWithActions() });
    const pushDry = await headless(
      (h) => runAppPushHeadless({ json: true, ...API_KEY }, h.deps),
      pushHarness,
    );
    const pushApplied = await headless(
      (h) => runAppPushHeadless({ json: true, ...API_KEY, yes: true }, h.deps),
      pushHarness,
    );
    const pushed = pushHarness();
    const pushRun = startFlow(pushed, { command: 'push', options: { ...API_KEY } });
    const pushConfirm = await pushRun.until('confirm');

    expect(pushConfirm.warnings).toStrictEqual(pushDry.warnings);
    expect(pushConfirm.warnings).toContain(UNLINKED_WARNING);
    expect(pushConfirm.lines).toEqual(
      expect.arrayContaining([
        'JS actions:',
        '  other_action (Action other_action): not linked (hint: client_client)',
      ]),
    );
    pushRun.flow.accept(pushConfirm);

    const next = await pushRun.until('choose');

    expect(next.choices.map((choice) => choice.label)).toStrictEqual([
      'Link JS actions now',
      'Done',
    ]);
    expect(next.above).toMatchObject({
      type: 'done',
      outcome: {
        title: '✓ Saved your preview of Acme (acme_abc123)',
        warnings: pushApplied.warnings,
      },
    });
    choose(pushRun.flow, next, 'link-actions');

    const actions = await pushRun.until('choose');

    expect(actions.title).toBe('JS action to link');
    choose(pushRun.flow, actions, 'new_action');
    choose(pushRun.flow, await pushRun.until('choose'), DEALS.id);
    choose(pushRun.flow, await pushRun.until('choose'), 'no');

    const linkConfirm = await pushRun.until('confirm');

    expect(linkConfirm.prompt).toBe('Link it? (Y/n)');
    expect(
      pushed.server.calls.filter((call) => call.startsWith('createAssociation')),
    ).toStrictEqual([]);
    pushRun.flow.accept(linkConfirm);
    expect((await pushRun.until('done')).outcome.title).toBe('✓ Linked new_action to Deals');
    expect(pushed.server.writes()).toContain(`createAssociation:new_action:${DEALS.id}`);
    expect(pushed.exitCodes).toStrictEqual([]);

    const publishDry = await headless(
      (h) => runAppPublishHeadless({ json: true, ...API_KEY }, h.deps),
      actionsHarness,
    );
    const publishApplied = await headless(
      (h) => runAppPublishHeadless({ json: true, ...API_KEY, yes: true }, h.deps),
      actionsHarness,
    );
    const published = actionsHarness();
    const publishRun = startFlow(published, { command: 'publish', options: { ...API_KEY } });
    const publishConfirm = await publishRun.until('confirm');

    expect(publishConfirm.warnings).toStrictEqual(publishDry.warnings);
    expect(publishConfirm.warnings).toContain(UNLINKED_WARNING);
    publishRun.flow.accept(publishConfirm);

    const afterPublish = await publishRun.until('choose');

    expect(afterPublish.above).toMatchObject({
      type: 'done',
      outcome: { title: '✓ Published Live v4 of Acme', warnings: publishApplied.warnings },
    });
    expect(publishApplied.warnings).toContain(
      "These JS actions aren't linked to any object: other_action, new_action. Link them: with `--json`, run an action's `linkArgv`, `linkMenuArgv` or `linkNoMenuArgv`; at a terminal, run `appbuilder app actions link` to pick them.",
    );
    choose(publishRun.flow, afterPublish, 'finish');
    expect((await publishRun.until('done')).outcome.title).toBe('✓ Published Live v4 of Acme');
    expect(published.exitCodes).toStrictEqual([]);

    const versionsJson = await headless(
      (h) => runAppVersionsHeadless({ json: true, ...API_KEY }, h.deps),
      actionsHarness,
    );
    const looked = actionsHarness();
    const versionsRun = startFlow(looked, { command: 'versions', options: { ...API_KEY } });
    const afterVersions = await versionsRun.until('choose');

    expect(afterVersions.above).toMatchObject({ type: 'report', warnings: versionsJson.warnings });
    expect(versionsJson.warnings).toContain(UNLINKED_WARNING);
    expect(afterVersions.above?.type === 'report' && afterVersions.above.lines).toEqual(
      expect.arrayContaining([
        'JS actions:',
        '  hello_action (Action hello_action): linked to Contacts (client_client, menu: on)',
      ]),
    );
    versionsRun.flow.dismiss(afterVersions);
    await versionsRun.until('report');
    expect(looked.exitCodes).toStrictEqual([]);
    nothingWritten(looked);

    const linked = actionsHarness({
      jsActions: { '3': ['hello_action'] },
      previews: {},
    });

    await startFlow(linked, { command: 'versions', options: { ...API_KEY } }).until('report');
  });

  it('interactive first push reports its actions as preview-only, checked after the push, and offers linking them', async () => {
    const firstPush = (): Harness =>
      makeHarness({
        server: makeServer({ exists: false, live: null, objects: [CONTACTS, DEALS] }),
        deployable: appWithActions(),
      });
    const applied = await headless(
      (h) => runAppPushHeadless({ json: true, ...API_KEY, yes: true }, h.deps),
      firstPush,
    );
    const h = firstPush();
    const run = startFlow(h, { command: 'push', options: { ...API_KEY } });

    run.flow.accept(await run.until('confirm'));

    const next = await run.until('choose');

    expect(next.choices.map((choice) => choice.label)).toStrictEqual([
      'Link JS actions now',
      'Done',
    ]);
    expect(next.above).toMatchObject({
      type: 'done',
      outcome: {
        title: '✓ Saved your preview of Acme (acme_abc123)',
        warnings: applied.warnings,
      },
    });
    expect(next.above?.type === 'done' && next.above.outcome.lines).toEqual(
      expect.arrayContaining([
        'JS actions:',
        "  new_action (Action new_action): not in Live, so its links can't be listed",
      ]),
    );

    choose(run.flow, next, 'link-actions');
    choose(run.flow, await run.until('choose'), 'new_action');
    choose(run.flow, await run.until('choose'), DEALS.id);
    choose(run.flow, await run.until('choose'), 'no');
    run.flow.accept(await run.until('confirm'));
    expect((await run.until('done')).outcome.title).toBe('✓ Linked new_action to Deals');
    expect(h.exitCodes).toStrictEqual([]);
  });

  it('the interactive link and unlink confirms warn that a change to a Live action reaches Live users', async () => {
    const liveWarning = (action: string, object: string): string =>
      `${action} is in the Live version, so this change to its link to ${object} applies to everyone using Live as soon as it's made.`;

    const linked = actionsHarness();
    const linkRun = startFlow(linked, {
      command: 'actions link',
      action: 'other_action',
      object: 'deal_pipeline',
      options: { ...API_KEY },
    });
    const linkConfirm = await linkRun.until('confirm');

    expect(linkConfirm.warnings).toStrictEqual([liveWarning('other_action', 'deal_pipeline')]);
    linkRun.flow.accept(linkConfirm);
    expect((await linkRun.until('done')).outcome.warnings).toStrictEqual([
      liveWarning('other_action', 'deal_pipeline'),
    ]);

    const unlinkRun = startFlow(actionsHarness(), {
      command: 'actions unlink',
      action: 'hello_action',
      object: 'client_client',
      options: { ...API_KEY },
    });

    expect((await unlinkRun.until('confirm')).warnings).toStrictEqual([
      liveWarning('hello_action', 'client_client'),
    ]);

    const previewRun = startFlow(actionsHarness(), {
      command: 'actions link',
      action: 'new_action',
      object: 'deal_pipeline',
      options: { ...API_KEY },
    });

    expect((await previewRun.until('confirm')).warnings).toStrictEqual([]);
  });

  it('a picked "Link JS actions now" asks before writing, whatever the run\'s --yes and --allow-production', async () => {
    const linkNow = async (
      h: Harness,
      request: AppRequest,
    ): Promise<{ run: FlowRun; confirm: PhaseOf<'confirm'> }> => {
      const run = startFlow(h, request);

      choose(run.flow, await run.until('choose'), 'link-actions');
      choose(run.flow, await run.until('choose'), 'other_action');
      choose(run.flow, await run.until('choose'), DEALS.id);
      choose(run.flow, await run.until('choose'), 'no');

      return { run, confirm: await run.until('confirm') };
    };

    const created = (h: Harness): string[] =>
      h.server.writes().filter((call) => call.startsWith('createAssociation'));
    const onGo = (): Harness =>
      actionsHarness(
        {},
        {
          credentials: { environment: 'go' },
          state: [stateEntry({ environment: 'go' })],
          deployable: appWithActions(),
        },
      );

    for (const command of ['push', 'publish'] as const) {
      const staging = actionsHarness({}, { deployable: appWithActions() });
      const yes = await linkNow(staging, { command, options: { ...API_KEY, yes: true } });

      expect(staging.server.writes().length, command).toBeGreaterThan(0);
      expect(yes.confirm.isProduction, command).toBe(false);
      expect(yes.confirm.prompt, command).toBe('Link it? (Y/n)');
      expect(created(staging), command).toStrictEqual([]);

      yes.run.flow.accept(yes.confirm);
      await yes.run.until('done');
      expect(created(staging), command).toStrictEqual([
        `createAssociation:other_action:${DEALS.id}`,
      ]);

      const go = onGo();
      const allowed = await linkNow(go, {
        command,
        options: { ...API_KEY, yes: true, allowProduction: true },
      });

      expect(allowed.confirm.isProduction, command).toBe(true);
      expect(allowed.confirm.productionPrompt, command).toBe(
        'Type y to link it on production (y/N)',
      );
      expect(created(go), command).toStrictEqual([]);
    }
  });

  it("a picked link of a preview-only action the caller isn't using shows the active-preview hint", async () => {
    const h = actionsHarness({ active: { [USER]: null } });
    const { flow, until } = startFlow(h, {
      command: 'actions link',
      action: 'new_action',
      object: 'deal_pipeline',
      options: { ...API_KEY },
    });

    flow.accept(await until('confirm'));

    const error = await until('error');

    expect(error.view.hint).toBe(PREVIEW_ONLY_LINK_HINT('new_action'));
    expect(h.server.state.associations).toStrictEqual([HELLO_LINK]);
  });
});

describe('app UI flow: preview delete', () => {
  const previewHarness = (options: HarnessOptions = {}): Harness =>
    makeHarness({
      server: makeServer({
        live: '3',
        previews: {
          [USER]: yourPreview(),
          [OTHER]: yourPreview({ ownerName: 'Bo B', updated: '2026-10-21T00:00:00.000Z' }),
        },
      }),
      state: [stateEntry()],
      ...options,
    });

  const drain = async (): Promise<void> => {
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('preview delete asks before deleting, strictly on production, and cancel deletes nothing', async () => {
    const h = previewHarness();
    const { flow, until } = startFlow(h, { command: 'preview delete', options: { ...API_KEY } });
    const confirm = await until('confirm');

    expect(confirm.isProduction).toBe(false);
    expect(confirm.prompt).toBe('Delete it? (Y/n)');
    expect(confirm.lines).toStrictEqual([
      'Environment: staging',
      'Business: biz',
      'App: Acme (acme_abc123)',
      'Live: v3',
      'Preview: Ada L (yours), last updated 2026-10-20T00:00:00.000Z',
      'Active users: 1',
      'Installs: 1',
      'Delete: this preview',
    ]);
    expect(confirm.warnings).toStrictEqual([]);
    nothingWritten(h);

    flow.accept(confirm);

    const done = await until('done');

    expect(done.outcome).toMatchObject({
      title: '✓ Deleted your preview of Acme',
      tone: 'success',
      next: 'appbuilder app push --profile credentials',
    });
    expect(h.server.writes()).toStrictEqual([`deletePreview:${USER}`]);
    expect(h.entry()?.previewSourcePackageId).toBeUndefined();
    expect(h.exitCodes).toStrictEqual([]);

    const other = previewHarness();
    const otherRun = startFlow(other, {
      command: 'preview delete',
      options: { ...API_KEY, owner: OTHER },
    });
    const otherConfirm = await otherRun.until('confirm');

    expect(otherConfirm.lines).toContain(
      `Preview: Bo B (${OTHER}), last updated 2026-10-21T00:00:00.000Z`,
    );
    expect(otherConfirm.warnings).toStrictEqual([
      NOT_YOUR_PREVIEW_WARNING('Bo B'),
      PREVIEW_IN_USE_WARNING(1, false),
    ]);
    otherRun.flow.cancel();

    const cancelled = await otherRun.until('error');

    expect(cancelled.view.message).toBe('Cancelled.');
    expect(other.exitCodes).toStrictEqual([1]);
    nothingWritten(other);

    const interrupted = previewHarness();
    const interruptedRun = startFlow(interrupted, {
      command: 'preview delete',
      options: { ...API_KEY },
    });
    const interruptedConfirm = await interruptedRun.until('confirm');

    interrupt(interruptedRun.flow.abort, interrupted.deps.setExitCode);
    interruptedRun.flow.accept(interruptedConfirm);
    await drain();
    nothingWritten(interrupted);
    expect(interrupted.exitCodes).toStrictEqual([130]);

    const onGo = (): Harness =>
      previewHarness({
        credentials: { environment: 'go' },
        state: [stateEntry({ environment: 'go' })],
      });
    const asked = onGo();
    const strict = await startFlow(asked, {
      command: 'preview delete',
      options: { ...API_KEY, yes: true },
    }).until('confirm');

    expect(strict.isProduction).toBe(true);
    expect(strict.productionPrompt).toBe('Type y to delete it on production (y/N)');
    nothingWritten(asked);

    const allowed = onGo();

    await startFlow(allowed, {
      command: 'preview delete',
      options: { ...API_KEY, yes: true, allowProduction: true },
    }).until('done');
    expect(allowed.server.writes()).toStrictEqual([`deletePreview:${USER}`]);

    const dry = previewHarness();
    const dryDone = await startFlow(dry, {
      command: 'preview delete',
      options: { ...API_KEY, dryRun: true },
    }).until('done');

    expect(dryDone.outcome).toMatchObject({ title: 'Dry run: nothing was written.' });
    nothingWritten(dry);
  });

  it('preview delete asks before deleting the whole app even with --yes, and says so when the app survived', async () => {
    const onlyVersion = (): Harness =>
      makeHarness({
        server: makeServer({ live: null, previews: { [USER]: yourPreview() } }),
        state: [stateEntry()],
      });

    const h = onlyVersion();
    const { flow, until } = startFlow(h, {
      command: 'preview delete',
      options: { ...API_KEY, yes: true },
    });
    const confirm = await until('confirm');

    expect(confirm.warnings).toStrictEqual([DELETES_APP_WARNING('Acme')]);
    expect(confirm.lines).toContain('Delete: this preview, and with it the app');
    nothingWritten(h);

    h.server.state.previews.set(
      OTHER,
      yourPreview({ ownerName: 'Bo B', updated: '2026-10-21T00:00:00.000Z' }),
    );
    flow.accept(confirm);

    const done = await until('done');

    expect(h.server.writes()).toStrictEqual([`deletePreview:${USER}`]);
    expect(h.server.state.exists).toBe(true);
    expect(done.outcome.title).toBe('✓ Deleted your preview of Acme');
    expect(done.outcome.lines).toContain("Acme has another version now, so it wasn't deleted.");
    expect(done.outcome.lines).toContain('Delete: this preview');
    expect(done.outcome.lines).not.toContain('Delete: this preview, and with it the app');
    expect(done.outcome.warnings).toStrictEqual([]);

    const consented = onlyVersion();

    await startFlow(consented, {
      command: 'preview delete',
      options: { ...API_KEY, yes: true, deleteApp: true },
    }).until('done');
    expect(consented.server.writes()).toStrictEqual([`deletePreview:${USER}`]);
    expect(consented.server.state.exists).toBe(false);
  });

  it('an app-deleting preview delete needs a typed y even off production', async () => {
    const confirmOf = (
      previews: Record<string, ReturnType<typeof yourPreview>>,
      options: HarnessOptions = {},
    ): Promise<PhaseOf<'confirm'>> =>
      startFlow(
        makeHarness({
          server: makeServer({ live: null, previews }),
          state: [stateEntry()],
          ...options,
        }),
        { command: 'preview delete', options: { ...API_KEY } },
      ).until('confirm');

    const staging = await confirmOf({ [USER]: yourPreview() });

    expect(staging.isProduction).toBe(false);
    expect(staging.strict).toBe(true);
    expect(staging.productionPrompt).toBe('Type y to delete the preview and the whole app (y/N)');

    const go = await confirmOf(
      { [USER]: yourPreview() },
      { credentials: { environment: 'go' }, state: [stateEntry({ environment: 'go' })] },
    );

    expect(go.isProduction).toBe(true);
    expect(go.strict).toBe(true);
    expect(go.productionPrompt).toBe(
      'Type y to delete the preview and the whole app on production (y/N)',
    );

    const stays = await confirmOf({
      [USER]: yourPreview(),
      [OTHER]: yourPreview({ ownerName: 'Bo B' }),
    });

    expect(stays.strict).toBe(false);
    expect(stays.prompt).toBe('Delete it? (Y/n)');
  });
});

describe('app UI flow: the preview base on the server', () => {
  const LOCAL = { 'kizen.json': '{"api_name":"acme","local":true}' };
  const DIVERGED = { ...LOCAL, 'src/new.js': 'x' };

  it("publish from a machine with no state uses the preview's server lineage and succeeds when Live hasn't moved: at a terminal", async () => {
    const server = makeServer({ live: '3' });

    server.pushPreviewFrom(USER, LOCAL, lineageOf('3'));

    const h = makeHarness({ server });
    const { flow, until } = startFlow(h, { command: 'publish', options: { ...API_KEY } });
    const confirm = await until('confirm');

    expect(confirm.lines).toContain(
      "Conflict check: none (your preview's base v3, read from its source on the server)",
    );
    nothingWritten(h);
    flow.accept(confirm);

    const done = await until('done');

    expect(done.outcome.title).toBe('✓ Published Live v4 of Acme');
    expect(h.server.state.live).toBe('4');
  });

  it('push with a diverged folder and a preview with lineage offers the continue-preview choice and never auto-selects it: at a terminal', async () => {
    const server = makeServer({ live: '4' });

    server.pushPreviewFrom(USER, LOCAL, lineageOf('3'));

    const withYes = makeHarness({ server, files: DIVERGED });
    const asked = await startFlow(withYes, {
      command: 'push',
      options: { ...API_KEY, yes: true },
    }).until('choose');

    expect(asked.choices.map((choice) => choice.value)).toContain('preview');
    nothingWritten(withYes);

    const h = makeHarness({ server, files: DIVERGED });
    const { flow, until } = startFlow(h, { command: 'push', options: { ...API_KEY } });
    const choose = await until('choose');

    expect(choose.choices.map((choice) => choice.value)).toStrictEqual([
      'merge',
      'accept',
      'preview',
    ]);
    expect(choose.initial).toBeUndefined();
    expect(choose.choices[2]?.label).toBe(CONTINUE_PREVIEW_LABEL('3'));
    nothingWritten(h);

    const preview = choose.choices.find((choice) => choice.value === 'preview');

    if (preview === undefined) {
      throw new Error('no preview choice');
    }

    flow.choose(choose, preview);

    const confirm = await until('confirm');

    expect(confirm.lines).toContain(
      "Base: v3 (continues your preview; your preview's base, read from the server)",
    );
    nothingWritten(h);
    flow.accept(confirm);
    await until('done');

    expect(h.server.writes().filter((call) => call === 'publish:false')).toHaveLength(1);
    expect(h.entry()).toMatchObject({
      folderBaseLiveVersion: '3',
      folderBaseSourcePackageId: 'src-v3',
    });
  });
});
