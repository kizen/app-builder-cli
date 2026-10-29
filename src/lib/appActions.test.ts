import type { DeployablePlugin } from '@kizenapps/packager';
import { describe, expect, it, vi } from 'vitest';
import {
  ALREADY_LINKED_LIVE_WARNING,
  ALREADY_LINKED_WARNING,
  applyActionLink,
  applyActionUnlink,
  planActionLink,
  planActionUnlink,
  PREVIEW_ONLY_LINK_HINT,
  UNLISTED_LINK_NOTICE,
  UNLISTED_UNLINK_HINT,
} from './appActions.js';
import { loadAppContext, type AppContext, type AppDeps } from './appFlow.js';
import {
  runAppActionsLinkHeadless,
  runAppActionsListHeadless,
  runAppActionsUnlinkHeadless,
  runAppPublishHeadless,
  runAppPushHeadless,
  runAppVersionsHeadless,
} from './appHeadless.js';
import type { Environment } from './credentials.js';
import { KizenApiError } from './kizenClient.js';
import type { KizenClient } from './kizenTypes.js';
import {
  API_KEY,
  APP_API,
  BIZ,
  CONTACTS,
  CRED_ARGS,
  DEALS,
  definition,
  deployable,
  JSON_ARGS,
  jsAction,
  makeHarness,
  makeServer,
  OLD_DEALS,
  OTHER,
  publishedBody,
  stateEntry,
  USER,
  withJsActions,
  yourPreview,
  type Harness,
  type HarnessOptions,
  type ServerOptions,
  type StoredAssociation,
} from '../test/appHarness.js';

type Extra = Record<string, unknown>;

const listActions = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppActionsListHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

const link = (h: Harness, action: string, object: string, extra: Extra = {}): Promise<void> =>
  runAppActionsLinkHeadless(action, object, { json: true, ...API_KEY, ...extra }, h.deps);

const unlink = (h: Harness, action: string, object: string, extra: Extra = {}): Promise<void> =>
  runAppActionsUnlinkHeadless(action, object, { json: true, ...API_KEY, ...extra }, h.deps);

const push = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppPushHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

const publish = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppPublishHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

const versions = (h: Harness, extra: Extra = {}): Promise<void> =>
  runAppVersionsHeadless({ json: true, ...API_KEY, ...extra }, h.deps);

const HELLO_LINK: StoredAssociation = {
  id: 'assoc-1',
  template: 'hello_action',
  objectId: CONTACTS.id,
  includePerformAction: true,
};

const NEW_LINK: StoredAssociation = {
  id: 'assoc-2',
  template: 'new_action',
  objectId: CONTACTS.id,
  includePerformAction: false,
};

const LIVE_ACTIONS = ['hello_action', 'other_action'];

const actionServer = (overrides: ServerOptions = {}): ReturnType<typeof makeServer> =>
  makeServer({
    live: '3',
    jsActions: { '3': LIVE_ACTIONS },
    associations: [HELLO_LINK, NEW_LINK],
    objects: [CONTACTS, DEALS, OLD_DEALS],
    previews: {
      [USER]: yourPreview({
        def: withJsActions(definition(undefined, 'src-preview'), [...LIVE_ACTIONS, 'new_action']),
      }),
    },
    ...overrides,
  });

const harness = (overrides: ServerOptions = {}, options: HarnessOptions = {}): Harness =>
  makeHarness({ server: actionServer(overrides), state: [stateEntry()], ...options });

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

const pushedApp = (): DeployablePlugin =>
  ({
    ...deployable(),
    base_config: {
      setup_assistant: {
        fields: [{ key: 'region', type: 'text', label: 'Region' }],
        actions: [{ ...jsAction('hello_action'), script: 'minified' }],
      },
    },
    artifacts: {
      custom_blocks: [],
      js_action_templates: [
        jsAction('hello_action'),
        jsAction('other_action'),
        jsAction('new_action'),
      ],
    },
  }) as unknown as DeployablePlugin;

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

const statuses = (result: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    (result.jsActions as { actions: { apiName: string; status: string }[] }).actions.map(
      (action) => [action.apiName, action.status],
    ),
  );

describe('the JS action check on push, publish and versions', () => {
  it('push warns about unlinked JS actions with runnable next steps, and keeps the setup assistant as is', async () => {
    const h = harness({}, { deployable: pushedApp() });

    await push(h, { yes: true });

    const result = h.json();

    expect(h.exitCodes).toStrictEqual([]);
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(publishedBody(h.server).base_config).toStrictEqual(pushedApp().base_config);
    expect(result.warnings).toStrictEqual([
      "These JS actions aren't linked to any object: other_action. Link them: with `--json`, run an action's `linkArgv`, `linkMenuArgv` or `linkNoMenuArgv`; at a terminal, run `appbuilder app actions link` to pick them.",
      "These JS actions aren't in the Live version, so their links can't be listed and they may not be linked to any object: new_action. To make sure, link them: with `--json`, run an action's `linkArgv`, `linkMenuArgv` or `linkNoMenuArgv`; at a terminal, run `appbuilder app actions link` to pick them.",
    ]);
    expect(result.jsActions).toMatchObject({
      status: 'checked',
      liveVersion: '3',
      actions: [
        {
          apiName: 'hello_action',
          status: 'linked',
          inLive: true,
          links: [
            {
              id: 'assoc-1',
              objectId: CONTACTS.id,
              objectName: 'client_client',
              label: 'Contacts',
              includePerformAction: true,
            },
          ],
        },
        { apiName: 'other_action', status: 'unlinked', inLive: true, links: [] },
        { apiName: 'new_action', status: 'unknown', inLive: false, links: [] },
      ],
    });

    const actionNext = [
      { step: 'actions', argv: ['appbuilder', 'app', 'actions', 'list', ...JSON_ARGS] },
      {
        step: 'link',
        argv: [
          'appbuilder',
          'app',
          'actions',
          'link',
          'other_action',
          'client_client',
          ...JSON_ARGS,
        ],
      },
    ];

    expect(result.next).toStrictEqual([
      ...actionNext,
      { step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] },
    ]);
    expect((result.jsActions as { next: unknown }).next).toStrictEqual(actionNext);

    const dry = harness({}, { deployable: pushedApp() });

    await push(dry);

    const planned = dry.json();

    expect(planned).toMatchObject({ dryRun: true, next: [], warnings: result.warnings });
    expect((planned.jsActions as { next: unknown }).next).toStrictEqual(actionNext);
    expect(dry.server.writes()).toStrictEqual([]);
  });

  it('a template missing from Live is reported as unknown, not unlinked', async () => {
    const h = harness();

    await versions(h);

    const result = h.json();

    expect(statuses(result)).toStrictEqual({
      hello_action: 'linked',
      other_action: 'unlinked',
      new_action: 'unknown',
    });
    expect(result.warnings).toContain(
      "These JS actions aren't in the Live version, so their links can't be listed and they may not be linked to any object: new_action. To make sure, link them: with `--json`, run an action's `linkArgv`, `linkMenuArgv` or `linkNoMenuArgv`; at a terminal, run `appbuilder app actions link` to pick them.",
    );
    expect(JSON.stringify(result.warnings)).not.toContain(
      "aren't linked to any object: new_action",
    );

    const published = harness();

    await publish(published, { yes: true });

    expect(statuses(published.json())).toStrictEqual({
      hello_action: 'linked',
      other_action: 'unlinked',
      new_action: 'linked',
    });
  });

  it('an app with no Live version reports every action unknown and lists no links', async () => {
    const h = harness({ live: null, releases: [] });

    await versions(h);

    expect(h.json().jsActions).toMatchObject({ status: 'no_live_version' });
    expect(statuses(h.json())).toStrictEqual({
      hello_action: 'unknown',
      other_action: 'unknown',
      new_action: 'unknown',
    });
    expect(h.server.calls).not.toContain('listAssociations');
  });

  it('a first push of an app not on this business: unlinked in the dry run, preview-only once applied, and linked right away', async () => {
    const first = (): Harness =>
      makeHarness({ server: makeServer({ exists: false, live: null }), deployable: pushedApp() });

    const dry = first();

    await push(dry);

    expect(dry.json()).toMatchObject({
      ok: true,
      dryRun: true,
      jsActions: { status: 'not_installed' },
    });
    expect(statuses(dry.json())).toStrictEqual({
      hello_action: 'unlinked',
      other_action: 'unlinked',
      new_action: 'unlinked',
    });

    const h = first();

    await push(h, { yes: true });

    const result = h.json();

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      jsActions: { status: 'no_live_version', liveVersion: null },
    });
    expect(statuses(result)).toStrictEqual({
      hello_action: 'unknown',
      other_action: 'unknown',
      new_action: 'unknown',
    });
    expect(
      (result.jsActions as { actions: { inLive: boolean }[] }).actions.map(
        (action) => action.inLive,
      ),
    ).toStrictEqual([false, false, false]);
    const listStep = {
      step: 'actions',
      argv: ['appbuilder', 'app', 'actions', 'list', ...JSON_ARGS],
    };

    expect((result.jsActions as { next: unknown }).next).toStrictEqual([listStep]);
    expect(result.next).toStrictEqual([
      listStep,
      { step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] },
    ]);
    expect(result.warnings).toStrictEqual([
      "These JS actions aren't in the Live version, so their links can't be listed and they may not be linked to any object: hello_action, other_action, new_action. To make sure, link them: with `--json`, run an action's `linkArgv`, `linkMenuArgv` or `linkNoMenuArgv`; at a terminal, run `appbuilder app actions link` to pick them.",
    ]);
    expect(h.server.calls.filter((call) => call === 'listApps')).toHaveLength(2);
    expect(h.server.calls).not.toContain('listAssociations');

    h.reset();
    await link(h, 'new_action', 'client_client', { yes: true });

    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      change: 'create',
      status: 'created',
    });
    expect(h.server.state.associations).toMatchObject([
      { template: 'new_action', objectId: CONTACTS.id, includePerformAction: false },
    ]);
  });

  it('an app without JS actions makes no extra request', async () => {
    const h = harness();

    await push(h, { yes: true });

    expect(h.json()).toMatchObject({ ok: true, jsActions: { status: 'checked', actions: [] } });
    expect(h.server.calls).not.toContain('listAssociations');
    expect(h.server.calls.filter((call) => call.startsWith('getVersion'))).toStrictEqual([
      'getVersion:3',
    ]);
  });

  it('a failed association list never fails push or publish', async () => {
    const failing = (): Harness => {
      const h = harness({}, { deployable: pushedApp() });

      h.server.api.listActionAssociations.mockRejectedValue(
        new KizenApiError('api_error', 'GET /associations failed with 500', { status: 500 }),
      );

      return h;
    };

    const notice =
      "Couldn't check which JS actions are linked to objects: GET /associations failed with 500. Run `appbuilder app actions list` to check.";

    for (const [name, run] of [
      ['push', (h: Harness) => push(h, { yes: true })],
      ['push dry run', (h: Harness) => push(h)],
      ['publish', (h: Harness) => publish(h, { yes: true })],
      ['publish dry run', (h: Harness) => publish(h)],
    ] as const) {
      const h = failing();

      await run(h);

      const result = h.json();

      expect(h.exitCodes, name).toStrictEqual([]);
      expect(result, name).toMatchObject({ ok: true, jsActions: { status: 'failed' } });
      expect(result.notices, name).toContain(notice);
      expect(h.stderr.join(''), name).toContain(notice);
    }

    const pushed = failing();

    await push(pushed, { yes: true });
    expect(pushed.server.writes()).toContain('publish:false');

    const published = failing();

    await publish(published, { yes: true });
    expect(published.server.writes()).toContain(`promote:${USER}`);

    const listed = failing();

    await versions(listed);
    expect(listed.json()).toMatchObject({ ok: true, jsActions: { status: 'failed' } });
    expect(listed.exitCodes).toStrictEqual([]);
  });

  it('versions lists the actions and suggests linking the unlinked ones', async () => {
    const h = harness();

    await versions(h);

    expect(h.json().next).toStrictEqual([
      { step: 'push', argv: ['appbuilder', 'app', 'push', ...JSON_ARGS] },
      { step: 'publish', argv: ['appbuilder', 'app', 'publish', ...JSON_ARGS] },
      { step: 'actions', argv: ['appbuilder', 'app', 'actions', 'list', ...JSON_ARGS] },
      {
        step: 'link',
        argv: [
          'appbuilder',
          'app',
          'actions',
          'link',
          'other_action',
          'client_client',
          ...JSON_ARGS,
        ],
      },
    ]);
  });
});

describe('publish 400 on push', () => {
  it('surfaces as api_error with the server message and no hint, whichever rule it names', async () => {
    for (const error of [
      new KizenApiError('api_error', 'POST /publish failed with 400: name: required', {
        status: 400,
        details: { name: ['required'] },
      }),
      new KizenApiError('api_error', 'POST /publish failed with 400: base_config: bad action', {
        status: 400,
        details: {
          base_config: [{ rule: 'structure/setup-assistant-action-ref', message: 'bad action' }],
        },
      }),
    ]) {
      const h = harness({}, { deployable: pushedApp() });

      h.server.api.publish.mockRejectedValueOnce(error);

      await push(h, { yes: true });

      expect(h.json()).toStrictEqual({ ok: false, code: 'api_error', message: error.message });
      expect(h.exitCodes).toStrictEqual([1]);
    }
  });
});

describe('app actions list', () => {
  it('lists each action with its status, links and link dry runs', async () => {
    const h = harness();

    await listActions(h);

    const result = h.json();

    expect(result).toMatchObject({ ok: true, published: true, status: 'checked' });
    const linkArgvs = (action: string): Record<string, string[]> => ({
      linkArgv: ['appbuilder', 'app', 'actions', 'link', action, '<object>', ...JSON_ARGS],
      linkMenuArgv: [
        'appbuilder',
        'app',
        'actions',
        'link',
        action,
        '<object>',
        '--menu',
        ...JSON_ARGS,
      ],
      linkNoMenuArgv: [
        'appbuilder',
        'app',
        'actions',
        'link',
        action,
        '<object>',
        '--no-menu',
        ...JSON_ARGS,
      ],
    });

    expect(result.actions).toStrictEqual([
      {
        apiName: 'hello_action',
        name: 'Action hello_action',
        hintObjectName: 'client_client',
        status: 'linked',
        inLive: true,
        links: [
          {
            id: 'assoc-1',
            objectId: CONTACTS.id,
            objectName: 'client_client',
            label: 'Contacts',
            includePerformAction: true,
            unlinkArgv: [
              'appbuilder',
              'app',
              'actions',
              'unlink',
              'hello_action',
              CONTACTS.id,
              ...JSON_ARGS,
            ],
          },
        ],
        ...linkArgvs('hello_action'),
      },
      {
        apiName: 'other_action',
        name: 'Action other_action',
        hintObjectName: 'client_client',
        status: 'unlinked',
        inLive: true,
        links: [],
        ...linkArgvs('other_action'),
      },
      {
        apiName: 'new_action',
        name: 'Action new_action',
        hintObjectName: 'client_client',
        status: 'unknown',
        inLive: false,
        links: [],
        ...linkArgvs('new_action'),
      },
    ]);
    expect(result.next).toStrictEqual([
      {
        step: 'link',
        argv: [
          'appbuilder',
          'app',
          'actions',
          'link',
          'other_action',
          'client_client',
          ...JSON_ARGS,
        ],
      },
    ]);
    expect(h.server.writes()).toStrictEqual([]);
  });

  it('prints the actions as text without --json', async () => {
    const h = harness();

    await listActions(h, { json: false });

    expect(h.stdout.join('')).toContain(
      [
        'JS actions:',
        '  hello_action (Action hello_action): linked to Contacts (client_client, menu: on)',
        '  other_action (Action other_action): not linked (hint: client_client)',
        "  new_action (Action new_action): not in Live, so its links can't be listed",
      ].join('\n'),
    );
  });

  it('an app not on this business lists nothing and calls no list', async () => {
    const h = makeHarness({ server: makeServer({ exists: false, live: null }) });

    await listActions(h);

    expect(h.json()).toMatchObject({ ok: true, published: false, actions: [], next: [] });
    expect(h.server.calls).toStrictEqual(['listApps']);
  });

  it('a failed list fails the command', async () => {
    const h = harness();

    h.server.api.listActionAssociations.mockRejectedValue(
      new KizenApiError('forbidden', 'GET /associations failed with 403', { status: 403 }),
    );

    await listActions(h);

    expect(h.json()).toMatchObject({
      ok: false,
      code: 'forbidden',
      hint: 'Business Apps need the Marketplace › Business App Developer permission at the Delete/All level.',
    });
    expect(h.exitCodes).toStrictEqual([1]);
  });
});

describe('app actions link', () => {
  it('actions link is a dry run without --yes and pins the account and object id in applyArgv', async () => {
    const h = harness({}, { deps: sessionDeps() });

    await link(h, 'other_action', 'Contacts', { credentials: undefined, profile: undefined });

    const result = h.json();

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      dryRun: true,
      reason: 'no_yes',
      action: 'actions link',
      change: 'create',
      includePerformAction: false,
      jsAction: { apiName: 'other_action', inLive: true },
      object: { id: CONTACTS.id, name: 'client_client', label: 'Contacts' },
      requiresProductionConsent: false,
      next: [],
    });
    expect(result.applyArgv).toStrictEqual([
      'appbuilder',
      'app',
      'actions',
      'link',
      'other_action',
      CONTACTS.id,
      '--no-menu',
      '--yes',
      ...PINNED,
    ]);
    expect(h.server.writes()).toStrictEqual([]);
    expect(h.stderr.join('')).toContain('Dry run only: pass --yes to write.');
  });

  it('actions link creates via the flat endpoint with the menu flag', async () => {
    for (const menu of [true, false, undefined]) {
      const h = harness();

      await link(h, 'other_action', 'client_client', {
        yes: true,
        ...(menu === undefined ? {} : { menu }),
      });

      expect(h.json()).toMatchObject({ ok: true, applied: true, status: 'created' });
      expect(h.server.api.createActionAssociation).toHaveBeenCalledWith({
        appApiName: APP_API,
        actionApiName: 'other_action',
        objectId: CONTACTS.id,
        includePerformAction: menu ?? false,
      });
      expect(h.server.state.associations).toContainEqual(
        expect.objectContaining({
          template: 'other_action',
          objectId: CONTACTS.id,
          includePerformAction: menu ?? false,
        }),
      );
      expect(h.server.writes()).toStrictEqual([`createAssociation:other_action:${CONTACTS.id}`]);
      expect(h.json().next).toStrictEqual([
        { step: 'actions', argv: ['appbuilder', 'app', 'actions', 'list', ...JSON_ARGS] },
      ]);
    }
  });

  it('actions link with a different flag on an existing association patches it', async () => {
    const h = harness();

    await link(h, 'hello_action', 'client_client', { yes: true, menu: false });

    expect(h.json()).toMatchObject({
      ok: true,
      applied: true,
      status: 'updated',
      change: 'update',
      includePerformAction: false,
      existing: { id: 'assoc-1', includePerformAction: true },
    });
    expect(h.server.writes()).toStrictEqual(['updateAssociation:assoc-1:false']);
    expect(h.server.api.createActionAssociation).not.toHaveBeenCalled();
    expect(h.server.state.associations.find((row) => row.id === 'assoc-1')).toMatchObject({
      includePerformAction: false,
    });
  });

  it('actions link with the same flag is up to date and writes nothing', async () => {
    for (const extra of [{ menu: true }, {}]) {
      const h = harness();

      await link(h, 'hello_action', 'client_client', { yes: true, ...extra });

      expect(h.json()).toMatchObject({
        ok: true,
        applied: false,
        dryRun: false,
        status: 'up_to_date',
        change: 'up_to_date',
        includePerformAction: true,
      });
      expect(h.server.writes()).toStrictEqual([]);
      expect(h.exitCodes).toStrictEqual([]);
    }
  });

  it('a duplicate 400 on create is reported as already linked', async () => {
    const h = harness();

    await link(h, 'new_action', 'client_client', { yes: true, menu: true });

    const result = h.json();

    expect(h.exitCodes).toStrictEqual([]);
    expect(result).toMatchObject({
      ok: true,
      applied: false,
      status: 'already_linked',
      change: 'create',
      notices: [UNLISTED_LINK_NOTICE('new_action')],
      warnings: [ALREADY_LINKED_WARNING('new_action', 'client_client')],
    });
    expect(h.server.api.createActionAssociation).toHaveBeenCalledTimes(1);
    expect(h.server.state.associations).toContainEqual(NEW_LINK);
  });

  it('another 400 on create still fails', async () => {
    const h = harness();

    h.server.api.createActionAssociation.mockRejectedValueOnce(
      new KizenApiError(
        'api_error',
        'POST x failed with 400: Plugin App not installed in Business',
        {
          status: 400,
        },
      ),
    );

    await link(h, 'other_action', 'client_client', { yes: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'api_error' });
    expect(h.exitCodes).toStrictEqual([1]);
  });

  it('actions link resolves Contacts (custom_only=false) and refuses an unknown or ambiguous object', async () => {
    for (const arg of ['client_client', CONTACTS.id, 'contacts', 'CLIENT_CLIENT']) {
      const h = harness();

      await link(h, 'other_action', arg);

      expect(h.json(), arg).toMatchObject({ ok: true, object: { id: CONTACTS.id } });
    }

    const unknown = harness();

    await link(unknown, 'other_action', 'nope', { yes: true });

    expect(unknown.json()).toMatchObject({
      ok: false,
      code: 'not_found',
      message:
        'No object "nope" on this business that you can see. Pass an object\'s api name (like client_client) or its id.',
    });
    expect(unknown.exitCodes).toStrictEqual([1]);
    expect(unknown.server.writes()).toStrictEqual([]);

    const ambiguous = harness();

    await link(ambiguous, 'other_action', 'Deals', { yes: true, menu: true });

    expect(ambiguous.json()).toMatchObject({
      ok: false,
      code: 'needs_choice',
      choice: 'object',
      choices: [
        {
          value: DEALS.id,
          label: 'Deals (deal_pipeline)',
          args: [],
          argv: [
            'appbuilder',
            'app',
            'actions',
            'link',
            'other_action',
            DEALS.id,
            '--menu',
            ...JSON_ARGS,
          ],
        },
        {
          value: OLD_DEALS.id,
          argv: [
            'appbuilder',
            'app',
            'actions',
            'link',
            'other_action',
            OLD_DEALS.id,
            '--menu',
            ...JSON_ARGS,
          ],
        },
      ],
    });
    expect(ambiguous.exitCodes).toStrictEqual([2]);
    expect(ambiguous.server.writes()).toStrictEqual([]);
  });

  it('an action in neither Live nor your preview is not_found, before any write', async () => {
    const h = harness();

    await link(h, 'missing_action', 'client_client', { yes: true });

    expect(h.json()).toMatchObject({
      ok: false,
      code: 'not_found',
      message:
        'acme has no JS action "missing_action" in its Live version or your preview. If it\'s new, push this folder first with `appbuilder app push`.',
    });
    expect(h.server.writes()).toStrictEqual([]);
  });

  it('an app not on this business is not_found', async () => {
    const h = makeHarness({ server: makeServer({ exists: false, live: null }) });

    await link(h, 'other_action', 'client_client', { yes: true });

    expect(h.json()).toMatchObject({ ok: false, code: 'not_found' });
    expect(h.server.calls).toStrictEqual(['listApps']);
  });
});

describe('app actions unlink', () => {
  it('actions unlink deletes the listed association and reports not_found otherwise (mentioning the preview-only blind spot when relevant)', async () => {
    const h = harness();

    await unlink(h, 'hello_action', 'client_client');

    expect(h.json()).toMatchObject({
      ok: true,
      dryRun: true,
      associationId: 'assoc-1',
      applyArgv: [
        'appbuilder',
        'app',
        'actions',
        'unlink',
        'hello_action',
        CONTACTS.id,
        '--yes',
        ...JSON_ARGS,
      ],
    });
    expect(h.server.writes()).toStrictEqual([]);

    const applied = harness();

    await unlink(applied, 'hello_action', 'client_client', { yes: true });

    expect(applied.json()).toMatchObject({ ok: true, applied: true, status: 'unlinked' });
    expect(applied.server.writes()).toStrictEqual(['deleteAssociation:assoc-1']);
    expect(applied.server.state.associations.map((row) => row.id)).toStrictEqual(['assoc-2']);

    const inLive = harness();

    await unlink(inLive, 'other_action', 'client_client', { yes: true });

    expect(inLive.json()).toStrictEqual({
      ok: false,
      code: 'not_found',
      message: "other_action isn't linked to client_client.",
    });

    const previewOnly = harness();

    await unlink(previewOnly, 'new_action', 'client_client', { yes: true });

    expect(previewOnly.json()).toStrictEqual({
      ok: false,
      code: 'not_found',
      message: "new_action isn't linked to client_client.",
      hint: UNLISTED_UNLINK_HINT('new_action'),
    });
    expect(previewOnly.server.writes()).toStrictEqual([]);
    expect(previewOnly.exitCodes).toStrictEqual([1]);
  });
});

describe('every actions command', () => {
  const writers: [string, (h: Harness, extra: Extra) => Promise<void>][] = [
    ['link', (h, extra) => link(h, 'other_action', 'client_client', extra)],
    ['unlink', (h, extra) => unlink(h, 'hello_action', 'client_client', extra)],
  ];

  it.each(writers)(
    'actions writes require --allow-production on go and fmo (%s)',
    async (_name, run) => {
      for (const environment of ['go', 'fmo'] as const) {
        const refused = harness({}, { credentials: { environment } });

        await run(refused, { yes: true });

        expect(refused.json()).toMatchObject({ ok: false, code: 'production_requires_flag' });
        expect(refused.server.writes()).toStrictEqual([]);

        const dry = harness({}, { credentials: { environment } });

        await run(dry, {});

        expect(dry.json()).toMatchObject({ dryRun: true, requiresProductionConsent: true });
        expect(dry.json().applyArgv).toContain('--allow-production');

        const allowed = harness({}, { credentials: { environment } });

        await run(allowed, { yes: true, allowProduction: true });

        expect(allowed.json()).toMatchObject({ ok: true, applied: true });
        expect(allowed.server.writes()).toHaveLength(1);
      }
    },
  );

  it.each([['list', (h: Harness, extra: Extra) => listActions(h, extra)], ...writers])(
    'invalid credentials fail before any actions request (%s)',
    async (_name, run) => {
      const missingEnv = harness({}, { environmentSource: 'missing' });

      await run(missingEnv, { yes: true, allowProduction: true });

      expect(missingEnv.json()).toMatchObject({ ok: false, code: 'credentials_invalid' });
      expect(missingEnv.server.calls).toStrictEqual([]);
      expect(missingEnv.mocks.businessApps).not.toHaveBeenCalled();

      const rejected = harness();

      rejected.server.api.listApps.mockRejectedValueOnce(
        new KizenApiError('auth_failed', 'GET /apps failed with 401', { status: 401 }),
      );

      await run(rejected, { yes: true, allowProduction: true });

      expect(rejected.json()).toMatchObject({ ok: false, code: 'auth_failed' });
      expect(rejected.server.calls).toStrictEqual([]);
      expect(rejected.server.api.listActionAssociations).not.toHaveBeenCalled();
      expect(rejected.server.api.listObjects).not.toHaveBeenCalled();
    },
  );

  it('Ctrl+C/abort before an actions write starts no request', async () => {
    const aborted = { isAborted: () => true };
    const objectArgv = (): string[] => [];

    const create = harness();
    const createContext = await contextOf(create);
    const createPlan = await planActionLink(
      createContext,
      { action: 'other_action', object: 'client_client' },
      objectArgv,
    );

    const update = harness();
    const updateContext = await contextOf(update);
    const updatePlan = await planActionLink(
      updateContext,
      { action: 'hello_action', object: 'client_client', menu: false },
      objectArgv,
    );

    const remove = harness();
    const removeContext = await contextOf(remove);
    const removePlan = await planActionUnlink(
      removeContext,
      { action: 'hello_action', object: 'client_client' },
      objectArgv,
    );

    if (!createPlan.ok || !updatePlan.ok || !removePlan.ok) {
      throw new Error('planning failed');
    }

    expect([createPlan.value.change, updatePlan.value.change]).toStrictEqual(['create', 'update']);

    for (const [h, applied] of [
      [create, await applyActionLink(createContext, createPlan.value, aborted)],
      [update, await applyActionLink(updateContext, updatePlan.value, aborted)],
      [remove, await applyActionUnlink(removeContext, removePlan.value, aborted)],
    ] as const) {
      expect(applied).toMatchObject({ ok: false, code: 'local_error', message: 'Cancelled.' });
      expect(h.server.writes()).toStrictEqual([]);
    }

    expect(await applyActionLink(createContext, createPlan.value)).toMatchObject({ ok: true });
    expect(create.server.writes()).toHaveLength(1);
  });
});

describe('actions link and unlink arguments', () => {
  it('headless actions link without args is a usage error naming the missing argument', async () => {
    const cases: [string, (h: Harness) => Promise<void>, string][] = [
      [
        'link, no args',
        (h) => runAppActionsLinkHeadless(undefined, undefined, { json: true, ...API_KEY }, h.deps),
        '<action>',
      ],
      [
        'link, no object',
        (h) =>
          runAppActionsLinkHeadless('other_action', undefined, { json: true, ...API_KEY }, h.deps),
        '<object>',
      ],
      [
        'unlink, no args',
        (h) =>
          runAppActionsUnlinkHeadless(undefined, undefined, { json: true, ...API_KEY }, h.deps),
        '<action>',
      ],
      [
        'unlink, no object',
        (h) =>
          runAppActionsUnlinkHeadless(
            'hello_action',
            undefined,
            { json: true, ...API_KEY },
            h.deps,
          ),
        '<object>',
      ],
    ];

    for (const [name, run, missing] of cases) {
      const h = harness();

      await run(h);

      const result = h.json();

      expect(result, name).toMatchObject({ ok: false, code: 'usage_error' });
      expect(result.message, name).toContain(`Missing argument ${missing}.`);
      expect(h.exitCodes, name).toStrictEqual([1]);
      expect(h.mocks.businessApps, name).not.toHaveBeenCalled();
      expect(h.server.calls, name).toStrictEqual([]);
    }
  });
});

describe('a create the server resolves against the version the caller is using', () => {
  it("a create that can't find a preview-only template says to publish first, then link", async () => {
    const switched = harness({ active: { [USER]: null } });

    await link(switched, 'new_action', 'deal_pipeline', { yes: true });

    const failed = switched.json();

    expect(failed).toMatchObject({
      ok: false,
      code: 'api_error',
      hint: PREVIEW_ONLY_LINK_HINT('new_action'),
    });
    expect(failed.message).toContain('Browser JS action template not found');
    expect(switched.exitCodes).toStrictEqual([1]);
    expect(switched.server.state.associations).toStrictEqual([HELLO_LINK, NEW_LINK]);

    const otherPreview = harness({
      active: { [USER]: OTHER },
      previews: {
        [USER]: yourPreview({
          def: withJsActions(definition(undefined, 'src-preview'), [...LIVE_ACTIONS, 'new_action']),
        }),
        [OTHER]: yourPreview({ ownerName: 'Someone' }),
      },
    });

    await link(otherPreview, 'new_action', 'deal_pipeline', { yes: true });

    expect(otherPreview.json()).toMatchObject({
      ok: false,
      hint: PREVIEW_ONLY_LINK_HINT('new_action'),
    });

    const using = harness();

    await link(using, 'new_action', 'deal_pipeline', { yes: true });

    expect(using.json()).toMatchObject({ ok: true, applied: true, status: 'created' });
    expect(using.server.writes()).toStrictEqual([`createAssociation:new_action:${DEALS.id}`]);

    const live = harness();

    live.server.api.createActionAssociation.mockRejectedValueOnce(
      new KizenApiError(
        'api_error',
        'POST x failed with 400: api_name: Browser JS action template not found',
        { status: 400 },
      ),
    );
    await link(live, 'other_action', 'deal_pipeline', { yes: true });

    expect(live.json()).toMatchObject({ ok: false, code: 'api_error' });
    expect(live.json()).not.toHaveProperty('hint');
  });
});

describe('a link change to an action in Live', () => {
  const LIVE_WARNING = (action: string, object: string): string =>
    `${action} is in the Live version, so this change to its link to ${object} applies to everyone using Live as soon as it's made.`;

  it('link dry run of a Live action warns that the change reaches Live users', async () => {
    const dry = harness();

    await link(dry, 'other_action', 'deal_pipeline');
    expect(dry.json()).toMatchObject({
      dryRun: true,
      change: 'create',
      warnings: [LIVE_WARNING('other_action', 'deal_pipeline')],
    });

    const applied = harness();

    await link(applied, 'other_action', 'deal_pipeline', { yes: true });
    expect(applied.json()).toMatchObject({
      applied: true,
      status: 'created',
      warnings: [LIVE_WARNING('other_action', 'deal_pipeline')],
    });

    const menu = harness();

    await link(menu, 'hello_action', 'client_client', { menu: false });
    expect(menu.json()).toMatchObject({
      dryRun: true,
      change: 'update',
      warnings: [LIVE_WARNING('hello_action', 'client_client')],
    });

    const raced = harness();

    raced.server.api.createActionAssociation.mockRejectedValueOnce(
      new KizenApiError(
        'api_error',
        'POST x failed with 400: Browser JS Template Association for this custom object/js action template already exists.',
        { status: 400 },
      ),
    );
    await link(raced, 'other_action', 'deal_pipeline', { yes: true });
    expect(raced.json()).toMatchObject({
      status: 'already_linked',
      warnings: [ALREADY_LINKED_LIVE_WARNING('other_action', 'deal_pipeline')],
    });
    expect(ALREADY_LINKED_LIVE_WARNING('other_action', 'deal_pipeline')).toContain(
      'appbuilder app actions list',
    );
    expect(ALREADY_LINKED_LIVE_WARNING('other_action', 'deal_pipeline')).not.toContain(
      "isn't listed",
    );

    const same = harness();

    await link(same, 'hello_action', 'client_client', { menu: true });
    expect(same.json()).toMatchObject({ change: 'up_to_date', warnings: [] });
  });

  it('unlink of a Live action warns the same', async () => {
    const dry = harness();

    await unlink(dry, 'hello_action', 'client_client');
    expect(dry.json()).toMatchObject({
      dryRun: true,
      warnings: [LIVE_WARNING('hello_action', 'client_client')],
    });

    const applied = harness();

    await unlink(applied, 'hello_action', 'client_client', { yes: true });
    expect(applied.json()).toMatchObject({
      applied: true,
      status: 'unlinked',
      warnings: [LIVE_WARNING('hello_action', 'client_client')],
    });
  });

  it('link of a preview-only action does not carry the Live warning', async () => {
    const dry = harness();

    await link(dry, 'new_action', 'deal_pipeline');
    expect(dry.json()).toMatchObject({ dryRun: true, change: 'create', warnings: [] });

    const applied = harness();

    await link(applied, 'new_action', 'deal_pipeline', { yes: true });
    expect(applied.json()).toMatchObject({ status: 'created', warnings: [] });

    const already = harness();

    await link(already, 'new_action', 'client_client', { yes: true });
    expect(already.json()).toMatchObject({
      status: 'already_linked',
      warnings: [ALREADY_LINKED_WARNING('new_action', 'client_client')],
    });
  });
});

describe('a preview-only link that fails', () => {
  it('carries the publish-first hint on every attempt, not just the first', async () => {
    const h = harness({ active: { [USER]: null } });
    const results: Record<string, unknown>[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      h.reset();
      await link(h, 'new_action', 'deal_pipeline', { yes: true });
      results.push(h.json());
      expect(h.exitCodes).toStrictEqual([1]);
    }

    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        code: 'api_error',
        hint: "new_action is only in your preview, and Kizen couldn't find it to link it. Kizen environments without the fix for linking preview-only actions (KZN-19521) only link actions in Live: publish it first, then link it.",
      });
    }

    expect(h.server.writes()).toStrictEqual([
      `createAssociation:new_action:${DEALS.id}`,
      `createAssociation:new_action:${DEALS.id}`,
    ]);
    expect(h.server.state.associations).toStrictEqual([HELLO_LINK, NEW_LINK]);
  });
});

describe('the commands each JS action carries', () => {
  const SWITCHED = { businessId: 'biz-other', userId: 'user-other' };

  const accountHarness = (): { h: Harness; pointer: { current: typeof SWITCHED } } => {
    const pointer = { current: { businessId: BIZ, userId: USER } };
    const saved = [
      { account: { businessId: BIZ, userId: USER }, session: undefined, current: false },
      { account: SWITCHED, session: undefined, current: false },
    ];
    const connect = vi.fn(
      (_environment: Environment, account?: { businessId: string; userId: string }) => {
        const who = account ?? pointer.current;

        return Promise.resolve({
          identity: { ...who, businessName: undefined, fullName: undefined, email: undefined },
          client: { fakeUser: who.userId } as unknown as KizenClient,
        });
      },
    );
    const h = harness(
      {},
      {
        deployable: pushedApp(),
        deps: {
          oauth: {
            listSessions: vi.fn(() => Promise.resolve<Environment[]>(['staging'])),
            listAccounts: vi.fn(() => Promise.resolve(saved)),
            connect,
          },
        },
      },
    );

    return { h, pointer };
  };

  const runActionsArgv = async (argv: readonly string[], h: Harness): Promise<void> => {
    const [program, group, sub, command, ...rest] = argv;
    const options: Record<string, string | boolean> = {};
    const positional: string[] = [];
    const values: Record<string, string> = {
      '--env': 'env',
      '--business': 'business',
      '--user': 'user',
      '--profile': 'profile',
    };

    expect([program, group, sub]).toStrictEqual(['appbuilder', 'app', 'actions']);

    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] ?? '';
      const key = values[arg];

      if (key !== undefined) {
        index += 1;
        options[key] = rest[index] ?? '';
      } else if (arg === '--json' || arg === '--yes' || arg === '--menu') {
        options[arg === '--json' ? 'json' : arg === '--yes' ? 'yes' : 'menu'] = true;
      } else if (arg === '--no-menu') {
        options.menu = false;
      } else if (arg.startsWith('-')) {
        throw new Error(`unknown flag ${arg}`);
      } else {
        positional.push(arg);
      }
    }

    if (command === 'link') {
      await runAppActionsLinkHeadless(positional[0], positional[1], options, h.deps);
    } else if (command === 'unlink') {
      await runAppActionsUnlinkHeadless(positional[0], positional[1], options, h.deps);
    } else {
      throw new Error(`unexpected command ${String(command)}`);
    }
  };

  interface ActionJson {
    apiName: string;
    linkArgv: string[];
    linkMenuArgv: string[];
    linkNoMenuArgv: string[];
    links: { objectId: string; unlinkArgv: string[] }[];
  }

  const actionsOf = (result: Record<string, unknown>): ActionJson[] =>
    ((result.jsActions as { actions?: unknown } | undefined)?.actions ??
      result.actions) as ActionJson[];

  const find = (actions: ActionJson[], apiName: string): ActionJson => {
    const action = actions.find((candidate) => candidate.apiName === apiName);

    if (action === undefined) {
      throw new Error(`no ${apiName}`);
    }

    return action;
  };

  const PINNED_BIZ = ['--env', 'staging', '--business', BIZ, '--user', USER];

  it('every action carries account-pinned link templates with an <object> slot', async () => {
    const commands: [string, (h: Harness, extra: Extra) => Promise<void>][] = [
      ['push', (h, extra) => push(h, extra)],
      ['publish', (h, extra) => publish(h, extra)],
      ['versions', (h, extra) => versions(h, extra)],
      ['actions list', (h, extra) => listActions(h, extra)],
    ];
    const runs: [string, Extra, string[]][] = [
      [
        'session --business',
        { credentials: undefined, profile: undefined, env: 'staging', business: BIZ },
        PINNED_BIZ,
      ],
      ['--profile', {}, CRED_ARGS],
    ];

    for (const [name, run] of commands) {
      for (const [how, extra, pinned] of runs) {
        const { h } = accountHarness();

        await run(h, extra);

        const label = `${name} (${how})`;

        expect(h.json(), label).toMatchObject({ ok: true });

        const actions = actionsOf(h.json());

        expect(
          actions.map((action) => action.apiName),
          label,
        ).toContain('other_action');

        for (const action of actions) {
          expect(action.linkArgv, label).toStrictEqual([
            'appbuilder',
            'app',
            'actions',
            'link',
            action.apiName,
            '<object>',
            ...pinned,
            '--json',
          ]);
          expect(action.linkMenuArgv, label).toStrictEqual([
            'appbuilder',
            'app',
            'actions',
            'link',
            action.apiName,
            '<object>',
            '--menu',
            ...pinned,
            '--json',
          ]);
          expect(action.linkNoMenuArgv, label).toStrictEqual([
            'appbuilder',
            'app',
            'actions',
            'link',
            action.apiName,
            '<object>',
            '--no-menu',
            ...pinned,
            '--json',
          ]);
        }
      }
    }

    const text = harness();

    await runAppActionsListHeadless({ ...API_KEY }, text.deps);
    expect(text.stdout.join('')).not.toContain('<object>');
  });

  it('existing links carry a concrete pinned unlinkArgv', async () => {
    for (const [extra, pinned] of [
      [{ credentials: undefined, profile: undefined, env: 'staging', business: BIZ }, PINNED_BIZ],
      [{}, CRED_ARGS],
    ] as const) {
      const { h } = accountHarness();

      await versions(h, extra);

      const hello = find(actionsOf(h.json()), 'hello_action');

      expect(hello.links).toHaveLength(1);
      expect(hello.links[0]?.unlinkArgv).toStrictEqual([
        'appbuilder',
        'app',
        'actions',
        'unlink',
        'hello_action',
        CONTACTS.id,
        ...pinned,
        '--json',
      ]);
      expect(hello.links[0]?.unlinkArgv).not.toContain('<object>');
    }
  });

  it('a link template with its object filled in, and an unlinkArgv, act as the original account after a switch', async () => {
    const { h, pointer } = accountHarness();

    await versions(h, { credentials: undefined, profile: undefined });

    const actions = actionsOf(h.json());
    const { linkMenuArgv } = find(actions, 'other_action');
    const unlinkArgv = find(actions, 'hello_action').links[0]?.unlinkArgv ?? [];

    expect(linkMenuArgv).toContain('<object>');

    pointer.current = SWITCHED;

    const connect = vi.mocked(h.deps.oauth.connect);
    const filled = linkMenuArgv.map((arg) => (arg === '<object>' ? 'deal_pipeline' : arg));

    h.reset();
    await runActionsArgv(filled, h);

    const dry = h.json();

    expect(connect).toHaveBeenLastCalledWith('staging', { businessId: BIZ, userId: USER });
    expect(dry).toMatchObject({
      ok: true,
      dryRun: true,
      businessId: BIZ,
      userId: USER,
      jsAction: { apiName: 'other_action' },
      object: { id: DEALS.id },
      includePerformAction: true,
    });

    h.reset();
    await runActionsArgv(dry.applyArgv as string[], h);

    expect(h.json()).toMatchObject({ ok: true, applied: true, status: 'created', businessId: BIZ });
    expect(connect).toHaveBeenLastCalledWith('staging', { businessId: BIZ, userId: USER });

    h.reset();
    await runActionsArgv(unlinkArgv, h);

    expect(h.json()).toMatchObject({
      ok: true,
      dryRun: true,
      businessId: BIZ,
      associationId: 'assoc-1',
    });
    expect(connect).toHaveBeenLastCalledWith('staging', { businessId: BIZ, userId: USER });
    expect(h.server.writes()).toStrictEqual([`createAssociation:other_action:${DEALS.id}`]);
  });

  it('linkNoMenuArgv on an existing menu-on link patches it off', async () => {
    const { h } = accountHarness();

    await versions(h);

    const hello = find(actionsOf(h.json()), 'hello_action');
    const fill = (argv: string[]): string[] =>
      argv.map((arg) => (arg === '<object>' ? 'client_client' : arg));

    h.reset();
    await runActionsArgv(fill(hello.linkArgv), h);
    expect(h.json()).toMatchObject({ ok: true, status: 'up_to_date', includePerformAction: true });

    h.reset();
    await runActionsArgv(fill(hello.linkNoMenuArgv), h);

    const dry = h.json();

    expect(dry).toMatchObject({
      ok: true,
      dryRun: true,
      change: 'update',
      includePerformAction: false,
      existing: { id: 'assoc-1', includePerformAction: true },
    });

    h.reset();
    await runActionsArgv(dry.applyArgv as string[], h);

    expect(h.json()).toMatchObject({ ok: true, applied: true, status: 'updated' });
    expect(h.server.writes()).toStrictEqual(['updateAssociation:assoc-1:false']);
    expect(h.server.state.associations.find((row) => row.id === 'assoc-1')).toMatchObject({
      includePerformAction: false,
    });
  });
});
