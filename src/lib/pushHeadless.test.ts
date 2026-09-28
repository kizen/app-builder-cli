import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginValidationError } from '@kizenapps/packager';
import type { Block, DeployablePlugin, ValidationIssue } from '@kizenapps/packager';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AppBuilderConfig } from './config.js';
import type {
  CredentialProfile,
  Credentials,
  DetailedCredentials,
  Environment,
} from './credentials.js';
import { claudeFiles } from './createCopilotFiles.js';
import { KizenApiError } from './kizenClient.js';
import type {
  KizenClient,
  PushMapEntry,
  WireCustomObject,
  WireDashboard,
  WireDashboardSummary,
  WireDashlet,
} from './kizenTypes.js';
import {
  canonicalContentHash,
  PUSH_MAP_RELATIVE_PATH,
  pushKey,
  readPushMap,
  toCustomCodeContent,
} from './pushBlock.js';
import {
  apiFailure,
  buildBrowserRefresh,
  buildPlan,
  buildTargetChoices,
  headlessWriteGate,
  listPushableObjects,
  listTargets,
  resolveBlock,
  resolveCredentials,
  resolveTarget,
  runPushHeadless,
  runTargetsHeadless,
  toTargetRow,
  type PushCommandOptions,
  type PushContext,
  type PushDeps,
  type ResolvedBlock,
} from './pushHeadless.js';
import { isClaudeSkillStale } from './setupClaude.js';

const PLUGIN = 'acme';
const BLOCK = 'chart';
const CWD = '/work/acme';
const DEFAULT_PATH = '/home/.kizenappbuilder/credentials.json';
const PUSHED_AT = '2026-09-25T12:00:00.000Z';

const makeBlock = (overrides: Partial<Block> = {}): Block => ({
  name: 'Chart',
  api_name: BLOCK,
  min_w: 4,
  max_w: 12,
  min_h: 3,
  max_h: 10,
  event_scripts: { refresh: 'this.showToast("Refreshed", {});' },
  script: 'this.outputUI("hi");',
  styles: '.x { color: red; }',
  when: '',
  ...overrides,
});

const makePlugin = (apiName: string, blocks: Block[]): DeployablePlugin =>
  ({ api_name: apiName, artifacts: { custom_blocks: blocks } }) as unknown as DeployablePlugin;

const BLOCK_HASH = canonicalContentHash(toCustomCodeContent(makeBlock()));

const makeCredentials = (overrides: Partial<Credentials> = {}): Credentials => ({
  apiKey: 'key',
  userId: 'user',
  businessId: 'biz',
  environment: 'staging',
  ...overrides,
});

interface DashletOverrides {
  name?: string;
  dashboard?: string;
  contentName?: string;
  script?: string;
  objectId?: string;
  layout?: WireDashlet['layout'];
}

const customCodeDashlet = (id: string, overrides: DashletOverrides = {}): WireDashlet => ({
  id,
  name: overrides.name ?? pushKey(PLUGIN, BLOCK),
  dashboard: overrides.dashboard ?? 'D1',
  layout: overrides.layout === undefined ? { i: id, x: 0, y: 0, w: 6, h: 4 } : overrides.layout,
  config: {
    object_id: overrides.objectId ?? `obj-${id}`,
    entity_type: 'static_content',
    report_type: 'html',
    chart_type: 'html',
    custom_object: 'co-leak',
    content: {
      kind: 'custom_code',
      version: 1,
      name: overrides.contentName ?? 'Chart',
      script: overrides.script ?? 'old();',
      styles: '',
      event_scripts: [],
    },
    fe_extra_info: {
      custom_styles_enabled: true,
      dashlet_style_config: { drop_shadow: true, border: 'thin' },
    },
  },
});

const chartDashlet = (id: string, dashboard = 'D1'): WireDashlet => ({
  id,
  name: 'Revenue',
  dashboard,
  layout: { i: id, x: 0, y: 4, w: 6, h: 5 },
  config: { chart_type: 'bar' },
});

const makeDashboard = (overrides: Partial<WireDashboard> = {}): WireDashboard => ({
  id: 'D1',
  name: 'Sales',
  type: 'generic_dashboard',
  custom_object: null,
  employee_access: 'Owner',
  dashlets: [],
  ...overrides,
});

const makeEntry = (overrides: Partial<PushMapEntry> = {}): PushMapEntry => ({
  environment: 'staging',
  businessId: 'biz',
  pluginApiName: PLUGIN,
  blockApiName: BLOCK,
  dashboardId: 'D1',
  dashletId: 'X1',
  contentHash: canonicalContentHash(customCodeDashlet('X1').config?.content),
  pushedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const summary = (overrides: Partial<WireDashboardSummary> = {}): WireDashboardSummary => ({
  id: 'D1',
  name: 'Sales',
  type: 'generic_dashboard',
  employee_access: 'Owner',
  hidden: false,
  dashlets_count: 3,
  ...overrides,
});

interface FakeClient {
  client: KizenClient;
  listDashboards: Mock<KizenClient['listDashboards']>;
  listCustomObjects: Mock<KizenClient['listCustomObjects']>;
  getCustomObject: Mock<KizenClient['getCustomObject']>;
  getClientObjectId: Mock<KizenClient['getClientObjectId']>;
  getDashboard: Mock<KizenClient['getDashboard']>;
  createDashlet: Mock<KizenClient['createDashlet']>;
  updateDashlet: Mock<KizenClient['updateDashlet']>;
}

const makeClient = (
  options: {
    dashboards?: WireDashboard[];
    summaries?: Partial<Record<string, WireDashboardSummary[]>>;
    customObjects?: WireCustomObject[];
    objectDetails?: WireCustomObject[];
    clientObjectId?: string | null;
  } = {},
): FakeClient => {
  const dashboards = options.dashboards ?? [];
  const listDashboards = vi.fn<KizenClient['listDashboards']>((type) =>
    Promise.resolve(options.summaries?.[type] ?? []),
  );
  const listCustomObjects = vi.fn<KizenClient['listCustomObjects']>(() =>
    Promise.resolve(options.customObjects ?? []),
  );
  const getCustomObject = vi.fn<KizenClient['getCustomObject']>((id) => {
    const found = [...(options.customObjects ?? []), ...(options.objectDetails ?? [])].find(
      (object) => object.id === id,
    );

    return found
      ? Promise.resolve(found)
      : Promise.reject(
          new KizenApiError('not_found', `GET /custom-objects/${id} failed with 404`, {
            status: 404,
          }),
        );
  });
  const getClientObjectId = vi.fn<KizenClient['getClientObjectId']>(() =>
    Promise.resolve(options.clientObjectId ?? null),
  );
  const getDashboard = vi.fn<KizenClient['getDashboard']>((id) => {
    const found = dashboards.find((dashboard) => dashboard.id === id);

    return found
      ? Promise.resolve(found)
      : Promise.reject(
          new KizenApiError('not_found', `GET /dashboards/${id} failed with 404`, { status: 404 }),
        );
  });
  const createDashlet = vi.fn<KizenClient['createDashlet']>((dashboardId) =>
    Promise.resolve({
      id: 'NEW',
      name: pushKey(PLUGIN, BLOCK),
      layout: null,
      config: {},
      dashboard: dashboardId,
    } satisfies WireDashlet),
  );
  const updateDashlet = vi.fn<KizenClient['updateDashlet']>((dashboardId, dashletId) =>
    Promise.resolve({
      id: dashletId,
      name: pushKey(PLUGIN, BLOCK),
      layout: null,
      config: {},
      dashboard: dashboardId,
    } satisfies WireDashlet),
  );

  return {
    client: {
      listDashboards,
      listCustomObjects,
      getCustomObject,
      getClientObjectId,
      getDashboard,
      createDashlet,
      updateDashlet,
    },
    listDashboards,
    listCustomObjects,
    getCustomObject,
    getClientObjectId,
    getDashboard,
    createDashlet,
    updateDashlet,
  };
};

interface Harness {
  deps: PushDeps;
  fake: FakeClient;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  pushMap: { entries: PushMapEntry[] };
  events: string[];
  json: () => unknown;
}

interface HarnessOptions {
  fake?: FakeClient;
  credentials?: Credentials;
  environmentSource?: DetailedCredentials['environmentSource'];
  profiles?: CredentialProfile[];
  config?: AppBuilderConfig;
  deployable?: DeployablePlugin[];
  packageError?: unknown;
  warnings?: ValidationIssue[];
  pushMap?: PushMapEntry[];
  writePushMapError?: Error;
  deps?: Partial<PushDeps>;
}

const DEFAULT_PROFILE: CredentialProfile = {
  name: 'credentials',
  path: DEFAULT_PATH,
  isDefault: true,
};

const makeHarness = (options: HarnessOptions = {}): Harness => {
  const fake = options.fake ?? makeClient();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const events: string[] = [];
  const pushMap = { entries: [...(options.pushMap ?? [])] };
  let uuid = 0;
  const deps: PushDeps = {
    cwd: CWD,
    loadCredentialsDetailed: vi.fn(() =>
      Promise.resolve({
        credentials: options.credentials ?? makeCredentials(),
        environmentSource: options.environmentSource ?? 'explicit',
      }),
    ),
    listLoadableCredentialProfiles: vi.fn(() =>
      Promise.resolve(options.profiles ?? [DEFAULT_PROFILE]),
    ),
    loadConfig: vi.fn(() => Promise.resolve(options.config ?? {})),
    packageBlocks: vi.fn(() =>
      options.packageError === undefined
        ? Promise.resolve({
            deployable: options.deployable ?? [makePlugin(PLUGIN, [makeBlock()])],
            warnings: options.warnings ?? [],
          })
        : Promise.reject(options.packageError as Error),
    ),
    createClient: vi.fn(() => fake.client),
    readPushMap: vi.fn(() => Promise.resolve([...pushMap.entries])),
    writePushMap: vi.fn((_dir: string, entries: readonly PushMapEntry[]) => {
      events.push('writePushMap');

      if (options.writePushMapError) {
        return Promise.reject(options.writePushMapError);
      }

      pushMap.entries = [...entries];

      return Promise.resolve();
    }),
    ensureGitignore: vi.fn(() => {
      events.push('ensureGitignore');
    }),
    isClaudeSkillStale: vi.fn(() => Promise.resolve(false)),
    randomUUID: vi.fn(() => {
      uuid += 1;

      return `uuid-${String(uuid)}`;
    }),
    now: () => new Date(PUSHED_AT),
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
    ...options.deps,
  };

  return {
    deps,
    fake,
    stdout,
    stderr,
    exitCodes,
    pushMap,
    events,
    json: () => {
      expect(stdout).toHaveLength(1);

      return JSON.parse(stdout[0] ?? '') as unknown;
    },
  };
};

const runPush = async (harness: Harness, options: PushCommandOptions): Promise<Harness> => {
  await runPushHeadless(BLOCK, { json: true, ...options }, harness.deps);

  return harness;
};

const resolvedBlock = (): ResolvedBlock => {
  const block = makeBlock();
  const content = toCustomCodeContent(block);

  return {
    block,
    pluginApiName: PLUGIN,
    content,
    contentHash: canonicalContentHash(content),
    warnings: [],
  };
};

const makeContext = (fake: FakeClient, entry?: PushMapEntry): PushContext => ({
  client: fake.client,
  credentials: makeCredentials(),
  block: resolvedBlock(),
  pushMap: entry ? [entry] : [],
  entry,
});

describe('apiFailure', () => {
  it('maps KizenApiError kinds and keeps the hint', () => {
    expect(
      apiFailure(new KizenApiError('auth_failed', 'GET x failed with 401', { hint: 'check key' })),
    ).toStrictEqual({
      ok: false,
      code: 'auth_failed',
      message: 'GET x failed with 401',
      hint: 'check key',
    });
    expect(apiFailure(new KizenApiError('network_error', 'offline'))).toStrictEqual({
      ok: false,
      code: 'network_error',
      message: 'offline',
    });
  });

  it('keeps api_error for Kizen HTTP errors', () => {
    expect(apiFailure(new KizenApiError('api_error', 'GET x failed with 500'))).toStrictEqual({
      ok: false,
      code: 'api_error',
      message: 'GET x failed with 500',
    });
  });

  it('maps a PluginValidationError to validation_failed with the issues', () => {
    const issues: ValidationIssue[] = [{ rule: 'r', severity: 'error', message: 'bad' }];

    expect(apiFailure(new PluginValidationError(issues))).toMatchObject({
      ok: false,
      code: 'validation_failed',
      issues,
    });
  });

  it('maps anything else to local_error', () => {
    expect(apiFailure(new Error('boom'))).toStrictEqual({
      ok: false,
      code: 'local_error',
      message: 'boom',
    });
  });
});

describe('resolveCredentials', () => {
  const profiles: CredentialProfile[] = [
    DEFAULT_PROFILE,
    { name: 'staging', path: '/home/.kizenappbuilder/staging.json', isDefault: false },
  ];

  it('prefers -c over --profile and config', async () => {
    const { deps } = makeHarness({
      profiles,
      config: { activeCredentialProfile: 'staging' },
    });
    const step = await resolveCredentials({ credentials: '/tmp/c.json', profile: 'staging' }, deps);

    expect(step).toStrictEqual({
      ok: true,
      value: { credentials: makeCredentials(), source: { kind: 'file', path: '/tmp/c.json' } },
    });
    expect(deps.loadCredentialsDetailed).toHaveBeenCalledWith('/tmp/c.json');
    expect(deps.listLoadableCredentialProfiles).not.toHaveBeenCalled();
  });

  it('reports an unreadable -c file as credentials_invalid', async () => {
    const { deps } = makeHarness({
      deps: { loadCredentialsDetailed: vi.fn(() => Promise.reject(new Error('ENOENT'))) },
    });
    const step = await resolveCredentials({ credentials: '/tmp/missing.json' }, deps);

    expect(step).toMatchObject({ ok: false, code: 'credentials_invalid' });
    expect(!step.ok && step.message).toContain('/tmp/missing.json');
  });

  it('selects --profile by name', async () => {
    const { deps } = makeHarness({ profiles, config: { activeCredentialProfile: 'credentials' } });
    const step = await resolveCredentials({ profile: 'staging' }, deps);

    expect(step).toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'profile',
          name: 'staging',
          path: '/home/.kizenappbuilder/staging.json',
        },
      },
    });
    expect(deps.loadConfig).not.toHaveBeenCalled();
  });

  it('rejects an unknown --profile and lists the loadable ones', async () => {
    const { deps } = makeHarness({ profiles });
    const step = await resolveCredentials({ profile: 'prod' }, deps);

    expect(step).toMatchObject({ ok: false, code: 'credentials_invalid' });
    expect(!step.ok && step.message).toContain('credentials, staging');
  });

  it("refuses config credentialMode 'local'", async () => {
    const { deps } = makeHarness({ profiles, config: { credentialMode: 'local' } });
    const step = await resolveCredentials({}, deps);

    expect(step).toMatchObject({ ok: false, code: 'credentials_invalid' });
    expect(!step.ok && step.message).toContain("local browser-only credentials the CLI can't read");
    expect(deps.loadConfig).toHaveBeenCalledWith(`${CWD}/.kizenapp`);
  });

  it('uses the config activeCredentialProfile when it is loadable', async () => {
    const { deps } = makeHarness({ profiles, config: { activeCredentialProfile: 'staging' } });
    const step = await resolveCredentials({}, deps);

    expect(step).toMatchObject({ ok: true, value: { source: { name: 'staging' } } });
  });

  it('falls through an activeCredentialProfile that is not loadable', async () => {
    const { deps } = makeHarness({ config: { activeCredentialProfile: 'gone' } });
    const step = await resolveCredentials({}, deps);

    expect(step).toMatchObject({ ok: true, value: { source: { name: 'credentials' } } });
  });

  it('uses the only loadable profile', async () => {
    const { deps } = makeHarness();
    const step = await resolveCredentials({}, deps);

    expect(step).toMatchObject({
      ok: true,
      value: { source: { kind: 'profile', name: 'credentials', path: DEFAULT_PATH } },
    });
  });

  it('asks for a profile when several are loadable', async () => {
    const { deps } = makeHarness({ profiles });
    const step = await resolveCredentials({}, deps);

    expect(step).toMatchObject({ ok: false, code: 'needs_choice', choice: 'profile' });
    expect(!step.ok && step.choices).toStrictEqual([
      { value: 'credentials', label: 'credentials (default)', args: ['--profile', 'credentials'] },
      { value: 'staging', label: 'staging', args: ['--profile', 'staging'] },
    ]);
  });

  it('reports credentials_invalid when nothing is loadable', async () => {
    const { deps } = makeHarness({ profiles: [] });
    const step = await resolveCredentials({}, deps);

    expect(step).toMatchObject({ ok: false, code: 'credentials_invalid' });
  });

  it.each(['missing', 'invalid'] as const)(
    'refuses an environment that is %s, naming the file and the valid values',
    async (environmentSource) => {
      const { deps } = makeHarness({ environmentSource });
      const step = await resolveCredentials({}, deps);

      expect(step).toMatchObject({ ok: false, code: 'credentials_invalid' });

      const message = step.ok ? '' : step.message;

      expect(message).toContain(DEFAULT_PATH);
      expect(message).toContain('go, fmo, staging, integration, test1');
      expect(message).toContain("won't default to production");
    },
  );

  it('refuses an empty apiKey', async () => {
    const { deps } = makeHarness({ credentials: makeCredentials({ apiKey: '  ' }) });
    const step = await resolveCredentials({}, deps);

    expect(step).toMatchObject({ ok: false, code: 'credentials_invalid' });
    expect(!step.ok && step.message).toContain('"apiKey"');
  });
});

describe('resolveBlock', () => {
  it('returns the block, its content and the canonical hash', async () => {
    const warning: ValidationIssue = { rule: 'r', severity: 'warning', message: 'careful' };
    const { deps } = makeHarness({ warnings: [warning] });
    const step = await resolveBlock(BLOCK, deps);

    expect(step).toStrictEqual({
      ok: true,
      value: {
        block: makeBlock(),
        pluginApiName: PLUGIN,
        content: toCustomCodeContent(makeBlock()),
        contentHash: BLOCK_HASH,
        warnings: [warning],
      },
    });
    expect(deps.packageBlocks).toHaveBeenCalledWith(CWD);
  });

  it('reports validation_failed with the issues', async () => {
    const issues: ValidationIssue[] = [
      { rule: 'manifest/api-name-format', severity: 'error', message: 'bad', path: 'kizen.json' },
    ];
    const { deps } = makeHarness({ packageError: new PluginValidationError(issues) });
    const step = await resolveBlock(BLOCK, deps);

    expect(step).toMatchObject({ ok: false, code: 'validation_failed', issues });
    expect(!step.ok && step.message).toContain('bad (manifest/api-name-format)');
  });

  it('reports invalid_block with the field', async () => {
    const { deps } = makeHarness({ deployable: [makePlugin(PLUGIN, [makeBlock({ script: '' })])] });
    const step = await resolveBlock(BLOCK, deps);

    expect(step).toMatchObject({ ok: false, code: 'invalid_block', field: 'script' });
  });

  it('reports a plugin without blocks as invalid_block', async () => {
    const { deps } = makeHarness({ deployable: [makePlugin(PLUGIN, [])] });
    const step = await resolveBlock(undefined, deps);

    expect(step).toMatchObject({
      ok: false,
      code: 'invalid_block',
      message:
        'This plugin has no blocks. Scaffold one with `appbuilder create --artifacts block`.',
    });
    expect(step.ok || 'field' in step).toBe(false);
  });

  it('asks for a block when several exist', async () => {
    const { deps } = makeHarness({
      deployable: [
        makePlugin(PLUGIN, [makeBlock(), makeBlock({ api_name: 'table', name: 'Table' })]),
      ],
    });
    const step = await resolveBlock(undefined, deps);

    expect(step).toMatchObject({
      ok: false,
      code: 'needs_choice',
      choice: 'block',
      message: 'This plugin has several blocks; pass the api_name of the one to push: chart, table',
    });
    expect(!step.ok && step.choices).toStrictEqual([
      { value: 'chart', label: 'Chart (chart)', args: ['chart'] },
      { value: 'table', label: 'Table (table)', args: ['table'] },
    ]);
  });

  it('asks for a block when the api_name exists in several plugins', async () => {
    const { deps } = makeHarness({
      deployable: [makePlugin(PLUGIN, [makeBlock()]), makePlugin('other', [makeBlock()])],
    });
    const step = await resolveBlock(BLOCK, deps);

    expect(step).toMatchObject({
      ok: false,
      code: 'needs_choice',
      choice: 'block',
      message: 'More than one plugin has a block with api_name "chart": acme/chart, other/chart',
    });
    expect(!step.ok && step.message).not.toContain('export');
  });

  it('asks for a block when the api_name is unknown, qualifying by plugin when several', async () => {
    const { deps } = makeHarness({
      deployable: [makePlugin(PLUGIN, [makeBlock()]), makePlugin('other', [makeBlock()])],
    });
    const step = await resolveBlock('nope', deps);

    expect(step).toMatchObject({
      ok: false,
      code: 'needs_choice',
      choice: 'block',
      message: 'No block with api_name "nope". Available blocks: acme/chart, other/chart',
    });
    expect(!step.ok && step.choices?.map((choice) => choice.label)).toStrictEqual([
      'Chart (acme/chart)',
      'Chart (other/chart)',
    ]);
  });
});

describe('toTargetRow', () => {
  it.each([
    ['Owner', true],
    ['Admin', true],
    ['Edit', true],
    ['View', false],
    [null, null],
    [undefined, null],
  ] as const)('maps employee_access %s to canEdit %s', (access, canEdit) => {
    const row = toTargetRow(
      { id: 'D', name: 'N', ...(access === undefined ? {} : { employee_access: access }) },
      'homepage',
    );

    expect(row).toStrictEqual({
      id: 'D',
      name: 'N',
      type: 'homepage',
      dashletsCount: null,
      employeeAccess: access ?? null,
      hidden: false,
      canEdit,
    });
  });

  it('keeps dashlets_count and hidden', () => {
    expect(toTargetRow(summary({ hidden: true, dashlets_count: 7 }), 'dashboard')).toMatchObject({
      dashletsCount: 7,
      hidden: true,
      canEdit: true,
    });
  });
});

describe('buildTargetChoices', () => {
  it('lists member custom-code dashlets, then the new choice', () => {
    const dashboard = makeDashboard({
      dashlets: [
        customCodeDashlet('X1', { contentName: 'Mine' }),
        customCodeDashlet('X2', { name: 'appbuilder:other/thing', contentName: 'Theirs' }),
        customCodeDashlet('X3', { name: 'hand made', contentName: 'Pasted' }),
        customCodeDashlet('X4', { dashboard: 'D9' }),
        chartDashlet('C1'),
      ],
    });

    expect(buildTargetChoices(dashboard, resolvedBlock())).toStrictEqual([
      {
        value: 'X1',
        label: 'Mine',
        args: ['--dashboard', 'D1', '--dashlet', 'X1'],
        pushKey: 'appbuilder:acme/chart',
        isFromThisPlugin: true,
      },
      {
        value: 'X2',
        label: 'Theirs',
        args: ['--dashboard', 'D1', '--dashlet', 'X2'],
        pushKey: 'appbuilder:other/thing',
        isFromThisPlugin: false,
      },
      {
        value: 'X3',
        label: 'Pasted',
        args: ['--dashboard', 'D1', '--dashlet', 'X3'],
        pushKey: null,
        isFromThisPlugin: false,
      },
      { value: 'new', label: 'Create a new block', args: ['--dashboard', 'D1', '--create'] },
    ]);
  });
});

describe('resolveTarget', () => {
  it('rejects --dashlet with --create', async () => {
    const fake = makeClient();
    const step = await resolveTarget(makeContext(fake), {
      dashboard: 'D1',
      dashlet: 'X1',
      create: true,
    });

    expect(step).toMatchObject({ ok: false, code: 'usage_error' });
    expect(fake.getDashboard).not.toHaveBeenCalled();
  });

  it('rejects --dashlet without --dashboard', async () => {
    const fake = makeClient();
    const step = await resolveTarget(makeContext(fake), { dashlet: 'X1' });

    expect(step).toMatchObject({ ok: false, code: 'usage_error' });
    expect(fake.getDashboard).not.toHaveBeenCalled();
  });

  it('creates on --dashboard with --create', async () => {
    const dashboard = makeDashboard({ dashlets: [customCodeDashlet('X1')] });
    const fake = makeClient({ dashboards: [dashboard] });
    const step = await resolveTarget(makeContext(fake, makeEntry()), {
      dashboard: 'D1',
      create: true,
    });

    expect(step).toStrictEqual({
      ok: true,
      value: {
        dashboard,
        surface: 'dashboard',
        action: 'create',
        dashlet: undefined,
        resolvedBy: 'flag',
      },
    });
  });

  it('updates an explicit --dashlet that is a member custom-code dashlet', async () => {
    const dashlet = customCodeDashlet('X2', { name: 'hand made' });
    const fake = makeClient({ dashboards: [makeDashboard({ dashlets: [dashlet] })] });
    const step = await resolveTarget(makeContext(fake), { dashboard: 'D1', dashlet: 'X2' });

    expect(step).toMatchObject({
      ok: true,
      value: { action: 'update', dashlet, resolvedBy: 'flag' },
    });
  });

  it('reports a --dashlet that is not on the dashboard as not_found with choices', async () => {
    const fake = makeClient({
      dashboards: [makeDashboard({ dashlets: [customCodeDashlet('X1')] })],
    });
    const step = await resolveTarget(makeContext(fake), { dashboard: 'D1', dashlet: 'ZZ' });

    expect(step).toMatchObject({ ok: false, code: 'not_found', choice: 'target' });
    expect(!step.ok && step.choices?.map((choice) => choice.value)).toStrictEqual(['X1', 'new']);
  });

  it('treats a dashlet whose dashboard field differs as not a member', async () => {
    const fake = makeClient({
      dashboards: [makeDashboard({ dashlets: [customCodeDashlet('X1', { dashboard: 'D2' })] })],
    });
    const step = await resolveTarget(makeContext(fake), { dashboard: 'D1', dashlet: 'X1' });

    expect(step).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses a --dashlet that is not custom code', async () => {
    const fake = makeClient({ dashboards: [makeDashboard({ dashlets: [chartDashlet('C1')] })] });
    const step = await resolveTarget(makeContext(fake), { dashboard: 'D1', dashlet: 'C1' });

    expect(step).toMatchObject({ ok: false, code: 'usage_error' });
  });

  it('prefers the push map over the name match', async () => {
    const mapped = customCodeDashlet('X1', { name: 'renamed' });
    const named = customCodeDashlet('X2');
    const fake = makeClient({ dashboards: [makeDashboard({ dashlets: [named, mapped] })] });
    const step = await resolveTarget(makeContext(fake, makeEntry()), { dashboard: 'D1' });

    expect(step).toMatchObject({
      ok: true,
      value: { action: 'update', dashlet: mapped, resolvedBy: 'push_map' },
    });
  });

  it('falls back to the push-key name', async () => {
    const named = customCodeDashlet('X2');
    const fake = makeClient({ dashboards: [makeDashboard({ dashlets: [named] })] });
    const step = await resolveTarget(makeContext(fake), { dashboard: 'D1' });

    expect(step).toMatchObject({
      ok: true,
      value: { action: 'update', dashlet: named, resolvedBy: 'name' },
    });
  });

  it('never auto-picks between two dashlets with the same push key', async () => {
    const fake = makeClient({
      dashboards: [makeDashboard({ dashlets: [customCodeDashlet('X1'), customCodeDashlet('X2')] })],
    });
    const step = await resolveTarget(makeContext(fake), { dashboard: 'D1' });

    expect(step).toMatchObject({ ok: false, code: 'needs_choice', choice: 'target' });

    const choices = step.ok ? [] : (step.choices ?? []);

    expect(choices.map((choice) => choice.value)).toStrictEqual(['X1', 'X2', 'new']);
    expect(choices.at(-1)).toStrictEqual({
      value: 'new',
      label: 'Create a new block',
      args: ['--dashboard', 'D1', '--create'],
    });
  });

  it('asks for a target when the dashboard has no match', async () => {
    const fake = makeClient({ dashboards: [makeDashboard({ dashlets: [chartDashlet('C1')] })] });
    const step = await resolveTarget(makeContext(fake), { dashboard: 'D1' });

    expect(step).toMatchObject({
      ok: false,
      code: 'needs_choice',
      choice: 'target',
      choices: [{ value: 'new' }],
    });
  });

  it('maps a missing --dashboard to not_found', async () => {
    const step = await resolveTarget(makeContext(makeClient()), { dashboard: 'NOPE' });

    expect(step).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('updates the remembered dashlet with no flags', async () => {
    const dashlet = customCodeDashlet('X1');
    const fake = makeClient({ dashboards: [makeDashboard({ dashlets: [dashlet] })] });
    const step = await resolveTarget(makeContext(fake, makeEntry()), {});

    expect(step).toMatchObject({
      ok: true,
      value: { action: 'update', dashlet, resolvedBy: 'remembered' },
    });
    expect(fake.getDashboard).toHaveBeenCalledWith('D1');
    expect(fake.listDashboards).not.toHaveBeenCalled();
  });

  it('reports a deleted remembered dashlet as remembered_target_missing with choices', async () => {
    const fake = makeClient({
      dashboards: [makeDashboard({ dashlets: [customCodeDashlet('X2', { name: 'other' })] })],
    });
    const step = await resolveTarget(makeContext(fake, makeEntry()), {});

    expect(step).toMatchObject({ ok: false, code: 'remembered_target_missing', choice: 'target' });
    expect(!step.ok && step.choices?.map((choice) => choice.value)).toStrictEqual(['X2', 'new']);
  });

  it('reports a remembered dashlet that moved dashboards as missing', async () => {
    const fake = makeClient({
      dashboards: [makeDashboard({ dashlets: [customCodeDashlet('X1', { dashboard: 'D2' })] })],
    });
    const step = await resolveTarget(makeContext(fake, makeEntry()), {});

    expect(step).toMatchObject({ ok: false, code: 'remembered_target_missing' });
  });

  it('reports a deleted remembered dashboard as remembered_target_missing without choices', async () => {
    const step = await resolveTarget(makeContext(makeClient(), makeEntry()), {});

    expect(step).toMatchObject({ ok: false, code: 'remembered_target_missing' });
    expect(step.ok || 'choices' in step).toBe(false);
  });

  it('passes through a non-404 error on the remembered dashboard', async () => {
    const fake = makeClient();

    fake.getDashboard.mockRejectedValueOnce(new KizenApiError('forbidden', 'no', { hint: 'h' }));

    const step = await resolveTarget(makeContext(fake, makeEntry()), {});

    expect(step).toStrictEqual({ ok: false, code: 'forbidden', message: 'no', hint: 'h' });
  });

  it('creates on the remembered dashboard with --create', async () => {
    const dashboard = makeDashboard({ dashlets: [customCodeDashlet('X1')] });
    const fake = makeClient({ dashboards: [dashboard] });
    const step = await resolveTarget(makeContext(fake, makeEntry()), { create: true });

    expect(step).toMatchObject({
      ok: true,
      value: { dashboard, action: 'create', resolvedBy: 'remembered' },
    });
  });

  it('asks for a dashboard when nothing is resolvable, listing dashboards and homepages', async () => {
    const fake = makeClient({
      summaries: {
        generic_dashboard: [summary(), summary({ id: 'D2', name: 'Ops', employee_access: 'View' })],
        homepage: [summary({ id: 'H1', name: 'Home', type: 'homepage', employee_access: null })],
        chart_group: [summary({ id: 'G1' })],
      },
    });
    const step = await resolveTarget(makeContext(fake), {});

    expect(step).toMatchObject({ ok: false, code: 'needs_choice', choice: 'dashboard' });
    expect(!step.ok && step.message).toContain('appbuilder block targets --object <id> --json');
    expect(!step.ok && step.choices).toStrictEqual([
      {
        value: 'D1',
        label: 'Sales',
        args: ['--dashboard', 'D1'],
        surface: 'dashboard',
        canEdit: true,
      },
      {
        value: 'D2',
        label: 'Ops',
        args: ['--dashboard', 'D2'],
        surface: 'dashboard',
        canEdit: false,
      },
      {
        value: 'H1',
        label: 'Home',
        args: ['--dashboard', 'H1'],
        surface: 'homepage',
        canEdit: null,
      },
    ]);
    expect(fake.listDashboards.mock.calls).toStrictEqual([['generic_dashboard'], ['homepage']]);
  });
});

describe('headlessWriteGate', () => {
  it('treats --dry-run as a dry run even with --yes', () => {
    expect(headlessWriteGate({ dryRun: true, yes: true }, 'go')).toStrictEqual({
      ok: true,
      value: { kind: 'dry-run', reason: 'flag' },
    });
  });

  it('is a dry run without --yes', () => {
    expect(headlessWriteGate({}, 'staging')).toStrictEqual({
      ok: true,
      value: { kind: 'dry-run', reason: 'no_yes' },
    });
  });

  it.each(['go', 'fmo'] as const)('requires --allow-production on %s', (environment) => {
    expect(headlessWriteGate({ yes: true }, environment)).toMatchObject({
      ok: false,
      code: 'production_requires_flag',
    });
    expect(headlessWriteGate({ yes: true, allowProduction: true }, environment)).toStrictEqual({
      ok: true,
      value: { kind: 'apply' },
    });
  });

  it('applies on non-production with --yes', () => {
    expect(headlessWriteGate({ yes: true }, 'integration')).toStrictEqual({
      ok: true,
      value: { kind: 'apply' },
    });
  });
});

describe('buildPlan', () => {
  it('builds a create plan with the push-key name and layout below existing dashlets', async () => {
    const dashboard = makeDashboard({ dashlets: [customCodeDashlet('X1'), chartDashlet('C1')] });
    const fake = makeClient({ dashboards: [dashboard] });
    const step = await buildPlan(
      makeContext(fake),
      { dashboard, surface: 'dashboard', action: 'create', dashlet: undefined, resolvedBy: 'flag' },
      {},
      { randomUUID: vi.fn().mockReturnValueOnce('obj-uuid').mockReturnValueOnce('layout-uuid') },
    );

    expect(step.ok).toBe(true);

    const plan = step.ok ? step.value : undefined;

    expect(plan?.method).toBe('POST');
    expect(plan?.path).toBe('/dashboards/D1/dashlet');
    expect(plan?.dashletId).toBeNull();
    expect(plan?.body).toStrictEqual({
      name: 'appbuilder:acme/chart',
      layout: { i: 'layout-uuid', x: 0, y: 9, w: 4, h: 3 },
      config: {
        object_id: 'obj-uuid',
        entity_type: 'static_content',
        report_type: 'html',
        chart_type: 'html',
        content: toCustomCodeContent(makeBlock()),
        fe_extra_info: {},
      },
    });
    expect(plan?.summary).toStrictEqual({
      environment: 'staging',
      businessId: 'biz',
      isProduction: false,
      surface: 'dashboard',
      dashboardId: 'D1',
      dashboardName: 'Sales',
      action: 'create',
      actionLine: 'Create a new block on "Sales"',
      dashletId: null,
      blockName: 'Chart',
      blockApiName: 'chart',
      pluginApiName: 'acme',
      scriptBytes: Buffer.byteLength('this.outputUI("hi");'),
      stylesBytes: Buffer.byteLength('.x { color: red; }'),
    });
  });

  it('counts script bytes in utf-8', async () => {
    const dashboard = makeDashboard();
    const context = makeContext(makeClient({ dashboards: [dashboard] }));
    const content = { ...context.block.content, script: 'é', styles: '' };
    const step = await buildPlan(
      { ...context, block: { ...context.block, content } },
      { dashboard, surface: 'dashboard', action: 'create', dashlet: undefined, resolvedBy: 'flag' },
      {},
      { randomUUID: () => 'u' },
    );

    expect(step.ok && step.value.summary).toMatchObject({ scriptBytes: 2, stylesBytes: 0 });
  });

  it('builds an update body with only config, keeping object_id and stored style keys', async () => {
    const dashlet = customCodeDashlet('X1', { objectId: 'keep-me' });
    const dashboard = makeDashboard({ dashlets: [dashlet] });
    const randomUUID = vi.fn(() => 'unused');
    const step = await buildPlan(
      makeContext(makeClient({ dashboards: [dashboard] })),
      { dashboard, surface: 'dashboard', action: 'update', dashlet, resolvedBy: 'name' },
      {},
      { randomUUID },
    );
    const plan = step.ok ? step.value : undefined;

    expect(plan?.method).toBe('PATCH');
    expect(plan?.path).toBe('/dashboards/D1/dashlet/X1');
    expect(plan?.dashletId).toBe('X1');
    expect(plan?.summary.actionLine).toBe('Update "Chart" (dashlet X1)');
    expect(Object.keys(plan?.body ?? {})).toStrictEqual(['config']);
    expect(plan?.body).toStrictEqual({
      config: {
        object_id: 'keep-me',
        entity_type: 'static_content',
        report_type: 'html',
        chart_type: 'html',
        content: toCustomCodeContent(makeBlock()),
        fe_extra_info: {
          custom_styles_enabled: true,
          dashlet_style_config: { drop_shadow: true, border: 'thin' },
        },
      },
    });
    expect(JSON.stringify(plan?.body)).not.toContain('custom_object');
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it('carries stored style keys over untouched on update', async () => {
    const base = customCodeDashlet('X1');
    const feExtraInfo = {
      custom_styles_enabled: false,
      dashlet_style_config: { drop_shadow: false },
    };
    const dashlet = { ...base, config: { ...base.config, fe_extra_info: feExtraInfo } };
    const dashboard = makeDashboard({ dashlets: [dashlet] });
    const step = await buildPlan(
      makeContext(makeClient({ dashboards: [dashboard] })),
      { dashboard, surface: 'dashboard', action: 'update', dashlet, resolvedBy: 'name' },
      {},
      { randomUUID: () => 'u' },
    );

    expect(step.ok && step.value.body.config.fe_extra_info).toStrictEqual(feExtraInfo);
  });

  it('refuses drift unless --force, and warns when forced', async () => {
    const dashlet = customCodeDashlet('X1', { script: 'edited in the UI' });
    const dashboard = makeDashboard({ dashlets: [dashlet] });
    const context = makeContext(makeClient({ dashboards: [dashboard] }), makeEntry());
    const resolved = {
      dashboard,
      surface: 'dashboard' as const,
      action: 'update' as const,
      dashlet,
      resolvedBy: 'remembered' as const,
    };
    const refused = await buildPlan(context, resolved, {}, { randomUUID: () => 'u' });

    expect(refused).toMatchObject({ ok: false, code: 'drift_detected' });

    const forced = await buildPlan(context, resolved, { force: true }, { randomUUID: () => 'u' });

    expect(forced.ok).toBe(true);
    expect(forced.ok && forced.value.warnings).toHaveLength(1);
  });

  it.each([
    [
      { id: 'CO1', fetch_url: 'deals' },
      [],
      'https://v2.staging.kizen.com/custom-objects/CO1/charts/G1',
    ],
    [{ id: 'CL', fetch_url: 'client' }, [], 'https://v2.staging.kizen.com/clients/charts/G1'],
    [
      'CL',
      [{ id: 'CL', object_name: 'Contacts', fetch_url: 'client' }],
      'https://v2.staging.kizen.com/clients/charts/G1',
    ],
    [
      'CO1',
      [{ id: 'CO1', object_name: 'Deals', fetch_url: 'pipeline' }],
      'https://v2.staging.kizen.com/custom-objects/CO1/charts/G1',
    ],
    ['CO1', [], 'https://v2.staging.kizen.com/custom-objects/CO1/charts/G1'],
  ] as const)(
    'builds a chart-group URL from custom_object %j',
    async (customObject, objects, url) => {
      const dashboard = makeDashboard({
        id: 'G1',
        type: 'chart_group',
        custom_object: customObject,
      });
      const fake = makeClient({ dashboards: [dashboard], objectDetails: [...objects] });
      const step = await buildPlan(
        makeContext(fake),
        {
          dashboard,
          surface: 'chart_group',
          action: 'create',
          dashlet: undefined,
          resolvedBy: 'flag',
        },
        {},
        { randomUUID: () => 'u' },
      );

      expect(step.ok && step.value.url).toBe(url);
      expect(step.ok && step.value.dashboard).toStrictEqual({
        id: 'G1',
        name: 'Sales',
        type: 'chart_group',
      });
      expect(fake.listCustomObjects).not.toHaveBeenCalled();
    },
  );

  it('looks up a bare custom_object id with getCustomObject', async () => {
    const dashboard = makeDashboard({ id: 'G1', type: 'chart_group', custom_object: 'CL' });
    const fake = makeClient({
      dashboards: [dashboard],
      objectDetails: [{ id: 'CL', object_name: 'Contacts', fetch_url: 'client' }],
    });

    await buildPlan(
      makeContext(fake),
      {
        dashboard,
        surface: 'chart_group',
        action: 'create',
        dashlet: undefined,
        resolvedBy: 'flag',
      },
      {},
      { randomUUID: () => 'u' },
    );

    expect(fake.getCustomObject.mock.calls).toStrictEqual([['CL']]);
    expect(fake.listCustomObjects).not.toHaveBeenCalled();
  });

  it('falls back to the custom-objects URL when getCustomObject fails', async () => {
    const dashboard = makeDashboard({ id: 'G1', type: 'chart_group', custom_object: 'CO1' });
    const fake = makeClient({ dashboards: [dashboard] });

    fake.getCustomObject.mockRejectedValueOnce(new KizenApiError('forbidden', 'no'));

    const step = await buildPlan(
      makeContext(fake),
      {
        dashboard,
        surface: 'chart_group',
        action: 'create',
        dashlet: undefined,
        resolvedBy: 'flag',
      },
      {},
      { randomUUID: () => 'u' },
    );

    expect(step.ok && step.value.url).toBe(
      'https://v2.staging.kizen.com/custom-objects/CO1/charts/G1',
    );
  });

  it('builds a homepage URL', async () => {
    const dashboard = makeDashboard({ id: 'H1', type: 'homepage' });
    const step = await buildPlan(
      makeContext(makeClient({ dashboards: [dashboard] })),
      { dashboard, surface: 'homepage', action: 'create', dashlet: undefined, resolvedBy: 'flag' },
      {},
      { randomUUID: () => 'u' },
    );

    expect(step.ok && step.value.url).toBe('https://v2.staging.kizen.com/home/H1');
  });
});

const DASHBOARD_UUID = '5f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

describe('buildBrowserRefresh', () => {
  it('builds the refresh script with the dashboard id interpolated', () => {
    expect(buildBrowserRefresh(DASHBOARD_UUID)).toStrictEqual({
      dashboardId: DASHBOARD_UUID,
      script: `await window.__kizenCustomBlocks?.refresh('${DASHBOARD_UUID}')`,
    });
  });

  it('accepts an upper-case uuid unchanged', () => {
    const upper = DASHBOARD_UUID.toUpperCase();

    expect(buildBrowserRefresh(upper)?.script).toBe(
      `await window.__kizenCustomBlocks?.refresh('${upper}')`,
    );
  });

  it.each([
    ['a non-uuid id', 'D1'],
    ['an empty id', ''],
    ['a quote-breaking id', `${DASHBOARD_UUID}'); alert(1); ('`],
    ['a uuid with a trailing newline', `${DASHBOARD_UUID}\n`],
    ['a uuid with surrounding spaces', ` ${DASHBOARD_UUID} `],
    ['a uuid without dashes', DASHBOARD_UUID.replaceAll('-', '')],
    ['a uuid with a non-hex character', `${DASHBOARD_UUID.slice(0, -1)}g`],
  ])('returns null for %s', (_label, id) => {
    expect(buildBrowserRefresh(id)).toBeNull();
  });
});

describe('runPushHeadless', () => {
  const salesWith = (...dashlets: WireDashlet[]): WireDashboard => makeDashboard({ dashlets });

  it('is a dry run without --yes and never writes', async () => {
    const fake = makeClient({
      dashboards: [salesWith(customCodeDashlet('X1'), chartDashlet('C1'))],
    });
    const harness = await runPush(makeHarness({ fake }), { dashboard: 'D1', create: true });

    expect(harness.json()).toStrictEqual({
      ok: true,
      applied: false,
      dryRun: true,
      reason: 'no_yes',
      action: 'create',
      environment: 'staging',
      businessId: 'biz',
      dashboard: { id: 'D1', name: 'Sales', type: 'dashboard' },
      dashletId: null,
      url: 'https://v2.staging.kizen.com/dashboard/D1',
      resolvedBy: 'flag',
      block: { pluginApiName: 'acme', apiName: 'chart', name: 'Chart' },
      method: 'POST',
      path: '/dashboards/D1/dashlet',
      body: {
        name: 'appbuilder:acme/chart',
        layout: { i: 'uuid-2', x: 0, y: 9, w: 4, h: 3 },
        config: {
          object_id: 'uuid-1',
          entity_type: 'static_content',
          report_type: 'html',
          chart_type: 'html',
          content: toCustomCodeContent(makeBlock()),
          fe_extra_info: {},
        },
      },
      warnings: [],
    });
    expect(harness.stderr.join('')).toContain('Dry run only: pass --yes to write.');
    expect(fake.createDashlet).not.toHaveBeenCalled();
    expect(fake.updateDashlet).not.toHaveBeenCalled();
    expect(harness.deps.writePushMap).not.toHaveBeenCalled();
    expect(harness.deps.ensureGitignore).not.toHaveBeenCalled();
    expect(harness.exitCodes).toStrictEqual([]);
  });

  it("reports --dry-run --yes as reason 'flag' without the --yes note", async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(makeHarness({ fake }), {
      dashboard: 'D1',
      create: true,
      dryRun: true,
      yes: true,
    });

    expect(harness.json()).toMatchObject({ dryRun: true, applied: false, reason: 'flag' });
    expect(harness.stderr.join('')).not.toContain('Dry run only');
    expect(fake.createDashlet).not.toHaveBeenCalled();
  });

  it('applies a create, remembers it and prints the contract JSON', async () => {
    const fake = makeClient({ dashboards: [salesWith(chartDashlet('C1'))] });
    const harness = await runPush(makeHarness({ fake }), {
      dashboard: 'D1',
      create: true,
      yes: true,
    });

    expect(harness.json()).toStrictEqual({
      ok: true,
      applied: true,
      dryRun: false,
      action: 'created',
      environment: 'staging',
      businessId: 'biz',
      dashboard: { id: 'D1', name: 'Sales', type: 'dashboard' },
      dashletId: 'NEW',
      url: 'https://v2.staging.kizen.com/dashboard/D1',
      resolvedBy: 'flag',
      block: { pluginApiName: 'acme', apiName: 'chart', name: 'Chart' },
      remembered: true,
      warnings: [],
    });
    expect(fake.createDashlet).toHaveBeenCalledTimes(1);
    expect(fake.createDashlet.mock.calls[0]?.[0]).toBe('D1');
    expect(harness.events).toStrictEqual(['ensureGitignore', 'writePushMap']);
    expect(harness.deps.ensureGitignore).toHaveBeenCalledWith(CWD);
    expect(harness.pushMap.entries).toStrictEqual([
      {
        environment: 'staging',
        businessId: 'biz',
        pluginApiName: 'acme',
        blockApiName: 'chart',
        dashboardId: 'D1',
        dashletId: 'NEW',
        contentHash: BLOCK_HASH,
        pushedAt: PUSHED_AT,
      },
    ]);
    expect(harness.exitCodes).toStrictEqual([]);
  });

  it('adds the browser refresh to an applied push on a uuid dashboard', async () => {
    const fake = makeClient({ dashboards: [makeDashboard({ id: DASHBOARD_UUID })] });
    const harness = await runPush(makeHarness({ fake }), {
      dashboard: DASHBOARD_UUID,
      create: true,
      yes: true,
    });

    expect(harness.json()).toMatchObject({
      applied: true,
      dashboard: { id: DASHBOARD_UUID },
      refresh: {
        dashboardId: DASHBOARD_UUID,
        script: `await window.__kizenCustomBlocks?.refresh('${DASHBOARD_UUID}')`,
      },
    });
  });

  it('omits the browser refresh from a dry run on a uuid dashboard', async () => {
    const fake = makeClient({ dashboards: [makeDashboard({ id: DASHBOARD_UUID })] });
    const harness = await runPush(makeHarness({ fake }), {
      dashboard: DASHBOARD_UUID,
      create: true,
    });

    expect(harness.json()).toMatchObject({ applied: false, dryRun: true });
    expect(harness.json()).not.toHaveProperty('refresh');
    expect(harness.stderr.join('')).not.toContain('Refresh an open tab');
  });

  it('omits the browser refresh from an applied push when the dashboard id is not a uuid', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(makeHarness({ fake }), {
      dashboard: 'D1',
      create: true,
      yes: true,
    });

    expect(harness.json()).toMatchObject({ applied: true });
    expect(harness.json()).not.toHaveProperty('refresh');
    expect(harness.stderr.join('')).not.toContain('Refresh an open tab');
  });

  it('re-pushes to the remembered dashlet with zero flags', async () => {
    const fake = makeClient({ dashboards: [salesWith(customCodeDashlet('X1'))] });
    const harness = await runPush(makeHarness({ fake, pushMap: [makeEntry()] }), { yes: true });

    expect(harness.json()).toMatchObject({
      ok: true,
      applied: true,
      action: 'updated',
      dashletId: 'X1',
      resolvedBy: 'remembered',
      remembered: true,
    });

    const [dashboardId, dashletId, body] = fake.updateDashlet.mock.calls[0] ?? [];

    expect([dashboardId, dashletId]).toStrictEqual(['D1', 'X1']);
    expect(Object.keys(body as object)).toStrictEqual(['config']);
    expect(harness.pushMap.entries).toStrictEqual([
      makeEntry({ contentHash: BLOCK_HASH, pushedAt: PUSHED_AT }),
    ]);
    expect(canonicalContentHash((body as { config: { content: unknown } }).config.content)).toBe(
      BLOCK_HASH,
    );
  });

  it('replaces the entry when pushing to another dashboard', async () => {
    const other = makeDashboard({ id: 'D2', name: 'Ops', dashlets: [] });
    const fake = makeClient({ dashboards: [salesWith(customCodeDashlet('X1')), other] });
    const unrelated = makeEntry({ blockApiName: 'table', dashletId: 'T1' });
    const harness = await runPush(makeHarness({ fake, pushMap: [makeEntry(), unrelated] }), {
      dashboard: 'D2',
      create: true,
      yes: true,
    });

    expect(harness.json()).toMatchObject({ action: 'created', dashboard: { id: 'D2' } });
    expect(harness.pushMap.entries).toStrictEqual([
      makeEntry({
        dashboardId: 'D2',
        dashletId: 'NEW',
        contentHash: BLOCK_HASH,
        pushedAt: PUSHED_AT,
      }),
      unrelated,
    ]);
  });

  it('--forget removes the entry and reports forgotten: true', async () => {
    const fake = makeClient({
      dashboards: [salesWith(customCodeDashlet('X1', { name: 'hand made' }))],
      summaries: { generic_dashboard: [summary()] },
    });
    const harness = await runPush(makeHarness({ fake, pushMap: [makeEntry()] }), {
      forget: true,
      dashboard: 'D1',
      create: true,
    });

    expect(harness.json()).toMatchObject({
      ok: true,
      dryRun: true,
      forgotten: true,
      resolvedBy: 'flag',
    });
    expect(harness.pushMap.entries).toStrictEqual([]);
    expect(fake.createDashlet).not.toHaveBeenCalled();
  });

  it('--forget without a remembered entry omits forgotten and writes nothing', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(makeHarness({ fake }), {
      forget: true,
      dashboard: 'D1',
      create: true,
    });

    expect(harness.json()).not.toHaveProperty('forgotten');
    expect(harness.deps.writePushMap).not.toHaveBeenCalled();
  });

  it('--forget drops the remembered target so resolution needs a choice', async () => {
    const fake = makeClient({
      dashboards: [salesWith(customCodeDashlet('X1', { name: 'hand made' }))],
      summaries: { generic_dashboard: [summary()] },
    });
    const harness = await runPush(makeHarness({ fake, pushMap: [makeEntry()] }), {
      forget: true,
      yes: true,
    });

    expect(harness.json()).toMatchObject({ ok: false, code: 'needs_choice', choice: 'dashboard' });
    expect(harness.pushMap.entries).toStrictEqual([]);
    expect(fake.getDashboard).not.toHaveBeenCalled();
  });

  it('keeps ok but remembered:false when the push map cannot be written', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(makeHarness({ fake, writePushMapError: new Error('EACCES') }), {
      dashboard: 'D1',
      create: true,
      yes: true,
    });
    const result = harness.json() as { ok: boolean; remembered: boolean; warnings: string[] };

    expect(result.ok).toBe(true);
    expect(result.remembered).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('EACCES');
    expect(harness.exitCodes).toStrictEqual([]);
  });

  it('keeps ok but remembered:false when ensureGitignore throws', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(
      makeHarness({
        fake,
        deps: {
          ensureGitignore: () => {
            throw new Error('read-only');
          },
        },
      }),
      { dashboard: 'D1', create: true, yes: true },
    );

    expect(harness.json()).toMatchObject({ ok: true, remembered: false });
    expect(harness.deps.writePushMap).not.toHaveBeenCalled();
  });

  it('reports drift in a dry run and in an apply, and --force overrides it', async () => {
    const drifted = (): FakeClient =>
      makeClient({ dashboards: [salesWith(customCodeDashlet('X1', { script: 'ui edit' }))] });

    for (const options of [{}, { yes: true }] satisfies PushCommandOptions[]) {
      const fake = drifted();
      const harness = await runPush(makeHarness({ fake, pushMap: [makeEntry()] }), options);

      expect(harness.json()).toMatchObject({ ok: false, code: 'drift_detected' });
      expect(harness.exitCodes).toStrictEqual([1]);
      expect(fake.updateDashlet).not.toHaveBeenCalled();
    }

    const fake = drifted();
    const forced = await runPush(makeHarness({ fake, pushMap: [makeEntry()] }), {
      yes: true,
      force: true,
    });
    const result = forced.json() as { ok: boolean; action: string; warnings: string[] };

    expect(result).toMatchObject({ ok: true, action: 'updated' });
    expect(result.warnings).toHaveLength(1);
    expect(fake.updateDashlet).toHaveBeenCalledTimes(1);
  });

  it.each(['go', 'fmo'] as const)(
    'refuses %s with --yes but without --allow-production, and writes nothing',
    async (environment: Environment) => {
      const fake = makeClient({ dashboards: [salesWith()] });
      const harness = await runPush(
        makeHarness({ fake, credentials: makeCredentials({ environment }) }),
        { dashboard: 'D1', create: true, yes: true },
      );

      expect(harness.json()).toMatchObject({ ok: false, code: 'production_requires_flag' });
      expect(harness.exitCodes).toStrictEqual([1]);
      expect(fake.createDashlet).not.toHaveBeenCalled();
      expect(harness.deps.writePushMap).not.toHaveBeenCalled();
    },
  );

  it('applies on production with --allow-production', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(
      makeHarness({ fake, credentials: makeCredentials({ environment: 'go' }) }),
      { dashboard: 'D1', create: true, yes: true, allowProduction: true },
    );

    expect(harness.json()).toMatchObject({
      ok: true,
      applied: true,
      environment: 'go',
      url: 'https://go.kizen.com/dashboard/D1',
    });
    expect(fake.createDashlet).toHaveBeenCalledTimes(1);
  });

  it('lets a production dry run through without --allow-production', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(
      makeHarness({ fake, credentials: makeCredentials({ environment: 'go' }) }),
      { dashboard: 'D1', create: true },
    );

    expect(harness.json()).toMatchObject({ ok: true, dryRun: true, reason: 'no_yes' });
  });

  it.each([
    [
      new KizenApiError('auth_failed', 'GET /dashboards/D1 failed with 401', {
        status: 401,
        hint: 'The API key is invalid',
      }),
      {
        ok: false,
        code: 'auth_failed',
        message: 'GET /dashboards/D1 failed with 401',
        hint: 'The API key is invalid',
      },
    ],
    [
      new KizenApiError('forbidden', 'GET /dashboards/D1 failed with 403', {
        status: 403,
        hint: 'needs permission',
      }),
      {
        ok: false,
        code: 'forbidden',
        message: 'GET /dashboards/D1 failed with 403',
        hint: 'needs permission',
      },
    ],
    [
      new KizenApiError('network_error', "Couldn't reach Kizen"),
      { ok: false, code: 'network_error', message: "Couldn't reach Kizen" },
    ],
  ])('maps %s to one JSON failure and exit code 1', async (error, expected) => {
    const fake = makeClient();

    fake.getDashboard.mockRejectedValueOnce(error);

    const harness = await runPush(makeHarness({ fake }), { dashboard: 'D1', yes: true });

    expect(harness.json()).toStrictEqual(expected);
    expect(harness.exitCodes).toStrictEqual([1]);
  });

  it('maps a write failure to a JSON failure and does not remember it', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });

    fake.createDashlet.mockRejectedValueOnce(
      new KizenApiError('forbidden', 'POST failed with 403', { hint: 'Customize Homepages' }),
    );

    const harness = await runPush(makeHarness({ fake }), {
      dashboard: 'D1',
      create: true,
      yes: true,
    });

    expect(harness.json()).toStrictEqual({
      ok: false,
      code: 'forbidden',
      message: 'POST failed with 403',
      hint: 'Customize Homepages',
    });
    expect(harness.deps.writePushMap).not.toHaveBeenCalled();
    expect(harness.exitCodes).toStrictEqual([1]);
  });

  it('wraps an unexpected throw as local_error instead of crashing', async () => {
    const harness = await runPush(
      makeHarness({ deps: { readPushMap: () => Promise.reject(new Error('disk gone')) } }),
      { dashboard: 'D1' },
    );

    expect(harness.json()).toStrictEqual({ ok: false, code: 'local_error', message: 'disk gone' });
    expect(harness.exitCodes).toStrictEqual([1]);
  });

  it('reports a packaging failure that is not a validation error as local_error', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(
      makeHarness({ fake, packageError: new Error('No kizen.json found in /work/acme') }),
      { dashboard: 'D1', create: true, yes: true },
    );

    expect(harness.json()).toStrictEqual({
      ok: false,
      code: 'local_error',
      message: 'No kizen.json found in /work/acme',
    });
    expect(harness.exitCodes).toStrictEqual([1]);
    expect(fake.getDashboard).not.toHaveBeenCalled();
    expect(fake.createDashlet).not.toHaveBeenCalled();
  });

  it('reports a corrupt push map as local_error and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'push-headless-'));

    try {
      await mkdir(join(dir, '.kizenapp'), { recursive: true });
      await writeFile(join(dir, PUSH_MAP_RELATIVE_PATH), '{not json', 'utf8');

      const fake = makeClient({ dashboards: [salesWith(customCodeDashlet('X1'))] });
      const harness = await runPush(
        makeHarness({ fake, deps: { readPushMap: () => readPushMap(dir) } }),
        { dashboard: 'D1', create: true, yes: true },
      );
      const result = harness.json() as { ok: boolean; code: string; message: string };

      expect(result).toMatchObject({ ok: false, code: 'local_error' });
      expect(result.message).toContain(PUSH_MAP_RELATIVE_PATH);
      expect(harness.exitCodes).toStrictEqual([1]);
      expect(fake.createDashlet).not.toHaveBeenCalled();
      expect(fake.updateDashlet).not.toHaveBeenCalled();
      expect(harness.deps.writePushMap).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a --forget write failure as local_error', async () => {
    const fake = makeClient({ dashboards: [salesWith(customCodeDashlet('X1'))] });
    const harness = await runPush(
      makeHarness({ fake, pushMap: [makeEntry()], writePushMapError: new Error('EACCES') }),
      { forget: true, dashboard: 'D1', create: true, yes: true },
    );

    expect(harness.json()).toStrictEqual({ ok: false, code: 'local_error', message: 'EACCES' });
    expect(fake.createDashlet).not.toHaveBeenCalled();
  });

  it('writes block warnings to stderr and into the JSON warnings', async () => {
    const warning: ValidationIssue = {
      rule: 'block/size',
      severity: 'warning',
      message: 'large script',
      path: 'blocks/chart',
    };
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(makeHarness({ fake, warnings: [warning] }), {
      dashboard: 'D1',
      create: true,
    });

    expect(harness.json()).toMatchObject({ warnings: ['blocks/chart: large script (block/size)'] });
    expect(harness.stderr.join('')).toContain('large script (block/size)');
  });

  describe('Claude skill notice', () => {
    const skillPath = '.claude/skills/kizen-custom-block/SKILL.md';
    const staleWarning =
      'Claude files managed by appbuilder are out of date; run appbuilder setup-claude';

    const pushIn = async (setup: (dir: string) => Promise<void>): Promise<Harness> => {
      const dir = await mkdtemp(join(tmpdir(), 'push-skill-'));

      try {
        await setup(dir);

        const fake = makeClient({ dashboards: [salesWith()] });
        const deps = { cwd: dir, isClaudeSkillStale };

        return await runPush(makeHarness({ fake, deps }), {
          dashboard: 'D1',
          create: true,
          yes: true,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };

    it('adds the out-of-date warning when the skill differs from the bundled one', async () => {
      const harness = await pushIn(async (dir) => {
        await mkdir(join(dir, '.claude/skills/kizen-custom-block'), { recursive: true });
        await writeFile(join(dir, skillPath), 'edited locally\n');
      });

      expect(harness.json()).toMatchObject({ ok: true, applied: true, warnings: [staleWarning] });
      expect(harness.stdout.join('') + harness.stderr.join('')).toContain(
        `Warning: ${staleWarning}`,
      );
      expect(harness.exitCodes).toStrictEqual([]);
    });

    it('adds nothing when the skill is missing', async () => {
      const harness = await pushIn(() => Promise.resolve());

      expect(harness.json()).toMatchObject({ ok: true, applied: true, warnings: [] });
      expect(harness.exitCodes).toStrictEqual([]);
    });

    it('adds nothing when every Claude file matches the bundled one', async () => {
      const harness = await pushIn(async (dir) => {
        await mkdir(join(dir, '.claude/skills/kizen-custom-block'), { recursive: true });

        for (const file of claudeFiles()) {
          await mkdir(dirname(join(dir, file.path)), { recursive: true });
          await writeFile(join(dir, file.path), file.content);
        }
      });

      expect(harness.json()).toMatchObject({ ok: true, applied: true, warnings: [] });
    });

    it('adds the out-of-date warning when the skill matches but the design guide is missing', async () => {
      const [skill] = claudeFiles();
      const harness = await pushIn(async (dir) => {
        await mkdir(join(dir, '.claude/skills/kizen-custom-block'), { recursive: true });
        await writeFile(join(dir, skillPath), skill?.content ?? '');
      });

      expect(harness.json()).toMatchObject({ ok: true, applied: true, warnings: [staleWarning] });
    });

    it('adds the out-of-date warning when only the kizenData lib differs', async () => {
      const harness = await pushIn(async (dir) => {
        for (const file of claudeFiles()) {
          await mkdir(dirname(join(dir, file.path)), { recursive: true });
          await writeFile(
            join(dir, file.path),
            file.path === 'src/lib/kizenData.js' ? 'export const mine = 1;\n' : file.content,
          );
        }
      });

      expect(harness.json()).toMatchObject({ ok: true, applied: true, warnings: [staleWarning] });
    });

    it('adds the warning to a dry run too', async () => {
      const fake = makeClient({ dashboards: [salesWith()] });
      const deps = { isClaudeSkillStale: vi.fn(() => Promise.resolve(true)) };
      const harness = await runPush(makeHarness({ fake, deps }), { dashboard: 'D1', create: true });

      expect(harness.json()).toMatchObject({ dryRun: true, warnings: [staleWarning] });
      expect(deps.isClaudeSkillStale).toHaveBeenCalledWith(CWD);
    });

    it('ignores a failing staleness check and still pushes', async () => {
      const fake = makeClient({ dashboards: [salesWith()] });
      const deps = { isClaudeSkillStale: vi.fn(() => Promise.reject(new Error('EACCES'))) };
      const harness = await runPush(makeHarness({ fake, deps }), {
        dashboard: 'D1',
        create: true,
        yes: true,
      });

      expect(harness.json()).toMatchObject({ ok: true, applied: true, warnings: [] });
      expect(harness.exitCodes).toStrictEqual([]);
    });
  });

  it('stops at credentials before creating a client', async () => {
    const harness = await runPush(makeHarness({ profiles: [] }), {});

    expect(harness.json()).toMatchObject({ ok: false, code: 'credentials_invalid' });
    expect(harness.deps.createClient).not.toHaveBeenCalled();
    expect(harness.deps.packageBlocks).not.toHaveBeenCalled();
  });

  describe('host_chrome', () => {
    const chromeBlock = (hostChrome: unknown): Block =>
      ({ ...makeBlock(), host_chrome: hostChrome }) as unknown as Block;

    const pushedDashlet = (content: Record<string, unknown>): WireDashlet => {
      const dashlet = customCodeDashlet('X1');

      return { ...dashlet, config: { ...dashlet.config, content } };
    };

    it('shows host_chrome false in the --dry-run --json body content', async () => {
      const fake = makeClient({ dashboards: [salesWith()] });
      const harness = await runPush(
        makeHarness({ fake, deployable: [makePlugin(PLUGIN, [chromeBlock(false)])] }),
        { dashboard: 'D1', create: true, dryRun: true },
      );
      const result = harness.json() as { body: { config: { content: Record<string, unknown> } } };

      expect(result).toMatchObject({ ok: true, dryRun: true, applied: false });
      expect(result.body.config.content.host_chrome).toBe(false);
      expect(result.body.config.content).toStrictEqual(toCustomCodeContent(chromeBlock(false)));
      expect(fake.createDashlet).not.toHaveBeenCalled();
    });

    it.each(['false', 0, null])(
      'fails with invalid_block naming host_chrome for an authored %o, and writes nothing',
      async (hostChrome) => {
        const fake = makeClient({ dashboards: [salesWith()] });
        const harness = await runPush(
          makeHarness({ fake, deployable: [makePlugin(PLUGIN, [chromeBlock(hostChrome)])] }),
          { dashboard: 'D1', create: true, yes: true },
        );

        expect(harness.json()).toMatchObject({
          ok: false,
          code: 'invalid_block',
          field: 'host_chrome',
          message: 'Block "chart" has an invalid host_chrome: it must be true or false.',
        });
        expect(harness.exitCodes).toStrictEqual([1]);
        expect(fake.createDashlet).not.toHaveBeenCalled();
        expect(harness.deps.writePushMap).not.toHaveBeenCalled();
      },
    );

    it('updates the remembered dashlet when host_chrome flips from false to true, without drift', async () => {
      const sent = JSON.parse(JSON.stringify(toCustomCodeContent(chromeBlock(false)))) as Record<
        string,
        unknown
      >;
      const fake = makeClient({ dashboards: [salesWith(pushedDashlet(sent))] });
      const entry = makeEntry({ contentHash: canonicalContentHash(sent) });
      const harness = await runPush(
        makeHarness({
          fake,
          pushMap: [entry],
          deployable: [makePlugin(PLUGIN, [chromeBlock(true)])],
        }),
        { yes: true },
      );

      expect(harness.json()).toMatchObject({
        ok: true,
        applied: true,
        action: 'updated',
        dashletId: 'X1',
        resolvedBy: 'remembered',
      });
      expect(fake.updateDashlet).toHaveBeenCalledTimes(1);

      const [, , body] = fake.updateDashlet.mock.calls[0] ?? [];
      const content = (body as { config: { content: Record<string, unknown> } }).config.content;
      const nextHash = canonicalContentHash(toCustomCodeContent(chromeBlock(true)));

      expect(content.host_chrome).toBe(true);
      expect(nextHash).not.toBe(entry.contentHash);
      expect(harness.pushMap.entries).toStrictEqual([
        makeEntry({ contentHash: nextHash, pushedAt: PUSHED_AT }),
      ]);
    });

    it('updates the remembered dashlet when host_chrome is removed after a false push', async () => {
      const sent = JSON.parse(JSON.stringify(toCustomCodeContent(chromeBlock(false)))) as Record<
        string,
        unknown
      >;
      const fake = makeClient({ dashboards: [salesWith(pushedDashlet(sent))] });
      const harness = await runPush(
        makeHarness({
          fake,
          pushMap: [makeEntry({ contentHash: canonicalContentHash(sent) })],
        }),
        { yes: true },
      );

      expect(harness.json()).toMatchObject({ ok: true, applied: true, action: 'updated' });

      const [, , body] = fake.updateDashlet.mock.calls[0] ?? [];

      expect(Object.keys((body as { config: { content: object } }).config.content)).not.toContain(
        'host_chrome',
      );
      expect(harness.pushMap.entries).toStrictEqual([
        makeEntry({ contentHash: BLOCK_HASH, pushedAt: PUSHED_AT }),
      ]);
    });
  });

  it('outputs a block choice failure', async () => {
    const harness = makeHarness({
      deployable: [
        makePlugin(PLUGIN, [makeBlock(), makeBlock({ api_name: 'table', name: 'Table' })]),
      ],
    });

    await runPushHeadless(undefined, { json: true }, harness.deps);

    expect(harness.json()).toMatchObject({ ok: false, code: 'needs_choice', choice: 'block' });
    expect(harness.exitCodes).toStrictEqual([1]);
  });

  it('writes only JSON to stdout in --json mode, with status lines on stderr', async () => {
    const fake = makeClient({ dashboards: [salesWith()] });
    const harness = await runPush(makeHarness({ fake }), {
      dashboard: 'D1',
      create: true,
      yes: true,
    });

    expect(harness.stdout).toHaveLength(1);
    expect(() => {
      JSON.parse(harness.stdout[0] ?? '');
    }).not.toThrow();
    expect(harness.stderr.join('')).toContain('Action: Create a new block on "Sales"');
  });

  describe('without --json', () => {
    it('prints a readable dry-run summary and the body to stdout', async () => {
      const fake = makeClient({ dashboards: [salesWith()] });
      const harness = makeHarness({ fake });

      await runPushHeadless(BLOCK, { dashboard: 'D1', create: true }, harness.deps);

      const out = harness.stdout.join('');

      expect(out).toContain('Environment: staging');
      expect(out).toContain('Action: Create a new block on "Sales"');
      expect(out).toContain('POST /dashboards/D1/dashlet');
      expect(out).toContain('"name": "appbuilder:acme/chart"');
      expect(harness.stderr.join('')).toContain('Dry run only: pass --yes to write.');
    });

    it('prints an applied summary with the URL', async () => {
      const fake = makeClient({ dashboards: [salesWith()] });
      const harness = makeHarness({ fake });

      await runPushHeadless(BLOCK, { dashboard: 'D1', create: true, yes: true }, harness.deps);

      expect(harness.stdout.join('')).toContain('✓ Created Chart on "Sales" (dashlet NEW)');
      expect(harness.stdout.join('')).toContain('URL: https://v2.staging.kizen.com/dashboard/D1');
    });

    it('prints the refresh line after the URL for an applied push on a uuid dashboard', async () => {
      const fake = makeClient({ dashboards: [makeDashboard({ id: DASHBOARD_UUID })] });
      const harness = makeHarness({ fake });

      await runPushHeadless(
        BLOCK,
        { dashboard: DASHBOARD_UUID, create: true, yes: true },
        harness.deps,
      );

      expect(harness.stdout.join('')).toContain(
        [
          `URL: https://v2.staging.kizen.com/dashboard/${DASHBOARD_UUID}`,
          `Refresh an open tab: await window.__kizenCustomBlocks?.refresh('${DASHBOARD_UUID}')`,
        ].join('\n'),
      );
    });

    it('prints failures to stderr with the hint and runnable choices', async () => {
      const fake = makeClient({
        summaries: {
          generic_dashboard: [summary()],
          homepage: [summary({ id: 'H1', name: 'Home' })],
        },
      });
      const harness = makeHarness({ fake });

      await runPushHeadless(BLOCK, { profile: 'credentials' }, harness.deps);

      const err = harness.stderr.join('');

      expect(harness.stdout).toStrictEqual([]);
      expect(err).toContain('Error: Choose where to push');
      expect(err).toContain('Choices:');
      expect(err).toContain(
        'Sales  →  appbuilder block push chart --profile credentials --dashboard D1',
      );
      expect(err).toContain(
        'Home  →  appbuilder block push chart --profile credentials --dashboard H1',
      );
      expect(harness.exitCodes).toStrictEqual([1]);
    });

    it('prints the hint line', async () => {
      const fake = makeClient();

      fake.getDashboard.mockRejectedValueOnce(
        new KizenApiError('auth_failed', 'failed with 401', { hint: 'Check apiKey' }),
      );

      const harness = makeHarness({ fake });

      await runPushHeadless(BLOCK, { dashboard: 'D1' }, harness.deps);

      expect(harness.stderr.join('')).toBe('Error: failed with 401\nHint: Check apiKey\n');
    });
  });
});

describe('listTargets', () => {
  it('lists dashboards, homepages, custom objects and Contacts with four concurrent calls', async () => {
    const resolvers: (() => void)[] = [];
    const deferred = <T>(value: T): Promise<T> =>
      new Promise((resolve) => {
        resolvers.push(() => {
          resolve(value);
        });
      });
    const fake = makeClient();

    fake.listDashboards.mockImplementation((type) =>
      deferred(
        type === 'homepage'
          ? [summary({ id: 'H1', name: 'Home', employee_access: 'View', hidden: true })]
          : [summary()],
      ),
    );
    fake.listCustomObjects.mockImplementation(() =>
      deferred([
        { id: 'O2', object_name: 'Deals', fetch_url: 'deals' },
        { id: 'O1', object_name: 'Accounts', fetch_url: 'accounts' },
      ]),
    );
    fake.getClientObjectId.mockImplementation(() => deferred('CL'));

    const pending = listTargets(fake.client, makeCredentials(), {});

    expect(fake.listDashboards).toHaveBeenCalledTimes(2);
    expect(fake.listCustomObjects).toHaveBeenCalledTimes(1);
    expect(fake.getClientObjectId).toHaveBeenCalledTimes(1);
    expect(resolvers).toHaveLength(4);

    for (const resolve of resolvers) {
      resolve();
    }

    expect(await pending).toStrictEqual({
      ok: true,
      value: {
        ok: true,
        environment: 'staging',
        businessId: 'biz',
        surfaces: {
          dashboard: [
            {
              id: 'D1',
              name: 'Sales',
              type: 'dashboard',
              dashletsCount: 3,
              employeeAccess: 'Owner',
              hidden: false,
              canEdit: true,
            },
          ],
          homepage: [
            {
              id: 'H1',
              name: 'Home',
              type: 'homepage',
              dashletsCount: 3,
              employeeAccess: 'View',
              hidden: true,
              canEdit: false,
            },
          ],
        },
        customObjects: [
          { id: 'O1', objectName: 'Accounts', fetchUrl: 'accounts' },
          { id: 'O2', objectName: 'Deals', fetchUrl: 'deals' },
          { id: 'CL', objectName: 'Contacts', fetchUrl: 'client' },
        ],
      },
    });
    expect(fake.listDashboards.mock.calls).toStrictEqual([['generic_dashboard'], ['homepage']]);
    expect(fake.getDashboard).not.toHaveBeenCalled();
    expect(fake.getCustomObject).not.toHaveBeenCalled();
  });

  it('omits Contacts without an error when the bootstrap lookup throws', async () => {
    const fake = makeClient({
      customObjects: [{ id: 'O1', object_name: 'Deals', fetch_url: 'deals' }],
    });

    fake.getClientObjectId.mockRejectedValueOnce(new KizenApiError('forbidden', 'no'));

    expect(await listTargets(fake.client, makeCredentials(), {})).toMatchObject({
      ok: true,
      value: { customObjects: [{ id: 'O1', objectName: 'Deals', fetchUrl: 'deals' }] },
    });
  });

  it('omits Contacts when the bootstrap has no client object', async () => {
    const fake = makeClient({ clientObjectId: null });
    const step = await listTargets(fake.client, makeCredentials(), {});

    expect(step).toMatchObject({ ok: true, value: { customObjects: [] } });
  });

  it("lists Contacts' chart groups with --object <client id>", async () => {
    const fake = makeClient({
      summaries: { chart_group: [summary({ id: 'G2', name: 'Leads', type: 'chart_group' })] },
      objectDetails: [{ id: 'CL', object_name: 'Contacts', fetch_url: 'client' }],
      clientObjectId: 'CL',
    });
    const step = await listTargets(fake.client, makeCredentials(), { object: 'CL' });

    expect(step).toMatchObject({
      ok: true,
      value: {
        object: { id: 'CL', objectName: 'Contacts', fetchUrl: 'client' },
        surfaces: { chart_group: [{ id: 'G2', name: 'Leads', type: 'chart_group' }] },
      },
    });
    expect(fake.listDashboards.mock.calls).toStrictEqual([['chart_group', 'CL']]);
    expect(fake.getCustomObject.mock.calls).toStrictEqual([['CL']]);
    expect(fake.listCustomObjects).not.toHaveBeenCalled();
  });

  it("lists an object's chart groups with --object", async () => {
    const fake = makeClient({
      summaries: { chart_group: [summary({ id: 'G1', name: 'Pipeline', type: 'chart_group' })] },
      customObjects: [{ id: 'O1', object_name: 'Deals', fetch_url: 'deals' }],
    });
    const step = await listTargets(fake.client, makeCredentials(), { object: 'O1' });

    expect(step).toStrictEqual({
      ok: true,
      value: {
        ok: true,
        environment: 'staging',
        businessId: 'biz',
        object: { id: 'O1', objectName: 'Deals', fetchUrl: 'deals' },
        surfaces: {
          chart_group: [
            {
              id: 'G1',
              name: 'Pipeline',
              type: 'chart_group',
              dashletsCount: 3,
              employeeAccess: 'Owner',
              hidden: false,
              canEdit: true,
            },
          ],
        },
      },
    });
    expect(fake.listDashboards.mock.calls).toStrictEqual([['chart_group', 'O1']]);
    expect(fake.listCustomObjects).not.toHaveBeenCalled();
  });

  it('returns object: null for an unknown object id', async () => {
    const step = await listTargets(makeClient().client, makeCredentials(), { object: 'client-id' });

    expect(step).toMatchObject({
      ok: true,
      value: { object: null, surfaces: { chart_group: [] } },
    });
  });

  it('maps API errors', async () => {
    const fake = makeClient();

    fake.listCustomObjects.mockRejectedValueOnce(
      new KizenApiError('auth_failed', 'failed with 401', { hint: 'h' }),
    );

    expect(await listTargets(fake.client, makeCredentials(), {})).toStrictEqual({
      ok: false,
      code: 'auth_failed',
      message: 'failed with 401',
      hint: 'h',
    });
  });
});

describe('listPushableObjects', () => {
  it('sorts custom objects by name and appends Contacts', async () => {
    const fake = makeClient({
      customObjects: [
        { id: 'O2', object_name: 'Deals', fetch_url: 'pipeline' },
        { id: 'O1', object_name: 'Accounts', fetch_url: 'standard' },
      ],
      clientObjectId: 'CL',
    });

    expect(await listPushableObjects(fake.client)).toStrictEqual([
      { id: 'O1', objectName: 'Accounts', fetchUrl: 'standard' },
      { id: 'O2', objectName: 'Deals', fetchUrl: 'pipeline' },
      { id: 'CL', objectName: 'Contacts', fetchUrl: 'client' },
    ]);
  });

  it('does not duplicate a client object already in the list', async () => {
    const fake = makeClient({
      customObjects: [{ id: 'CL', object_name: 'People', fetch_url: 'client' }],
      clientObjectId: 'CL',
    });

    expect(await listPushableObjects(fake.client)).toStrictEqual([
      { id: 'CL', objectName: 'People', fetchUrl: 'client' },
    ]);
  });

  it('still fails when the custom-objects list fails', async () => {
    const fake = makeClient({ clientObjectId: 'CL' });

    fake.listCustomObjects.mockRejectedValueOnce(new KizenApiError('auth_failed', 'failed'));

    await expect(listPushableObjects(fake.client)).rejects.toThrow('failed');
  });
});

describe('runTargetsHeadless', () => {
  it('prints the targets JSON', async () => {
    const fake = makeClient({ summaries: { generic_dashboard: [summary()] } });
    const harness = makeHarness({ fake });

    await runTargetsHeadless({ json: true }, harness.deps);

    expect(harness.json()).toMatchObject({
      ok: true,
      surfaces: { dashboard: [{ id: 'D1' }], homepage: [] },
      customObjects: [],
    });
    expect(harness.exitCodes).toStrictEqual([]);
  });

  it('outputs a profile choice failure as JSON', async () => {
    const harness = makeHarness({
      profiles: [
        DEFAULT_PROFILE,
        { name: 'staging', path: '/home/.kizenappbuilder/staging.json', isDefault: false },
      ],
    });

    await runTargetsHeadless({ json: true }, harness.deps);

    expect(harness.json()).toMatchObject({ ok: false, code: 'needs_choice', choice: 'profile' });
    expect(harness.exitCodes).toStrictEqual([1]);
    expect(harness.deps.createClient).not.toHaveBeenCalled();
  });

  it('outputs API errors as one JSON document with exit code 1', async () => {
    const fake = makeClient();

    fake.listDashboards.mockRejectedValue(new KizenApiError('network_error', 'offline'));

    const harness = makeHarness({ fake });

    await runTargetsHeadless({ json: true }, harness.deps);

    expect(harness.json()).toStrictEqual({ ok: false, code: 'network_error', message: 'offline' });
    expect(harness.exitCodes).toStrictEqual([1]);
  });

  it('prints a readable table without --json', async () => {
    const fake = makeClient({
      summaries: {
        generic_dashboard: [summary()],
        homepage: [summary({ id: 'H1', name: 'Home', employee_access: 'View' })],
      },
      customObjects: [{ id: 'O1', object_name: 'Deals', fetch_url: 'deals' }],
      clientObjectId: 'CL',
    });
    const harness = makeHarness({ fake });

    await runTargetsHeadless({}, harness.deps);

    const out = harness.stdout.join('');

    expect(out).toContain('Dashboards');
    expect(out).toMatch(/Sales\s+D1\s+3\s+Owner/);
    expect(out).toContain('View (no edit access)');
    expect(out).toContain('Deals  O1');
    expect(out).toContain('Contacts  CL');
    expect(out).toContain('--object <id>');
  });

  it('prints profile choices with the targets command', async () => {
    const harness = makeHarness({
      profiles: [
        DEFAULT_PROFILE,
        { name: 'staging', path: '/home/.kizenappbuilder/staging.json', isDefault: false },
      ],
    });

    await runTargetsHeadless({ object: 'O1' }, harness.deps);

    expect(harness.stderr.join('')).toContain(
      'staging  →  appbuilder block targets --profile staging --object O1',
    );
  });
});
