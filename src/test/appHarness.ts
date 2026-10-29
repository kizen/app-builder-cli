import type { DeployablePlugin } from '@kizenapps/packager';
import { strToU8, zipSync } from 'fflate';
import { expect, vi, type Mock } from 'vitest';
import type { MergeOutcome, ReadyMergePlan } from '../lib/appMerge.js';
import type { AppDeps } from '../lib/appFlow.js';
import {
  emptyAppStateDoc,
  findAppStateEntry,
  type AppStateDoc,
  type AppStateEntry,
  type AppStateKey,
} from '../lib/appState.js';
import type {
  ActionAssociation,
  BusinessAppDefinition,
  BusinessAppPublishBody,
  BusinessAppRow,
  BusinessAppsApi,
  BusinessAppVersionRow,
  BusinessObject,
} from '../lib/businessApps.js';
import type { Credentials, DetailedCredentials } from '../lib/credentials.js';
import { KizenApiError } from '../lib/kizenClient.js';
import type { KizenClient } from '../lib/kizenTypes.js';
import { SOURCE_LINEAGE_PATH, withSourceLineage, type SourceLineage } from '../lib/sourceZip.js';

export const CWD = '/work/acme';
export const USER = 'user-1';
export const OTHER = 'user-2';
export const BIZ = 'biz';
export const BASE = 'acme';
export const APP_API = 'acme_abc123';
export const NOW = '2026-10-27T12:00:00.000Z';
export const API_KEY = { profile: 'credentials' };
export const CRED_ARGS = ['--profile', 'credentials'];
export const JSON_ARGS = [...CRED_ARGS, '--json'];
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

export const KEY: AppStateKey = {
  environment: 'staging',
  businessId: BIZ,
  baseApiName: BASE,
  userId: USER,
};

export const stateEntry = (overrides: Partial<AppStateEntry> = {}): AppStateEntry => {
  const base = 'folderBaseLiveVersion' in overrides ? overrides.folderBaseLiveVersion : '3';

  return {
    ...KEY,
    folderBaseLiveVersion: base,
    ...(typeof base === 'string' ? { folderBaseSourcePackageId: `src-v${base}` } : {}),
    previewSourcePackageId: 'src-preview',
    lastPushedSourceHash: null,
    ...overrides,
  };
};

export const folderOnlyEntry = (): AppStateEntry => {
  const entry = stateEntry();

  delete entry.previewSourcePackageId;

  return entry;
};

export type Files = Record<string, string>;

export const zipOf = (files: Files): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));

export const versionFiles = (version: string): Files => ({
  'kizen.json': `{"api_name":"${BASE}","release":"${version}"}`,
  'src/a.js': `a${version}`,
});

export const SOURCE_SERVICES = [
  { name: 'crm', auth_credentials: { client_secret: 'from-source' } },
];

export const STRIPPED_SERVICES = [{ name: 'crm' }];

export const definition = (
  version: string | undefined,
  sourceId: string | null,
  thumbnail: string | null = 'thumb-file',
): BusinessAppDefinition => ({
  name: 'Acme',
  api_name: BASE,
  engine: 'v1',
  services: STRIPPED_SERVICES,
  base_config: {},
  artifacts: {
    data_adornments: [],
    floating_frames: [],
    custom_blocks: [],
    routable_pages: [],
    toolbar_items: [],
    object_settings_menu_items: [],
    calendar_sources: [],
    js_action_templates: [],
    route_script_templates: [],
    automation_action_configs: [],
  },
  thumbnail,
  source_filesystem_package: sourceId,
  ...(version === undefined ? {} : { version }),
});

export interface JsActionWire {
  api_name: string;
  name: string;
  hint_object_name: string;
  script: string;
}

export const jsAction = (apiName: string, hint = 'client_client'): JsActionWire => ({
  api_name: apiName,
  name: `Action ${apiName}`,
  hint_object_name: hint,
  script: 'return 1;',
});

export const withJsActions = (
  def: BusinessAppDefinition,
  apiNames: readonly string[],
): BusinessAppDefinition => ({
  ...def,
  artifacts: { ...def.artifacts, js_action_templates: apiNames.map((name) => jsAction(name)) },
});

export const CONTACTS: BusinessObject = {
  id: 'obj-contacts',
  name: 'client_client',
  objectName: 'Contacts',
  entityName: 'Contact',
};

export const DEALS: BusinessObject = {
  id: 'obj-deals',
  name: 'deal_pipeline',
  objectName: 'Deals',
  entityName: 'Deal',
};

export const OLD_DEALS: BusinessObject = {
  id: 'obj-old-deals',
  name: 'old_deals',
  objectName: 'Deals',
  entityName: 'Deal',
};

export interface StoredAssociation {
  id: string;
  template: string;
  objectId: string;
  includePerformAction: boolean | null;
}

export interface Release {
  version: string;
  publishedAt: string;
  publishedBy: string;
}

export type LineageFixture = SourceLineage | { raw: string } | null;

export interface Preview {
  def: BusinessAppDefinition;
  updated: string | null;
  ownerName: string;
  installed?: number;
  files?: Files;
  lineage?: LineageFixture;
}

export const DEFAULT_PREVIEW_LINEAGE: SourceLineage = {
  baseLiveVersion: '3',
  baseSourcePackageId: 'src-v3',
};

export const PREVIEW_FILES: Files = { 'kizen.json': '{"api_name":"acme","preview":true}' };

export function sourceZipOf(files: Files, lineage: LineageFixture = null): Uint8Array {
  if (lineage === null) {
    return zipOf(files);
  }

  if ('raw' in lineage) {
    return zipOf({ ...files, [SOURCE_LINEAGE_PATH]: lineage.raw });
  }

  return withSourceLineage(zipOf(files), lineage);
}

export const lineageOf = (version: string | null, sourceId?: string): SourceLineage =>
  version === null
    ? { baseLiveVersion: null, baseSourcePackageId: null }
    : { baseLiveVersion: version, baseSourcePackageId: sourceId ?? `src-v${version}` };

export interface ServerOptions {
  exists?: boolean;
  live?: string | null;
  releases?: Release[];
  deleted?: string[];
  previews?: Record<string, Preview>;
  jsActions?: Record<string, string[]>;
  objects?: BusinessObject[];
  associations?: StoredAssociation[];
  active?: Record<string, string | null>;
}

export interface ServerState {
  exists: boolean;
  live: string | null;
  releases: Release[];
  previews: Map<string, Preview>;
  definitions: Map<string, BusinessAppDefinition>;
  files: Map<string, Uint8Array>;
  maxEver: number;
  caller: string;
  objects: BusinessObject[];
  associations: StoredAssociation[];
  active: Map<string, string | null>;
}

export type FakeApi = { [K in keyof BusinessAppsApi]: Mock<BusinessAppsApi[K]> };

export interface FakeServer {
  state: ServerState;
  api: FakeApi;
  calls: string[];
  writes: () => string[];
  release: (publishedBy?: string) => string;
  recreate: (live: string) => void;
  pushPreviewFrom: (owner: string, files: Files, lineage: LineageFixture) => string;
}

const badRequest = (method: string, path: string, body: unknown, detail: string): KizenApiError =>
  new KizenApiError('api_error', `${method} ${path} failed with 400: ${detail}`, {
    status: 400,
    details: body,
  });

const templateNamesOf = (def: BusinessAppDefinition | undefined): string[] =>
  (def?.artifacts.js_action_templates ?? []).flatMap((item) =>
    typeof item === 'object' && item !== null && 'api_name' in item
      ? [String((item as { api_name: unknown }).api_name)]
      : [],
  );

const FLAT_ASSOCIATION = '/external-integrations/browser-js-action-template-association';

export const notFound = (path: string): KizenApiError =>
  new KizenApiError('not_found', `GET ${path} failed with 404`, { status: 404 });

export const releasesUpTo = (live: string): Release[] =>
  Array.from({ length: Number(live) }, (_, index) => ({
    version: String(index + 1),
    publishedAt: `2026-09-${String(index + 10)}T00:00:00.000Z`,
    publishedBy: index + 1 === Number(live) ? 'Grace H' : 'Ada L',
  }));

export function makeServer(options: ServerOptions = {}): FakeServer {
  const live = options.live === undefined ? '3' : options.live;
  const releases = options.releases ?? (live === null ? [] : releasesUpTo(live));
  const state: ServerState = {
    exists: options.exists ?? true,
    live,
    releases,
    previews: new Map(Object.entries(options.previews ?? {})),
    definitions: new Map<string, BusinessAppDefinition>(),
    files: new Map<string, Uint8Array>(),
    maxEver: Math.max(
      0,
      ...[...releases.map((r) => r.version), ...(options.deleted ?? [])].map(Number),
    ),
    caller: USER,
    objects: options.objects ?? [CONTACTS, DEALS],
    associations: structuredClone(options.associations ?? []),
    active: new Map(
      Object.entries(
        options.active ??
          Object.fromEntries(Object.keys(options.previews ?? {}).map((owner) => [owner, owner])),
      ),
    ),
  };
  let generation = 1;
  const releaseSourceId = (version: string): string =>
    generation === 1 ? `src-v${version}` : `src-r${String(generation)}-v${version}`;
  const addRelease = (version: string): void => {
    const sourceId = releaseSourceId(version);

    state.definitions.set(
      version,
      withJsActions(definition(version, sourceId), options.jsActions?.[version] ?? []),
    );
    state.files.set(sourceId, zipOf(versionFiles(version)));
  };

  for (const release of state.releases) {
    addRelease(release.version);
  }

  const storePreviewSource = (preview: Preview): void => {
    const sourceId = preview.def.source_filesystem_package;

    if (typeof sourceId === 'string' && !state.files.has(sourceId)) {
      state.files.set(
        sourceId,
        sourceZipOf(
          preview.files ?? PREVIEW_FILES,
          preview.lineage === undefined ? DEFAULT_PREVIEW_LINEAGE : preview.lineage,
        ),
      );
    }
  };

  for (const preview of state.previews.values()) {
    storePreviewSource(preview);
  }

  let fileId = 0;
  let associationId = 0;
  const calls: string[] = [];
  // Like the server: a list shows only links whose template is in the install's Live version.
  const liveTemplateNames = (): Set<string> =>
    new Set(state.live === null ? [] : templateNamesOf(state.definitions.get(state.live)));
  // Like the server: a create resolves templates against the caller's active preview, else Live.
  const servedTemplateNames = (): Set<string> => {
    const owner = state.active.get(state.caller) ?? null;
    const preview = owner === null ? undefined : state.previews.get(owner);

    return preview ? new Set(templateNamesOf(preview.def)) : liveTemplateNames();
  };

  const associationPath = (appApiName: string, id?: string): string =>
    `/external-integrations/business-plugin-apps/${appApiName}/browser-js-action-template-associations${id === undefined ? '' : `/${id}`}`;

  const usersOf = (owner: string): number =>
    [...state.active.values()].filter((using) => using === owner).length;

  const versionRows = (): BusinessAppVersionRow[] => [
    ...state.releases.map(
      (release): BusinessAppVersionRow => ({
        version: release.version,
        status: release.version === state.live ? 'live' : 'released',
        preview_owner: null,
        active_users_count: null,
        installed_count: null,
        is_current_for_viewer: false,
        updated: release.publishedAt,
        published_at: release.publishedAt,
        published_by: { id: 'x', full_name: release.publishedBy },
        built_by: null,
        definition_url: null,
      }),
    ),
    ...[...state.previews].map(([owner, preview]): BusinessAppVersionRow => {
      const using = usersOf(owner);

      return {
        version: '0',
        status: 'preview',
        preview_owner: { id: owner, full_name: preview.ownerName },
        active_users_count: using,
        installed_count: preview.installed ?? using,
        is_current_for_viewer: state.active.get(state.caller) === owner,
        updated: preview.updated,
        published_at: null,
        published_by: null,
        built_by: null,
        definition_url: null,
      };
    }),
  ];

  const row = (): BusinessAppRow => ({
    api_name: APP_API,
    base_api_name: BASE,
    name: 'Acme',
    status: 'live',
    live_version: state.live,
    has_releases: state.releases.length > 0,
    updated: null,
    current_version: state.live,
    published_by: null,
    versions: versionRows(),
  });

  const api: FakeApi = {
    listApps: vi.fn<BusinessAppsApi['listApps']>(() => {
      calls.push('listApps');

      return Promise.resolve(state.exists ? [row()] : []);
    }),
    getApp: vi.fn<BusinessAppsApi['getApp']>(() => Promise.reject(new Error('unused'))),
    getVersion: vi.fn<BusinessAppsApi['getVersion']>((apiName, version) => {
      calls.push(`getVersion:${String(version)}`);

      const found = state.definitions.get(String(version));

      return found
        ? Promise.resolve(structuredClone(found))
        : Promise.reject(notFound(`/${apiName}/versions/${String(version)}`));
    }),
    getPreview: vi.fn<BusinessAppsApi['getPreview']>((apiName, owner) => {
      calls.push(`getPreview:${owner}`);

      const found = state.previews.get(owner);

      return found
        ? Promise.resolve(structuredClone(found.def))
        : Promise.reject(notFound(`/${apiName}/previews/${owner}`));
    }),
    publish: vi.fn<BusinessAppsApi['publish']>((body) => {
      calls.push(`publish:${String(body.release)}`);

      if (body.release) {
        return Promise.reject(new Error('this flow must never publish a release'));
      }

      // Like the server: release false writes the caller's own preview and makes it active.
      state.exists = true;
      state.previews.set(state.caller, {
        def: structuredClone(body) as unknown as BusinessAppDefinition,
        updated: NOW,
        ownerName: state.caller === USER ? 'Ada L' : 'Someone',
      });
      state.active.set(state.caller, state.caller);

      return Promise.resolve({ api_name: APP_API, base_api_name: BASE, version: '0' });
    }),
    promotePreview: vi.fn<BusinessAppsApi['promotePreview']>((apiName, owner) => {
      calls.push(`promote:${owner}`);

      const preview = state.previews.get(owner);

      if (!preview) {
        return Promise.reject(notFound(`/${apiName}/previews/${owner}/promote`));
      }

      // Like the server: one past every number ever used, deleted releases included.
      state.maxEver += 1;

      const version = String(state.maxEver);

      state.definitions.set(version, { ...preview.def, version });
      state.releases.push({ version, publishedAt: NOW, publishedBy: preview.ownerName });
      state.live = version;
      state.previews.delete(owner);

      // Like the server: whoever used the promoted preview uses Live now.
      for (const [user, using] of state.active) {
        if (using === owner) {
          state.active.set(user, null);
        }
      }

      return Promise.resolve({ api_name: APP_API, version });
    }),
    deletePreview: vi.fn<BusinessAppsApi['deletePreview']>((apiName, owner) => {
      calls.push(`deletePreview:${owner}`);

      if (!state.exists || apiName !== APP_API || !state.previews.has(owner)) {
        return Promise.reject(notFound(`/${apiName}/previews/${owner}`));
      }

      state.previews.delete(owner);

      // Like the server: users fall back to their own preview, else Live; no version left, no app.
      for (const [user, using] of state.active) {
        if (using === owner) {
          state.active.set(user, state.previews.has(user) ? user : null);
        }
      }

      if (state.releases.length === 0 && state.previews.size === 0) {
        state.exists = false;
        state.associations = [];
        state.active.clear();
      }

      return Promise.resolve();
    }),
    uploadFile: vi.fn<BusinessAppsApi['uploadFile']>((bytes, opts) => {
      calls.push(`upload:${opts.source}`);
      fileId += 1;

      const id = `file-${String(fileId)}`;

      state.files.set(id, bytes);

      return Promise.resolve(id);
    }),
    downloadFile: vi.fn<BusinessAppsApi['downloadFile']>((id) => {
      calls.push(`download:${id}`);

      const found = state.files.get(id);

      return found ? Promise.resolve(found) : Promise.reject(notFound(`/files/${id}/download`));
    }),
    listActionAssociations: vi.fn<BusinessAppsApi['listActionAssociations']>((appApiName) => {
      calls.push('listAssociations');

      if (!state.exists || appApiName !== APP_API) {
        return Promise.reject(notFound(associationPath(appApiName)));
      }

      const live = liveTemplateNames();
      const rows = state.associations
        .filter((row) => live.has(row.template))
        .map((row): ActionAssociation => {
          const object = state.objects.find((candidate) => candidate.id === row.objectId);

          return {
            id: row.id,
            include_perform_action: row.includePerformAction,
            browser_js_action_template: {
              id: `tpl-${row.template}`,
              api_name: row.template,
              name: `Action ${row.template}`,
              hint_object_name: 'client_client',
            },
            custom_object: {
              id: row.objectId,
              name: object?.name ?? 'gone',
              object_name: object?.objectName ?? 'Gone',
              entity_name: object?.entityName ?? 'Gone',
            },
          };
        });

      return Promise.resolve(rows);
    }),
    createActionAssociation: vi.fn<BusinessAppsApi['createActionAssociation']>((input) => {
      calls.push(`createAssociation:${input.actionApiName}:${input.objectId}`);

      const body = {
        browser_js_action_template: {
          api_name: input.actionApiName,
          plugin_app_api_name: input.appApiName,
        },
        custom_object: { id: input.objectId },
        include_perform_action: input.includePerformAction,
      };
      const reject = (detail: string): Promise<never> =>
        Promise.reject(badRequest('POST', FLAT_ASSOCIATION, body, detail));

      if (!state.exists || input.appApiName !== APP_API) {
        return reject('Plugin App not installed in Business');
      }

      if (!servedTemplateNames().has(input.actionApiName)) {
        return reject('api_name: Browser JS action template not found');
      }

      if (!state.objects.some((object) => object.id === input.objectId)) {
        return reject('custom_object: Custom object not found');
      }

      if (
        state.associations.some(
          (row) => row.template === input.actionApiName && row.objectId === input.objectId,
        )
      ) {
        return reject(
          'Browser JS Template Association for this custom object/js action template already exists.',
        );
      }

      associationId += 1;
      state.associations.push({
        id: `assoc-new-${String(associationId)}`,
        template: input.actionApiName,
        objectId: input.objectId,
        includePerformAction: input.includePerformAction,
      });

      return Promise.resolve();
    }),
    updateActionAssociation: vi.fn<BusinessAppsApi['updateActionAssociation']>(
      (appApiName, id, includePerformAction) => {
        calls.push(`updateAssociation:${id}:${String(includePerformAction)}`);

        const row = state.associations.find((candidate) => candidate.id === id);

        if (!state.exists || appApiName !== APP_API || row === undefined) {
          return Promise.reject(notFound(associationPath(appApiName, id)));
        }

        row.includePerformAction = includePerformAction;

        return Promise.resolve();
      },
    ),
    deleteActionAssociation: vi.fn<BusinessAppsApi['deleteActionAssociation']>((id) => {
      calls.push(`deleteAssociation:${id}`);

      const index = state.associations.findIndex((candidate) => candidate.id === id);

      if (index === -1) {
        return Promise.reject(notFound(`${FLAT_ASSOCIATION}/${id}`));
      }

      state.associations.splice(index, 1);

      return Promise.resolve();
    }),
    listObjects: vi.fn<BusinessAppsApi['listObjects']>(() => {
      calls.push('listObjects');

      return Promise.resolve(structuredClone(state.objects));
    }),
  };

  return {
    state,
    api,
    calls,
    writes: () =>
      calls.filter((call) =>
        /^(publish|promote|upload|delete|createAssociation|updateAssociation)/.test(call),
      ),
    release: (publishedBy = 'Grace H') => {
      state.maxEver += 1;

      const version = String(state.maxEver);

      state.releases.push({ version, publishedAt: NOW, publishedBy });
      addRelease(version);
      state.live = version;

      return version;
    },
    recreate: (live) => {
      generation += 1;
      state.exists = true;
      state.previews.clear();
      state.definitions.clear();
      state.associations = [];
      state.active.clear();
      state.releases = releasesUpTo(live).map((release) => ({ ...release, publishedAt: NOW }));
      state.maxEver = Number(live);
      state.live = live;

      for (const release of state.releases) {
        addRelease(release.version);
      }
    },
    pushPreviewFrom: (owner, files, lineage) => {
      fileId += 1;

      const sourceId = `file-${String(fileId)}`;

      state.exists = true;
      state.files.set(sourceId, sourceZipOf(files, lineage));
      state.previews.set(owner, {
        def: definition(undefined, sourceId),
        updated: NOW,
        ownerName: owner === USER ? 'Ada L' : 'Someone',
      });
      state.active.set(owner, owner);

      return sourceId;
    },
  };
}

export const deployable = (
  thumbnail: Uint8Array | null = PNG,
  services: unknown[] = SOURCE_SERVICES,
): DeployablePlugin =>
  ({
    name: 'Acme',
    api_name: BASE,
    engine: 'v1',
    services,
    base_config: {},
    artifacts: { custom_blocks: [] },
    thumbnail,
    kznFile: null,
  }) as unknown as DeployablePlugin;

export interface HarnessOptions {
  server?: FakeServer;
  credentials?: Partial<Credentials>;
  environmentSource?: DetailedCredentials['environmentSource'];
  state?: AppStateEntry[];
  stateNotice?: string;
  files?: Files;
  packageError?: unknown;
  zipError?: unknown;
  thumbnail?: Uint8Array | null;
  deployable?: DeployablePlugin;
  deps?: Partial<AppDeps>;
}

export interface Harness {
  deps: AppDeps;
  server: FakeServer;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  store: { doc: AppStateDoc; writes: number };
  otherDirs: Map<string, AppStateDoc>;
  local: { files: Files };
  mocks: {
    businessApps: Mock<AppDeps['businessApps']>;
    packageLocalPlugin: Mock<AppDeps['packageLocalPlugin']>;
    planMerge: Mock<AppDeps['planMerge']>;
    applyMerge: Mock<AppDeps['applyMerge']>;
    unzip: Mock<AppDeps['unzipToDir']>;
    writeAppState: Mock<AppDeps['writeAppState']>;
    removeDir: Mock<AppDeps['removeDir']>;
  };
  entry: (key?: AppStateKey) => AppStateEntry | undefined;
  json: () => Record<string, unknown>;
  text: () => string;
  reset: () => void;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const server = options.server ?? makeServer();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const store: Harness['store'] = {
    doc: { ...emptyAppStateDoc(), entries: [...(options.state ?? [])] },
    writes: 0,
  };
  const otherDirs = new Map<string, AppStateDoc>();
  const local = { files: options.files ?? { 'kizen.json': '{"api_name":"acme","local":true}' } };
  const credentials: Credentials = {
    apiKey: 'key',
    userId: USER,
    businessId: BIZ,
    environment: 'staging',
    ...options.credentials,
  };
  const businessApps = vi.fn<AppDeps['businessApps']>((client) => {
    server.state.caller = (client as unknown as { fakeUser: string }).fakeUser;

    return server.api;
  });
  const packageLocalPlugin = vi.fn<AppDeps['packageLocalPlugin']>((dir) => {
    if (options.packageError !== undefined && dir === CWD) {
      return Promise.reject(options.packageError as Error);
    }

    return Promise.resolve({
      files: [],
      deployable: [
        options.deployable ?? deployable(options.thumbnail === undefined ? PNG : options.thumbnail),
      ],
      issues: [],
    });
  });
  const ownDir = options.deps?.cwd ?? CWD;
  const writeAppState = vi.fn<AppDeps['writeAppState']>((dir, doc) => {
    if (dir === ownDir) {
      store.doc = structuredClone(doc);
      store.writes += 1;
    } else {
      otherDirs.set(dir, structuredClone(doc));
    }

    return Promise.resolve();
  });
  const mocks: Harness['mocks'] = {
    businessApps,
    packageLocalPlugin,
    planMerge: vi.fn<AppDeps['planMerge']>(() =>
      Promise.reject(new Error('planMerge not set up in this test')),
    ),
    applyMerge: vi.fn<AppDeps['applyMerge']>(() =>
      Promise.reject(new Error('applyMerge not set up in this test')),
    ),
    unzip: vi.fn<AppDeps['unzipToDir']>(() =>
      Promise.resolve({ written: ['kizen.json'], skipped: [] }),
    ),
    writeAppState,
    removeDir: vi.fn<AppDeps['removeDir']>(() => Promise.resolve()),
  };
  const deps: AppDeps = {
    cwd: CWD,
    loadCredentialsDetailed: vi.fn(() =>
      Promise.resolve({ credentials, environmentSource: options.environmentSource ?? 'explicit' }),
    ),
    listLoadableCredentialProfiles: vi.fn(() =>
      Promise.resolve([{ name: 'credentials', path: '/home/creds.json', isDefault: true }]),
    ),
    loadConfig: vi.fn(() => Promise.resolve({})),
    createClient: vi.fn(
      (creds: Credentials) => ({ fakeUser: creds.userId }) as unknown as KizenClient,
    ),
    now: () => new Date(NOW),
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
    processEnv: {},
    oauth: {
      listSessions: vi.fn(() => Promise.resolve([])),
      listAccounts: vi.fn(() => Promise.resolve([])),
      connect: vi.fn(() => Promise.reject(new Error('no session'))),
    },
    packageLocalPlugin,
    zipSourceDir: vi.fn(() =>
      options.zipError === undefined
        ? Promise.resolve({
            bytes: zipOf(local.files),
            files: Object.keys(local.files).sort(),
            mode: 'git' as const,
          })
        : Promise.reject(options.zipError as Error),
    ),
    readManifestApiName: vi.fn(() => Promise.resolve(BASE)),
    businessApps,
    readAppState: vi.fn(() =>
      Promise.resolve({
        doc: structuredClone(store.doc),
        ...(options.stateNotice === undefined ? {} : { notice: options.stateNotice }),
      }),
    ),
    writeAppState,
    ensureGitignore: vi.fn(() => false),
    planMerge: mocks.planMerge,
    applyMerge: mocks.applyMerge,
    unzipToDir: mocks.unzip,
    pathExists: vi.fn(() => Promise.resolve(false)),
    readTextFile: vi.fn((path: string) => {
      const text = local.files[path.slice(CWD.length + 1)];

      return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
    }),
    makeTempDir: vi.fn(() => Promise.resolve('/tmp/appbuilder-version-x')),
    removeDir: mocks.removeDir,
    staleAgentFileWarnings: vi.fn(() => Promise.resolve([])),
    ...options.deps,
  };

  return {
    deps,
    server,
    stdout,
    stderr,
    exitCodes,
    store,
    otherDirs,
    local,
    mocks,
    entry: (key = KEY) => {
      const found = findAppStateEntry(store.doc, key);

      return found.status === 'found' ? found.entry : undefined;
    },
    json: () => {
      expect(stdout).toHaveLength(1);

      return JSON.parse(stdout[0] ?? '') as Record<string, unknown>;
    },
    text: () => [...stdout, ...stderr].join(''),
    reset: () => {
      stdout.length = 0;
      stderr.length = 0;
      exitCodes.length = 0;
    },
  };
}

export const sha = async (files: Files): Promise<string> => {
  const { createHash } = await import('node:crypto');

  return createHash('sha256').update(zipOf(files)).digest('hex');
};

export function publishedBody(server: FakeServer): BusinessAppPublishBody {
  const body = server.api.publish.mock.calls[0]?.[0];

  if (body === undefined) {
    throw new Error('publish was not called');
  }

  return body;
}

export const yourPreview = (overrides: Partial<Preview> = {}): Preview => ({
  def: definition(undefined, 'src-preview'),
  updated: '2026-10-20T00:00:00.000Z',
  ownerName: 'Ada L',
  ...overrides,
});

export const readyPlan = (overrides: Partial<ReadyMergePlan> = {}): ReadyMergePlan => ({
  status: 'ready',
  pluginDir: CWD,
  baseVersion: '3',
  liveVersion: '5',
  written: ['src/a.js'],
  deleted: [],
  conflicted: ['src/a.js'],
  deletedOnLive: [],
  deletedLocally: [],
  binaryConflicts: [],
  ignoredIncoming: [],
  contents: new Map([['src/a.js', strToU8('merged')]]),
  localHashes: new Map(),
  ...overrides,
});

export const mergedOutcome: Extract<MergeOutcome, { status: 'merged' }> = {
  status: 'merged',
  written: [],
  deleted: [],
  ignoredIncoming: [],
};

export const conflictsOutcome: Extract<MergeOutcome, { status: 'conflicts' }> = {
  status: 'conflicts',
  written: ['src/a.js', 'src/gone.js'],
  deleted: [],
  conflicted: ['src/a.js', 'src/gone.js'],
  deletedOnLive: ['src/gone.js'],
  deletedLocally: [],
  binaryConflicts: [],
  ignoredIncoming: [],
};
