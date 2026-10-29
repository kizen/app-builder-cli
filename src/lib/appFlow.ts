import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { DeployablePlugin, ValidationIssue } from '@kizenapps/packager';
import { isProductionEnvironment } from '../../shared/lib/kizenUrls.js';
import {
  applyMerge,
  planMerge,
  type MergeInput,
  type MergeOutcome,
  type MergePlan,
  type ReadyMergePlan,
} from './appMerge.js';
import {
  emptyAppStateDoc,
  findAppStateEntry,
  readAppState,
  updateAppStateEntries,
  upsertAppStateEntry,
  writeAppState,
  AppStateChangedError,
  type AppStateDoc,
  type AppStateEntry,
  type AppStateKey,
  type AppStateLookup,
  type AppStateRead,
} from './appState.js';
import { staleAgentFileWarnings } from './agentSetup.js';
import { toPublishBody } from './businessAppPayload.js';
import {
  BusinessAppError,
  createBusinessAppsApi,
  type BusinessAppDefinition,
  type BusinessAppPublishBody,
  type BusinessAppRow,
  type BusinessAppsApi,
  type BusinessAppVersionRow,
} from './businessApps.js';
import {
  apiFailure,
  createDefaultCommandDeps,
  errorMessage,
  failure as coreFailure,
  success,
  type CommandAccount,
  type CommandChoice,
  type CommandDeps,
  type CommandFailure,
  type CommandStep,
} from './commandCore.js';
import type { Environment } from './credentials.js';
import { ensureGitignore } from './gitignore.js';
import { isMissingFileError, isRecord } from './guards.js';
import { KizenApiError } from './kizenClient.js';
import type { KizenClient } from './kizenTypes.js';
import { packageLocalPlugin, type PackagedLocalPlugin } from './runBuild.js';
import {
  readSourceLineage,
  readZipEntries,
  SourceZipIgnoredDirError,
  SourceZipIgnoreUnreadableError,
  SourceZipTooLargeError,
  SourceZipMissingManifestError,
  unzipToDir,
  withSourceLineage,
  ZipDestinationExistsError,
  zipSourceDir,
  type SourceLineage,
  type SourceZip,
  type SourceZipMode,
  type UnzipResult,
} from './sourceZip.js';

export type AppChoiceKind = 'environment' | 'base' | 'object';

export type AppFailure = CommandFailure<AppChoiceKind> & { conflict?: ConflictCheck };

export type AppStep<T> = CommandStep<T, AppFailure>;

const failure = coreFailure<AppChoiceKind>;

export interface AppDeps extends CommandDeps {
  packageLocalPlugin: (dir: string) => Promise<PackagedLocalPlugin>;
  zipSourceDir: (dir: string) => Promise<SourceZip>;
  readManifestApiName: (dir: string) => Promise<string>;
  businessApps: (client: KizenClient, businessId: string) => BusinessAppsApi;
  readAppState: (dir: string) => Promise<AppStateRead>;
  writeAppState: (dir: string, doc: AppStateDoc) => Promise<void>;
  ensureGitignore: (dir: string) => boolean;
  planMerge: (input: MergeInput) => Promise<MergePlan>;
  applyMerge: (plan: MergePlan, control?: ApplyControl) => Promise<MergeOutcome>;
  unzipToDir: (bytes: Uint8Array, destDir: string) => Promise<UnzipResult>;
  pathExists: (path: string) => Promise<boolean>;
  readTextFile: (path: string) => Promise<string>;
  makeTempDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  staleAgentFileWarnings: (dir: string) => Promise<string[]>;
}

const MANIFEST = 'kizen.json';

export async function readManifestApiName(dir: string): Promise<string> {
  let raw: string;

  try {
    raw = await readFile(join(dir, MANIFEST), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`No ${MANIFEST} in ${dir}. Run this command from the plugin folder.`);
    }

    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${MANIFEST} isn't valid JSON (${errorMessage(error)}). If it has merge conflict markers, resolve them first.`,
    );
  }

  const manifest: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  const apiName = isRecord(manifest) ? manifest.api_name : undefined;

  if (typeof apiName !== 'string' || apiName === '') {
    throw new Error(`${MANIFEST} has no api_name.`);
  }

  return apiName;
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

export function createDefaultAppDeps(cwd: string): AppDeps {
  return {
    ...createDefaultCommandDeps(cwd),
    packageLocalPlugin: (dir) => packageLocalPlugin(dir),
    zipSourceDir: (dir) => zipSourceDir(dir),
    readManifestApiName,
    businessApps: (client, businessId) => createBusinessAppsApi(client, businessId),
    readAppState,
    writeAppState,
    ensureGitignore,
    planMerge: (input) => planMerge(input),
    applyMerge: (plan, control) => applyMerge(plan, control),
    unzipToDir,
    pathExists,
    readTextFile: (path) => readFile(path, 'utf8'),
    makeTempDir: () => mkdtemp(join(tmpdir(), 'appbuilder-version-')),
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    staleAgentFileWarnings: (dir) => staleAgentFileWarnings(dir),
  };
}

export const BUSINESS_APP_FORBIDDEN_HINT =
  'Business Apps need the Marketplace › Business App Developer permission at the Delete/All level.';

export function appFailure(error: unknown): AppFailure {
  if (
    error instanceof SourceZipIgnoredDirError ||
    error instanceof SourceZipMissingManifestError ||
    error instanceof SourceZipIgnoreUnreadableError ||
    error instanceof SourceZipTooLargeError
  ) {
    return failure('source_invalid', error.message);
  }

  if (error instanceof BusinessAppError) {
    return failure(
      error.code === 'thumbnail_required' ? 'thumbnail_required' : 'local_error',
      error.message,
    );
  }

  const mapped = apiFailure(error);

  return mapped.code === 'forbidden' ? { ...mapped, hint: BUSINESS_APP_FORBIDDEN_HINT } : mapped;
}

export function compareVersions(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return Number(left) - Number(right);
  }

  return left.localeCompare(right, undefined, { numeric: true });
}

const sameVersion = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : compareVersions(left, right) === 0;

export function parseVersionArg(value: string): AppStep<string> {
  const trimmed = value.trim();

  return /^[1-9]\d*$/.test(trimmed)
    ? success(trimmed)
    : failure('usage_error', `"${value}" isn't a version number; pass a release number like 3.`);
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const versionsOf = (app: BusinessAppRow): BusinessAppVersionRow[] =>
  Array.isArray(app.versions) ? app.versions : [];

export const releasedVersionsOf = (app: BusinessAppRow): string[] =>
  [
    ...new Set(
      versionsOf(app)
        .filter((row) => row.status === 'live' || row.status === 'released')
        .map((row) => row.version),
    ),
  ].sort((left, right) => compareVersions(right, left));

export function personName(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') {
    return value;
  }

  if (isRecord(value) && typeof value.full_name === 'string' && value.full_name !== '') {
    return value.full_name;
  }

  return null;
}

function liveRow(app: BusinessAppRow): BusinessAppVersionRow | undefined {
  const versions = versionsOf(app);

  return (
    versions.find((row) => row.status === 'live') ??
    versions.find((row) => app.live_version !== null && sameVersion(row.version, app.live_version))
  );
}

export interface AppContext {
  credentials: CommandAccount;
  api: BusinessAppsApi;
  baseApiName: string;
  app: BusinessAppRow | null;
  yourPreview: BusinessAppVersionRow | null;
  stateKey: AppStateKey;
  state: AppStateLookup;
  promoted?: PromotedPreview;
  previewGone?: GonePreview;
  notices: string[];
}

export interface PromotedPreview {
  version: string;
  sourceId: string;
}

export const stateEntryOf = (context: Pick<AppContext, 'state'>): AppStateEntry | undefined =>
  context.state.status === 'found' ? context.state.entry : undefined;

const findApp = (rows: BusinessAppRow[], baseApiName: string): BusinessAppRow | null =>
  rows.find((row) => row.base_api_name === baseApiName) ?? null;

const findYourPreview = (
  app: BusinessAppRow | null,
  userId: string,
): BusinessAppVersionRow | null =>
  app === null
    ? null
    : (versionsOf(app).find(
        (row) => row.status === 'preview' && row.preview_owner?.id === userId,
      ) ?? null);

export async function loadAppContext(
  args: { credentials: CommandAccount; client: KizenClient; baseApiName: string },
  deps: AppDeps,
): Promise<AppStep<AppContext>> {
  const { credentials, baseApiName } = args;
  const api = deps.businessApps(args.client, credentials.businessId);
  let rows: BusinessAppRow[];
  let read: AppStateRead;

  try {
    [rows, read] = await Promise.all([api.listApps(baseApiName), deps.readAppState(deps.cwd)]);
  } catch (error) {
    return appFailure(error);
  }

  const app = findApp(rows, baseApiName);
  const stateKey: AppStateKey = {
    environment: credentials.environment,
    businessId: credentials.businessId,
    baseApiName,
    userId: credentials.userId,
  };
  const lookup = findAppStateEntry(read.doc, stateKey);
  const notices = read.notice === undefined ? [] : [read.notice];

  if (lookup.status === 'malformed') {
    notices.push(
      `The saved state for ${baseApiName} in .kizenapp/apps.json is malformed, so it was ignored.`,
    );
  }

  const promoted = await promotedPreviewOf(
    api,
    app,
    lookup.status === 'found' ? lookup.entry : undefined,
  );
  const yourPreview = findYourPreview(app, credentials.userId);
  const adopted = lookup.status === 'found' ? adoptPromoted(lookup.entry, promoted) : undefined;
  const previewGone: GonePreview | undefined =
    app !== null &&
    yourPreview === null &&
    adopted !== undefined &&
    PREVIEW_STATE_KEYS.some((key) => key in adopted)
      ? { sourceId: adopted.previewSourcePackageId ?? null }
      : undefined;
  const state: AppStateLookup =
    adopted === undefined
      ? lookup
      : { status: 'found', entry: dropGonePreview(adopted, previewGone) };

  if (promoted !== undefined) {
    notices.push(PROMOTED_PREVIEW_NOTICE(promoted.version));
  }

  return success({
    credentials,
    api,
    baseApiName,
    app,
    yourPreview,
    stateKey,
    state,
    ...(promoted === undefined ? {} : { promoted }),
    ...(previewGone === undefined ? {} : { previewGone }),
    notices,
  });
}

export interface GonePreview {
  sourceId: string | null;
}

function dropGonePreview(entry: AppStateEntry, gone: GonePreview | undefined): AppStateEntry {
  if (gone === undefined) {
    return entry;
  }

  return (entry.previewSourcePackageId ?? null) === gone.sourceId
    ? without(entry, ...PREVIEW_STATE_KEYS)
    : entry;
}

export const PROMOTED_PREVIEW_NOTICE = (version: string): string =>
  `The preview this folder pushed was published as Live v${version} outside this command, so v${version} is now this folder's base.`;

async function promotedPreviewOf(
  api: BusinessAppsApi,
  app: BusinessAppRow | null,
  entry: AppStateEntry | undefined,
): Promise<PromotedPreview | undefined> {
  const live = app?.live_version ?? null;
  const pushed = entry?.previewSourcePackageId;
  const folder = entry?.folderBaseLiveVersion;

  if (
    app === null ||
    live === null ||
    pushed === undefined ||
    entry?.previewRestoredFrom !== undefined ||
    folder === undefined ||
    sameVersion(folder, live)
  ) {
    return undefined;
  }

  try {
    const found = await api.getVersion(app.api_name, live);

    if (found.source_filesystem_package !== pushed) {
      return undefined;
    }

    const lineage = readSourceLineage(await api.downloadFile(pushed));

    return lineage !== null &&
      lineage.baseSourcePackageId === (entry?.folderBaseSourcePackageId ?? null)
      ? { version: live, sourceId: pushed }
      : undefined;
  } catch {
    return undefined;
  }
}

function adoptPromoted(entry: AppStateEntry, promoted: PromotedPreview | undefined): AppStateEntry {
  if (promoted === undefined || entry.previewSourcePackageId !== promoted.sourceId) {
    return entry;
  }

  return withFolderBase(without(entry, ...PREVIEW_STATE_KEYS), promoted.version, promoted.sourceId);
}

export async function refreshAppContext(context: AppContext): Promise<AppStep<AppContext>> {
  let rows: BusinessAppRow[];

  try {
    rows = await context.api.listApps(context.baseApiName);
  } catch (error) {
    return appFailure(error);
  }

  const app = findApp(rows, context.baseApiName);

  return success({
    ...context,
    app,
    yourPreview: findYourPreview(app, context.credentials.userId),
  });
}

export interface AppSummary {
  environment: Environment;
  businessId: string;
  userId: string;
  isProduction: boolean;
  baseApiName: string;
  apiName: string | null;
  name: string | null;
  liveVersion: string | null;
}

export function appSummary(context: AppContext): AppSummary {
  const { credentials, app } = context;

  return {
    environment: credentials.environment,
    businessId: credentials.businessId,
    userId: credentials.userId,
    isProduction: isProductionEnvironment(credentials.environment),
    baseApiName: context.baseApiName,
    apiName: app?.api_name ?? null,
    name: app?.name ?? null,
    liveVersion: app?.live_version ?? null,
  };
}

const blankEntry = (key: AppStateKey): AppStateEntry => ({
  ...key,
  lastPushedSourceHash: null,
});

async function rewriteAppStateIn(
  dir: string,
  change: (doc: AppStateDoc) => AppStateDoc | null,
  deps: AppDeps,
): Promise<string | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { doc } = await deps.readAppState(dir);
      const next = change(doc);

      if (next === null) {
        return null;
      }

      if (attempt === 0) {
        deps.ensureGitignore(dir);
      }

      await deps.writeAppState(dir, next);

      return null;
    } catch (error) {
      if (!(error instanceof AppStateChangedError) || attempt >= 1) {
        return errorMessage(error);
      }
    }
  }
}

const recordAppStateIn = (
  dir: string,
  key: AppStateKey,
  update: (previous: AppStateEntry) => AppStateEntry,
  deps: AppDeps,
): Promise<string | null> =>
  rewriteAppStateIn(
    dir,
    (doc) => {
      const previous = findAppStateEntry(doc, key);

      return upsertAppStateEntry(
        doc,
        update(previous.status === 'found' ? previous.entry : blankEntry(key)),
      );
    },
    deps,
  );

const recordAppState = (
  context: Pick<AppContext, 'stateKey' | 'promoted' | 'previewGone'>,
  update: (previous: AppStateEntry) => AppStateEntry,
  deps: AppDeps,
): Promise<string | null> =>
  recordAppStateIn(
    deps.cwd,
    context.stateKey,
    (previous) =>
      update(dropGonePreview(adoptPromoted(previous, context.promoted), context.previewGone)),
    deps,
  );

function without(entry: AppStateEntry, ...keys: (keyof AppStateEntry)[]): AppStateEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !(keys as string[]).includes(key)),
  ) as AppStateEntry;
}

function withFolderBase(
  entry: AppStateEntry,
  version: string | null,
  sourceId: string | null,
): AppStateEntry {
  const next = without(entry, 'folderBaseLiveVersion', 'folderBaseSourcePackageId');

  if (version === null) {
    return { ...next, folderBaseLiveVersion: null };
  }

  return sourceId === null
    ? next
    : { ...next, folderBaseLiveVersion: version, folderBaseSourcePackageId: sourceId };
}

export const folderBaseOf = (entry: AppStateEntry | undefined): string | null | undefined =>
  entry?.folderBaseLiveVersion;

const appBaseOf = (
  context: Pick<AppContext, 'app' | 'state'>,
  base: (entry: AppStateEntry | undefined) => string | null | undefined,
): string | null | undefined => (context.app === null ? undefined : base(stateEntryOf(context)));

const staleFolderBaseOf = (
  context: Pick<AppContext, 'app' | 'state'>,
): string | null | undefined =>
  context.app === null ? folderBaseOf(stateEntryOf(context)) : undefined;

export const STALE_BASE_NOTICE = (version: string): string =>
  `The base recorded for this folder (v${version}) is from a version of the app that's no longer on this business, so it's ignored.`;

const versionLabel = (version: string | null): string =>
  version === null ? 'no Live version' : `v${version}`;

const basedOn = (subject: string, version: string | null, nullText: string): string =>
  version === null ? `${subject} ${nullText}` : `${subject} is based on ${versionLabel(version)}`;

const FOLDER_NULL_BASE = 'was started before the app had a Live version';
const PREVIEW_NULL_BASE = 'was pushed before the app had a Live version';

const STATE_NOT_SAVED = (detail: string): string =>
  `.kizenapp/apps.json couldn't be written, so this isn't remembered: ${detail}`;

const isNotFound = (error: unknown): boolean =>
  error instanceof KizenApiError && error.kind === 'not_found';

const missingVersion = (context: AppContext, version: string): AppFailure =>
  failure(
    'not_found',
    `Version ${version} of ${context.baseApiName} doesn't exist on this business.`,
  );

const notPublished = (context: AppContext, what: string): AppFailure =>
  failure(
    'not_found',
    `${context.baseApiName} isn't published to this business yet, so there's nothing to ${what}.`,
  );

type PublishedContext = AppContext & { app: BusinessAppRow };

const withApp = (context: AppContext): PublishedContext | null =>
  context.app === null ? null : (context as PublishedContext);

async function fetchDefinition(
  context: PublishedContext,
  version: string,
): Promise<AppStep<BusinessAppDefinition & { source_filesystem_package: string }>> {
  let definition: BusinessAppDefinition;

  try {
    definition = await context.api.getVersion(context.app.api_name, version);
  } catch (error) {
    return isNotFound(error) ? missingVersion(context, version) : appFailure(error);
  }

  const sourceId = definition.source_filesystem_package;

  if (typeof sourceId !== 'string' || sourceId === '') {
    return failure(
      'not_found',
      `Version ${version} of ${context.baseApiName} has no source package.`,
    );
  }

  return success({ ...definition, source_filesystem_package: sourceId });
}

async function fetchSourceZip(
  context: PublishedContext,
  version: string,
): Promise<AppStep<{ sourceId: string; zip: Uint8Array }>> {
  const definition = await fetchDefinition(context, version);

  if (!definition.ok) {
    return definition;
  }

  const sourceId = definition.value.source_filesystem_package;

  try {
    return success({ sourceId, zip: await context.api.downloadFile(sourceId) });
  } catch (error) {
    return appFailure(error);
  }
}

const NO_LINEAGE: SourceLineage = { baseLiveVersion: null, baseSourcePackageId: null };

async function currentSourcePackage(
  context: PublishedContext,
  version: string,
): Promise<AppStep<string | null>> {
  const read = await readVersionPackage(context, version);

  return read.ok ? success(read.value.found ? read.value.sourceId : null) : read;
}

async function readVersionPackage(
  context: PublishedContext,
  version: string,
): Promise<AppStep<{ found: false } | { found: true; sourceId: string | null }>> {
  let found: BusinessAppDefinition;

  try {
    found = await context.api.getVersion(context.app.api_name, version);
  } catch (error) {
    return isNotFound(error) ? success({ found: false }) : appFailure(error);
  }

  const sourceId = found.source_filesystem_package;

  return success({
    found: true,
    sourceId: typeof sourceId === 'string' && sourceId !== '' ? sourceId : null,
  });
}

async function lineageFor(
  context: AppContext,
  base: string | null,
): Promise<AppStep<SourceLineage>> {
  const target = withApp(context);

  if (base === null) {
    return success(NO_LINEAGE);
  }

  if (target === null) {
    return notPublished(context, 'restore');
  }

  const found = await fetchDefinition(target, base);

  return found.ok
    ? success({ baseLiveVersion: base, baseSourcePackageId: found.value.source_filesystem_package })
    : found;
}

interface PreviewSource {
  sourcePackageId: string;
  zip: Uint8Array;
  lineage: SourceLineage | null;
}

async function downloadPreviewSource(
  api: BusinessAppsApi,
  sourcePackageId: string,
): Promise<AppStep<PreviewSource>> {
  try {
    const zip = await api.downloadFile(sourcePackageId);

    return success({ sourcePackageId, zip, lineage: readSourceLineage(zip) });
  } catch (error) {
    return appFailure(error);
  }
}

async function fetchPreviewSource(context: AppContext): Promise<AppStep<PreviewSource | null>> {
  const target = withApp(context);

  if (target === null || context.yourPreview === null) {
    return success(null);
  }

  let preview: BusinessAppDefinition;

  try {
    preview = await target.api.getPreview(target.app.api_name, target.credentials.userId);
  } catch (error) {
    return isNotFound(error) ? success(null) : appFailure(error);
  }

  const sourceId = preview.source_filesystem_package;

  return typeof sourceId === 'string' && sourceId !== ''
    ? downloadPreviewSource(target.api, sourceId)
    : success(null);
}

async function verifiedLineage(
  context: AppContext,
  lineage: SourceLineage | null,
): Promise<AppStep<SourceLineage | null>> {
  if (lineage === null) {
    return success(null);
  }

  const base = lineage.baseLiveVersion;

  if (base === null) {
    return success(lineage);
  }

  const target = withApp(context);

  if (target === null) {
    return success(null);
  }

  const current = await currentSourcePackage(target, base);

  if (!current.ok) {
    return current;
  }

  return success(
    current.value !== null && current.value === lineage.baseSourcePackageId ? lineage : null,
  );
}

export const MAX_BASE_DETECTION_DOWNLOADS = 5;

export function zipFileHashes(bytes: Uint8Array): Map<string, string> {
  const { files } = readZipEntries(bytes);

  return new Map([...files].map(([path, data]) => [path, sha256Hex(data)]));
}

const sameFiles = (left: Map<string, string>, right: Map<string, string>): boolean =>
  left.size === right.size && [...left].every(([path, hash]) => right.get(path) === hash);

export interface DetectedBase {
  version: string;
  sourceId: string;
}

export async function detectFolderBase(
  context: AppContext,
  localZip: Uint8Array,
): Promise<AppStep<DetectedBase | null>> {
  const target = withApp(context);

  if (target === null) {
    return success(null);
  }

  const live = target.app.live_version;
  const candidates = [
    ...new Set([...(live === null ? [] : [live]), ...releasedVersionsOf(target.app)]),
  ].slice(0, MAX_BASE_DETECTION_DOWNLOADS);
  let local: Map<string, string>;

  try {
    local = zipFileHashes(localZip);
  } catch {
    return success(null);
  }

  for (const version of candidates) {
    const source = await fetchSourceZip(target, version);

    if (!source.ok) {
      if (source.code === 'not_found') {
        continue;
      }

      return source;
    }

    let remote: Map<string, string>;

    try {
      remote = zipFileHashes(source.value.zip);
    } catch {
      continue;
    }

    if (sameFiles(local, remote)) {
      return success({ version, sourceId: source.value.sourceId });
    }
  }

  return success(null);
}

function sameSource(left: Uint8Array, right: Uint8Array): boolean {
  try {
    return sameFiles(zipFileHashes(left), zipFileHashes(right));
  } catch {
    return false;
  }
}

export type FolderBaseSource =
  | 'recorded'
  | 'never_published'
  | 'detected'
  | 'preview'
  | 'base_from_preview';

export interface ResolvedFolderBase {
  version: string | null;
  source: FolderBaseSource;
  lineage: SourceLineage;
  previewSourcePackageId?: string;
  notices: string[];
}

export const detectedBaseNotice = (version: string): string =>
  `No base is recorded for this folder, but its files match v${version} exactly, so v${version} is used as its base.`;

export const PREVIEW_BASE_NOTICE = (version: string | null): string =>
  `No base is recorded for this folder, but its files match your preview exactly, so your preview's base (${version === null ? 'no Live version' : `v${version}`}) is used as its base.`;

export const REPLACED_BASE_NOTICE = (version: string): string =>
  `The base recorded for this folder (v${version}) no longer matches v${version} on this business (the app or that version was deleted and created again), so it's ignored.`;

export const PREVIEW_CHANGED_BASE_NOTICE =
  "Your preview changed since this folder was said to continue it, so its base wasn't used.";

export const CONTINUE_PREVIEW_LABEL = (version: string | null): string =>
  version === null
    ? 'This folder continues your preview (pushed before the app had a Live version)'
    : `This folder continues your preview (based on v${version})`;

interface ContinuablePreview {
  sourcePackageId: string;
  lineage: SourceLineage;
}

function baseRequired(
  context: AppContext,
  live: string,
  extra: { preview?: ContinuablePreview | null; notices?: readonly string[] } = {},
): AppFailure {
  const { preview } = extra;
  const choices: CommandChoice[] = [
    {
      value: 'merge',
      label: `Preview merging Live v${live} into this folder`,
      args: [],
      argv: ['appbuilder', 'app', 'merge', '--release', live],
    },
    {
      value: 'accept',
      label: `This folder already contains Live v${live}`,
      args: [],
      argv: ['appbuilder', 'app', 'merge', '--release', live, '--accept-live-base', '--yes'],
    },
    ...(preview === undefined || preview === null
      ? []
      : [
          {
            value: 'preview',
            label: CONTINUE_PREVIEW_LABEL(preview.lineage.baseLiveVersion),
            args: [],
            argv: ['appbuilder', 'app', 'push', '--base-from-preview', preview.sourcePackageId],
          },
        ]),
  ];
  const continueText =
    preview === undefined || preview === null
      ? ''
      : " Or, if this folder continues your preview, push it with your preview's base.";

  return failure(
    'base_required',
    `${(extra.notices ?? []).map((notice) => `${notice} `).join('')}No base version is recorded for this folder, and Live is v${live}. Merge Live into this folder, or record that it already contains Live, then push.${continueText}`,
    { choice: 'base', choices },
  );
}

export type RecordedFolderBase =
  | { status: 'none' }
  | { status: 'gone'; version: string }
  | { status: 'replaced'; version: string }
  | { status: 'recorded'; version: string | null; sourceId: string | null };

export async function recordedFolderBase(
  context: AppContext,
): Promise<AppStep<RecordedFolderBase>> {
  const version = appBaseOf(context, folderBaseOf);
  const target = withApp(context);

  if (version === undefined) {
    return success({ status: 'none' });
  }

  if (version === null || target === null) {
    return success({ status: 'recorded', version: null, sourceId: null });
  }

  const recordedId = stateEntryOf(context)?.folderBaseSourcePackageId ?? '';

  if (context.promoted !== undefined && sameVersion(context.promoted.version, version)) {
    return success({ status: 'recorded', version, sourceId: context.promoted.sourceId });
  }

  const current = await readVersionPackage(target, version);

  if (!current.ok) {
    return current;
  }

  if (!current.value.found) {
    return success({ status: 'gone', version });
  }

  return current.value.sourceId === recordedId
    ? success({ status: 'recorded', version, sourceId: recordedId })
    : success({ status: 'replaced', version });
}

export const GONE_BASE_NOTICE = (version: string): string =>
  `The base recorded for this folder (v${version}) no longer exists on this business, so it's ignored.`;

export interface ResolveFolderBaseOptions {
  baseFromPreview?: string;
}

export async function resolveFolderBase(
  context: AppContext,
  localZip: Uint8Array,
  options: ResolveFolderBaseOptions = {},
): Promise<AppStep<ResolvedFolderBase>> {
  const notices: string[] = [];
  let preview: { source: PreviewSource; lineage: SourceLineage | null } | null | undefined;
  const readPreview = async (): Promise<
    AppStep<{ source: PreviewSource; lineage: SourceLineage | null } | null>
  > => {
    if (preview === undefined) {
      const source = await fetchPreviewSource(context);

      if (!source.ok) {
        return source;
      }

      if (source.value === null) {
        preview = null;
      } else {
        const lineage = await verifiedLineage(context, source.value.lineage);

        if (!lineage.ok) {
          return lineage;
        }

        preview = { source: source.value, lineage: lineage.value };
      }
    }

    return success(preview);
  };

  if (options.baseFromPreview !== undefined) {
    const read = await readPreview();

    if (!read.ok) {
      return read;
    }

    const lineage =
      read.value?.source.sourcePackageId === options.baseFromPreview ? read.value.lineage : null;

    if (lineage !== null) {
      return success({
        version: lineage.baseLiveVersion,
        source: 'base_from_preview',
        lineage,
        previewSourcePackageId: options.baseFromPreview,
        notices,
      });
    }

    notices.push(PREVIEW_CHANGED_BASE_NOTICE);
  }

  const recorded = await recordedFolderBase(context);

  if (!recorded.ok) {
    return recorded;
  }

  if (recorded.value.status === 'replaced') {
    notices.push(REPLACED_BASE_NOTICE(recorded.value.version));
  } else if (recorded.value.status === 'gone') {
    notices.push(GONE_BASE_NOTICE(recorded.value.version));
  } else if (recorded.value.status === 'recorded') {
    const { version, sourceId } = recorded.value;

    return success({
      version,
      source: 'recorded',
      lineage:
        version === null || sourceId === null
          ? NO_LINEAGE
          : { baseLiveVersion: version, baseSourcePackageId: sourceId },
      notices,
    });
  }

  const live = context.app?.live_version ?? null;

  if (live === null) {
    return success({ version: null, source: 'never_published', lineage: NO_LINEAGE, notices });
  }

  const read = await readPreview();

  if (!read.ok) {
    return read;
  }

  const lineage = read.value?.lineage ?? null;
  const continuable: ContinuablePreview | null =
    read.value === null || lineage === null
      ? null
      : { sourcePackageId: read.value.source.sourcePackageId, lineage };

  if (continuable !== null && read.value !== null && sameSource(localZip, read.value.source.zip)) {
    const base = continuable.lineage.baseLiveVersion;

    return success({
      version: base,
      source: 'preview',
      lineage: continuable.lineage,
      notices: [...notices, PREVIEW_BASE_NOTICE(base)],
    });
  }

  const detected = await detectFolderBase(context, localZip);

  if (!detected.ok) {
    return detected;
  }

  if (detected.value === null) {
    return baseRequired(context, live, { preview: continuable, notices });
  }

  const { version, sourceId } = detected.value;

  return success({
    version,
    source: 'detected',
    lineage: { baseLiveVersion: version, baseSourcePackageId: sourceId },
    notices,
  });
}

export interface AppVersionInfo {
  version: string;
  status: BusinessAppVersionRow['status'];
  previewOwner: { id: string; fullName: string } | null;
  yours: boolean;
  updated: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface RecordedBase {
  recorded: boolean;
  version: string | null;
}

export interface AppVersionsReport {
  summary: AppSummary;
  published: boolean;
  live: AppVersionInfo | null;
  released: AppVersionInfo[];
  previews: AppVersionInfo[];
  yourPreview: AppVersionInfo | null;
  base: { folder: RecordedBase; liveMoved: boolean };
  warnings: string[];
}

function versionInfo(row: BusinessAppVersionRow, userId: string): AppVersionInfo {
  const owner = row.preview_owner;

  return {
    version: row.version,
    status: row.status,
    previewOwner: owner ? { id: owner.id, fullName: owner.full_name } : null,
    yours: row.status === 'preview' && owner?.id === userId,
    updated: row.updated,
    publishedAt: row.published_at,
    publishedBy: personName(row.published_by),
  };
}

const byVersionDesc = (left: AppVersionInfo, right: AppVersionInfo): number =>
  compareVersions(right.version, left.version);

const recordedBase = (version: string | null | undefined): RecordedBase => ({
  recorded: version !== undefined,
  version: version ?? null,
});

export function describeVersions(
  context: AppContext,
  folderBase: RecordedFolderBase,
): AppVersionsReport {
  const summary = appSummary(context);
  const ignored =
    folderBase.status === 'gone'
      ? GONE_BASE_NOTICE(folderBase.version)
      : folderBase.status === 'replaced'
        ? REPLACED_BASE_NOTICE(folderBase.version)
        : undefined;
  const folder = recordedBase(folderBase.status === 'recorded' ? folderBase.version : undefined);
  const live = summary.liveVersion;
  const liveMoved = folder.recorded && live !== null && !sameVersion(folder.version, live);
  const warnings = [
    ...(ignored === undefined ? [] : [ignored]),
    ...(liveMoved
      ? [
          `Live is now ${versionLabel(live)}, but ${basedOn('this folder', folder.version, FOLDER_NULL_BASE)}. Run \`appbuilder app merge\` before publishing.`,
        ]
      : []),
  ];
  const base = { folder, liveMoved };

  if (context.app === null) {
    return {
      summary,
      published: false,
      live: null,
      released: [],
      previews: [],
      yourPreview: null,
      base,
      warnings,
    };
  }

  const infos = versionsOf(context.app).map((row) => versionInfo(row, summary.userId));
  const previews = infos.filter((info) => info.status === 'preview');

  return {
    summary,
    published: true,
    live: infos.find((info) => info.status === 'live') ?? null,
    released: infos.filter((info) => info.status === 'released').sort(byVersionDesc),
    previews,
    yourPreview: previews.find((info) => info.yours) ?? null,
    base,
    warnings,
  };
}

export interface ApplyControl {
  isAborted?: () => boolean;
}

export const CANCELLED_MESSAGE = 'Cancelled.';

const cancelled = (): AppFailure => failure('local_error', CANCELLED_MESSAGE);

export interface PreparedPush {
  deployable: DeployablePlugin;
  issues: ValidationIssue[];
  source: SourceZip;
  sourceHash: string;
}

async function packageOne(
  dir: string,
  deps: AppDeps,
): Promise<AppStep<PackagedLocalPlugin & { deployable: [DeployablePlugin] }>> {
  let packaged: PackagedLocalPlugin;

  try {
    packaged = await deps.packageLocalPlugin(dir);
  } catch (error) {
    return appFailure(error);
  }

  const [deployable, ...others] = packaged.deployable;

  if (deployable === undefined || others.length > 0) {
    return failure(
      'local_error',
      `Expected one app in ${MANIFEST}; found ${String(packaged.deployable.length)}.`,
    );
  }

  return success({ ...packaged, deployable: [deployable] });
}

export async function preparePush(deps: AppDeps): Promise<AppStep<PreparedPush>> {
  const packaged = await packageOne(deps.cwd, deps);

  if (!packaged.ok) {
    return packaged;
  }

  let source: SourceZip;

  try {
    source = await deps.zipSourceDir(deps.cwd);
  } catch (error) {
    return appFailure(error);
  }

  return success({
    deployable: packaged.value.deployable[0],
    issues: packaged.value.issues.filter((issue) => issue.severity === 'warning'),
    source,
    sourceHash: sha256Hex(source.bytes),
  });
}

/** git appends `:<path>` to a marker's label when a rename is involved. */
const LABELED_MARKER = /^(<{7} HEAD|>{7} live)(:[^\r\n]*)?[ \t\r]*$/m;

const CONFLICT_MARKER = /^(?:(?:<{7} HEAD|>{7} live)(?::[^\r\n]*)?|={7})[ \t\r]*$/m;

async function filesWithMarkers(
  paths: readonly string[],
  deps: AppDeps,
  marker: RegExp,
): Promise<string[]> {
  const found: string[] = [];

  for (const path of paths) {
    let text: string;

    try {
      text = await deps.readTextFile(join(deps.cwd, ...path.split('/')));
    } catch {
      continue;
    }

    if (marker.test(text)) {
      found.push(path);
    }
  }

  return found;
}

export const filesWithConflictMarkers = (
  entry: AppStateEntry | undefined,
  deps: AppDeps,
): Promise<string[]> => filesWithMarkers(entry?.conflictedPaths ?? [], deps, CONFLICT_MARKER);

export interface AppPushPlan {
  summary: AppSummary;
  appName: string;
  source: { files: number; mode: SourceZipMode; bytes: number; hash: string; notice?: string };
  thumbnail: boolean;
  preview: { exists: boolean; updated: string | null };
  base: { version: string | null; source: FolderBaseSource; liveMoved: boolean };
  lineage: SourceLineage;
  basePreviewSourcePackageId?: string;
  conflictMarkers: string[];
  notices: string[];
  warnings: string[];
}

export async function planPush(
  context: AppContext,
  prepared: PreparedPush,
  options: { force?: boolean } & ResolveFolderBaseOptions,
  deps: AppDeps,
): Promise<AppStep<AppPushPlan>> {
  const conflictMarkers = await filesWithConflictMarkers(stateEntryOf(context), deps);

  if (conflictMarkers.length > 0 && options.force !== true) {
    return failure(
      'unresolved_conflicts',
      `These files still have merge conflict markers: ${conflictMarkers.join(', ')}. Resolve them. Only if the user explicitly wants to push them anyway: pass --force.`,
      { files: conflictMarkers },
    );
  }

  const base = await resolveFolderBase(
    context,
    prepared.source.bytes,
    options.baseFromPreview === undefined ? {} : { baseFromPreview: options.baseFromPreview },
  );

  if (!base.ok) {
    return base;
  }

  const summary = appSummary(context);
  const { version } = base.value;
  const liveMoved = summary.liveVersion !== null && !sameVersion(version, summary.liveVersion);
  const stale = staleFolderBaseOf(context);
  const { source } = prepared;
  const thumbnail = prepared.deployable.thumbnail;
  const warnings = [
    ...(liveMoved
      ? [
          `Live is now ${versionLabel(summary.liveVersion)}, but ${basedOn('this folder', version, FOLDER_NULL_BASE)}. Publishing will stop on a conflict; run \`appbuilder app merge\` first.`,
        ]
      : []),
    ...(conflictMarkers.length > 0
      ? [
          `Pushing files that still have merge conflict markers because of --force: ${conflictMarkers.join(', ')}`,
        ]
      : []),
  ];

  return success({
    summary,
    appName: prepared.deployable.name,
    source: {
      files: source.files.length,
      mode: source.mode,
      bytes: source.bytes.byteLength,
      hash: prepared.sourceHash,
      ...(source.notice === undefined ? {} : { notice: source.notice }),
    },
    thumbnail: thumbnail !== null && thumbnail.byteLength > 0,
    preview: {
      exists: context.yourPreview !== null,
      updated: context.yourPreview?.updated ?? null,
    },
    base: { version, source: base.value.source, liveMoved },
    lineage: base.value.lineage,
    ...(base.value.previewSourcePackageId === undefined
      ? {}
      : { basePreviewSourcePackageId: base.value.previewSourcePackageId }),
    conflictMarkers,
    notices: [
      ...(stale === undefined || stale === null ? [] : [STALE_BASE_NOTICE(stale)]),
      ...base.value.notices,
      ...(base.value.source === 'detected' && version !== null
        ? [detectedBaseNotice(version)]
        : []),
    ],
    warnings,
  });
}

export interface AppliedAppPush {
  apiName: string;
  source: AppPushPlan['source'];
  version: string;
  sourcePackageId: string;
  thumbnailId: string | null;
  remembered: boolean;
  warnings: string[];
}

const SOURCE_CONTENT_TYPE = 'application/zip';

const PUSH_EDITED_FILE = '.gitignore';

function changedSourceFiles(planned: Uint8Array, current: Uint8Array): string[] {
  const before = zipFileHashes(planned);
  const after = zipFileHashes(current);

  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => path !== PUSH_EDITED_FILE && before.get(path) !== after.get(path))
    .sort();
}

const listPaths = (paths: readonly string[], max = 5): string =>
  paths.length <= max
    ? paths.join(', ')
    : `${paths.slice(0, max).join(', ')} and ${String(paths.length - max)} more`;

export const SOURCE_CHANGED_MESSAGE = (paths: readonly string[]): string =>
  `Files changed since this push was planned (${listPaths(paths)}), so nothing was uploaded. Run \`appbuilder app push\` again to review and push them.`;

const uploadThumbnail = (
  api: BusinessAppsApi,
  thumbnail: Uint8Array | null,
): Promise<string | null> =>
  thumbnail === null || thumbnail.byteLength === 0
    ? Promise.resolve(null)
    : api.uploadFile(thumbnail, {
        filename: 'thumbnail.png',
        contentType: 'image/png',
        source: 'public_image',
        isPublic: true,
      });

export const PREVIEW_CHANGED_BEFORE_PUSH_MESSAGE =
  "Your preview changed after this push was planned, so its base can't be taken for this folder and nothing was uploaded. Run `appbuilder app push` again to review it.";

export async function applyPush(
  context: AppContext,
  prepared: PreparedPush,
  plan: AppPushPlan,
  deps: AppDeps,
  { isAborted = () => false }: ApplyControl = {},
): Promise<AppStep<AppliedAppPush>> {
  const { api } = context;
  let { source, sourceHash } = prepared;
  let sourcePackageId: string;
  let thumbnailId: string | null;
  let published: { api_name: string; version: string };
  let addedIgnoreEntries: boolean;

  if (plan.basePreviewSourcePackageId !== undefined) {
    const target = withApp(context);
    let preview: BusinessAppDefinition;

    if (target === null) {
      return failure('local_error', PREVIEW_CHANGED_BEFORE_PUSH_MESSAGE);
    }

    try {
      preview = await api.getPreview(target.app.api_name, context.credentials.userId);
    } catch (error) {
      return isNotFound(error)
        ? failure('local_error', PREVIEW_CHANGED_BEFORE_PUSH_MESSAGE)
        : appFailure(error);
    }

    if (preview.source_filesystem_package !== plan.basePreviewSourcePackageId) {
      return failure('local_error', PREVIEW_CHANGED_BEFORE_PUSH_MESSAGE);
    }

    if (isAborted()) {
      return cancelled();
    }
  }

  try {
    addedIgnoreEntries = deps.ensureGitignore(deps.cwd);
  } catch {
    addedIgnoreEntries = false;
  }

  if (addedIgnoreEntries) {
    try {
      source = await deps.zipSourceDir(deps.cwd);
    } catch (error) {
      return appFailure(error);
    }

    sourceHash = sha256Hex(source.bytes);

    let changed: string[];

    try {
      changed = changedSourceFiles(prepared.source.bytes, source.bytes);
    } catch (error) {
      return appFailure(error);
    }

    if (changed.length > 0) {
      return failure('local_error', SOURCE_CHANGED_MESSAGE(changed));
    }

    if (isAborted()) {
      return cancelled();
    }
  }

  let uploaded: Uint8Array;

  try {
    uploaded = withSourceLineage(source.bytes, plan.lineage);
  } catch (error) {
    return appFailure(error);
  }

  try {
    [sourcePackageId, thumbnailId] = await Promise.all([
      api.uploadFile(uploaded, {
        filename: `${context.baseApiName}-source.zip`,
        contentType: SOURCE_CONTENT_TYPE,
        source: 'plugin_app_source_filesystem',
      }),
      uploadThumbnail(api, plan.thumbnail ? prepared.deployable.thumbnail : null),
    ]);

    if (isAborted()) {
      return cancelled();
    }

    const body = toPublishBody(prepared.deployable, {
      release: false,
      sourcePackageId,
      thumbnailId,
    });

    published = await api.publish(body);
  } catch (error) {
    return appFailure(error);
  }

  const problem = await recordAppState(
    context,
    (previous) => {
      const next: AppStateEntry = {
        ...withFolderBase(
          without(previous, 'previewRestoredFrom', 'conflictedPaths'),
          plan.base.version,
          plan.lineage.baseSourcePackageId,
        ),
        previewSourcePackageId: sourcePackageId,
        lastPushedSourceHash: sourceHash,
      };

      return plan.conflictMarkers.length > 0
        ? { ...next, conflictedPaths: plan.conflictMarkers }
        : next;
    },
    deps,
  );

  return success({
    apiName: published.api_name,
    source: {
      files: source.files.length,
      mode: source.mode,
      bytes: source.bytes.byteLength,
      hash: sourceHash,
      ...(source.notice === undefined ? {} : { notice: source.notice }),
    },
    version: published.version,
    sourcePackageId,
    thumbnailId,
    remembered: problem === null,
    warnings: problem === null ? [] : [STATE_NOT_SAVED(problem)],
  });
}

export type ConflictReason =
  | 'live_moved'
  | 'base_ahead'
  | 'base_replaced'
  | 'base_unknown'
  | 'preview_replaced';

export interface ConflictCheck {
  conflict: boolean;
  reason: ConflictReason | null;
  baseLiveVersion: string | null;
  liveVersion: string | null;
  comparedVersion: string | null;
  baseSourcePackageId: string | null;
  comparedSourcePackageId: string | null;
  previewSourceMatches: boolean | null;
  livePublishedAt: string | null;
  livePublishedBy: string | null;
  previewUpdatedAt: string | null;
}

const comparedVersionOf = (app: BusinessAppRow): string | null =>
  app.live_version ?? releasedVersionsOf(app)[0] ?? null;

export function checkPublishConflict(input: {
  entry: AppStateEntry | undefined;
  app: BusinessAppRow;
  previewUpdatedAt: string | null;
  previewSourcePackageId: string | null;
  lineage: SourceLineage | null;
  comparedSourcePackageId: string | null;
}): ConflictCheck {
  const { entry, app, previewUpdatedAt, lineage, comparedSourcePackageId } = input;
  const live = app.live_version;
  const compared = comparedVersionOf(app);
  const row = liveRow(app);
  const recordedId = entry?.previewSourcePackageId;
  const base = lineage?.baseLiveVersion ?? null;
  let reason: ConflictReason | null = null;

  if (compared !== null) {
    if (lineage === null) {
      reason = 'base_unknown';
    } else if (base === null || compareVersions(compared, base) > 0) {
      reason = 'live_moved';
    } else if (compareVersions(compared, base) < 0) {
      reason = 'base_ahead';
    } else if (lineage.baseSourcePackageId !== comparedSourcePackageId) {
      reason = 'base_replaced';
    }
  }

  return {
    conflict: reason !== null,
    reason,
    baseLiveVersion: base,
    liveVersion: live,
    comparedVersion: compared,
    baseSourcePackageId: lineage?.baseSourcePackageId ?? null,
    comparedSourcePackageId,
    previewSourceMatches:
      recordedId === undefined ? null : recordedId === input.previewSourcePackageId,
    livePublishedAt: row?.published_at ?? null,
    livePublishedBy: row === undefined ? null : personName(row.published_by),
    previewUpdatedAt,
  };
}

async function comparedPackageFor(
  context: AppContext,
  app: BusinessAppRow,
  lineage: SourceLineage | null,
): Promise<AppStep<string | null>> {
  const compared = comparedVersionOf(app);
  const base = lineage?.baseLiveVersion ?? null;

  if (compared === null || base === null || compareVersions(compared, base) !== 0) {
    return success(null);
  }

  return currentSourcePackage({ ...context, app }, compared);
}

export const CONFLICT_HINT =
  'Run `appbuilder app merge` to merge Live into this folder, then `appbuilder app push` and publish again. Only if the user explicitly wants to overwrite Live: pass --force.';

export const BASE_UNKNOWN_HINT =
  'Run `appbuilder app push` to save this folder as your preview again (the push records what it is based on), then publish. Only if the user explicitly wants to publish the preview as it is: pass --force.';

export function conflictMessage(check: ConflictCheck): string {
  const by = check.livePublishedBy === null ? '' : ` by ${check.livePublishedBy}`;
  const at = check.livePublishedAt === null ? '' : ` at ${check.livePublishedAt}`;
  const base = basedOn('your preview', check.baseLiveVersion, PREVIEW_NULL_BASE);
  const live =
    check.liveVersion === null
      ? `There's no Live version, and the latest release is ${versionLabel(check.comparedVersion)}`
      : `Live is ${versionLabel(check.liveVersion)}`;

  switch (check.reason) {
    case 'live_moved':
      return `${live}${check.liveVersion === null ? '' : ` (published${by}${at})`}, but ${base}. Publishing would overwrite the changes in between.`;
    case 'base_ahead':
      return `${live}, but ${base}, a later version that is no longer Live. Publishing could overwrite changes this folder doesn't have.`;
    case 'base_unknown':
      return `Your preview's source doesn't say what it's based on (that record is missing or can't be read), so publishing it could overwrite changes. ${live}.`;
    case 'preview_replaced':
      return PREVIEW_CHANGED_MESSAGE;
    case 'base_replaced':
      return `${live}, and ${base}, but v${check.baseLiveVersion ?? ''} on this business isn't the version your preview was based on (the app or that version was deleted and created again). Publishing could overwrite changes your preview doesn't have.`;
    case null:
      return 'No conflict.';
  }
}

function conflictFailure(check: ConflictCheck): AppFailure {
  return {
    ...failure('publish_conflict', conflictMessage(check), {
      hint: check.reason === 'base_unknown' ? BASE_UNKNOWN_HINT : CONFLICT_HINT,
    }),
    conflict: check,
  };
}

export interface AppPublishPlan {
  summary: AppSummary;
  apiName: string;
  previewUpdatedAt: string | null;
  conflictCheck: ConflictCheck;
  force: boolean;
  forced: boolean;
  /** The server counts deleted releases too, so the real number can be higher. */
  nextReleaseAtLeast: string;
  previewSourcePackageId: string;
  lineage: SourceLineage | null;
  jsActionTemplates: unknown[];
  warnings: string[];
}

export const REPLACED_PREVIEW_WARNING =
  "Your preview isn't the one this folder last pushed or restored: it was saved again from another folder or machine, and that's what publishing releases.";

async function staleWarnings(
  context: AppContext,
  previewSourcePackageId: string,
  deps: AppDeps,
): Promise<string[]> {
  const entry = stateEntryOf(context);

  if (
    entry?.previewSourcePackageId !== undefined &&
    entry.previewSourcePackageId !== previewSourcePackageId
  ) {
    return [REPLACED_PREVIEW_WARNING];
  }

  if (entry?.previewRestoredFrom !== undefined) {
    return [
      `Your preview is version ${entry.previewRestoredFrom} restored with \`appbuilder app rollback\`, not this folder's source.`,
    ];
  }

  const lastHash = entry?.lastPushedSourceHash ?? null;

  if (lastHash === null) {
    return ['No push from this folder is recorded, so your preview could not be compared with it.'];
  }

  let hash: string;

  try {
    hash = sha256Hex((await deps.zipSourceDir(deps.cwd)).bytes);
  } catch (error) {
    return [`Couldn't compare this folder with your preview: ${errorMessage(error)}`];
  }

  return hash === lastHash
    ? []
    : [
        'This folder changed since your last push. Publishing releases the preview as pushed; run `appbuilder app push` first to include the changes.',
      ];
}

function previewArtifactsList(definition: BusinessAppDefinition, key: string): unknown[] {
  const artifacts: unknown = definition.artifacts;
  const list = isRecord(artifacts) ? artifacts[key] : undefined;

  return Array.isArray(list) ? (list as unknown[]) : [];
}

const NO_PREVIEW_MESSAGE = (baseApiName: string): string =>
  `You have no preview of ${baseApiName} on this business. Push one first with \`appbuilder app push\`.`;

function nextReleaseAtLeast(app: BusinessAppRow): string {
  const highest = [
    ...releasedVersionsOf(app),
    ...(app.live_version === null ? [] : [app.live_version]),
  ]
    .filter((version) => /^\d+$/.test(version))
    .map(Number)
    .reduce((max, version) => Math.max(max, version), 0);

  return String(highest + 1);
}

export const PREVIEW_SOURCE_UNREADABLE_HINT =
  "Your preview's source couldn't be read, so what it's based on can't be checked, and publish stops even with --force. Try again; if it keeps failing, run `appbuilder app push` to save your preview again.";

export async function planPublish(
  context: AppContext,
  options: { force?: boolean; expectPreview?: string },
  deps: AppDeps,
): Promise<AppStep<AppPublishPlan>> {
  const { app, api, credentials } = context;
  const force = options.force === true;

  if (app === null) {
    return failure('no_preview', NO_PREVIEW_MESSAGE(context.baseApiName));
  }

  let definition: BusinessAppDefinition;

  try {
    definition = await api.getPreview(app.api_name, credentials.userId);
  } catch (error) {
    return isNotFound(error)
      ? failure('no_preview', NO_PREVIEW_MESSAGE(context.baseApiName))
      : appFailure(error);
  }

  const thumbnail: unknown = definition.thumbnail;

  if (thumbnail === null || thumbnail === undefined || thumbnail === '') {
    return failure(
      'thumbnail_required',
      'Your preview has no thumbnail, and a release needs one. Add thumbnail.png to the app, run `appbuilder app push`, then publish again.',
    );
  }

  if (
    typeof definition.source_filesystem_package !== 'string' ||
    definition.source_filesystem_package === ''
  ) {
    return failure(
      'preview_incomplete',
      'Your preview has no source package. Run `appbuilder app push` to save it again, then publish.',
    );
  }

  const previewUpdatedAt = context.yourPreview?.updated ?? null;
  const previewSourcePackageId = definition.source_filesystem_package;
  const checkInput = {
    entry: stateEntryOf(context),
    app,
    previewUpdatedAt,
    previewSourcePackageId,
  };

  if (options.expectPreview !== undefined && previewSourcePackageId !== options.expectPreview) {
    return previewChangedFailure(
      checkPublishConflict({ ...checkInput, lineage: null, comparedSourcePackageId: null }),
    );
  }

  const source = await downloadPreviewSource(api, previewSourcePackageId);

  if (!source.ok) {
    return { ...source, hint: source.hint ?? PREVIEW_SOURCE_UNREADABLE_HINT };
  }

  const { lineage } = source.value;
  const comparedSourcePackageId = await comparedPackageFor(context, app, lineage);

  if (!comparedSourcePackageId.ok) {
    return comparedSourcePackageId;
  }

  const conflictCheck = checkPublishConflict({
    ...checkInput,
    lineage,
    comparedSourcePackageId: comparedSourcePackageId.value,
  });

  if (conflictCheck.conflict && !force) {
    return conflictFailure(conflictCheck);
  }

  const warnings = await staleWarnings(context, previewSourcePackageId, deps);

  if (conflictCheck.conflict) {
    warnings.push(`${conflictMessage(conflictCheck)} Publishing anyway because of --force.`);
  }

  return success({
    summary: appSummary(context),
    apiName: app.api_name,
    previewUpdatedAt,
    conflictCheck,
    force,
    forced: conflictCheck.conflict,
    nextReleaseAtLeast: nextReleaseAtLeast(app),
    previewSourcePackageId,
    lineage,
    jsActionTemplates: previewArtifactsList(definition, 'js_action_templates'),
    warnings,
  });
}

export const PREVIEW_CHANGED_MESSAGE =
  "Your preview changed after this publish was planned (it was pushed again, from this or another folder or machine), so it wasn't published.";

export const PREVIEW_CHANGED_HINT =
  'Run `appbuilder app publish` again to review the preview as it is now.';

export const UNREVIEWED_RELEASE_WARNING =
  "The preview published isn't the one this publish reviewed (it was pushed again, from another folder or machine), so this folder's base wasn't advanced.";

export const RELEASE_UNCONFIRMED_WARNING = (version: string, detail: string): string =>
  `Couldn't confirm that release ${version} is the preview this publish reviewed (${detail}), so this folder's base wasn't advanced.`;

function previewChangedFailure(check: ConflictCheck): AppFailure {
  return {
    ...failure('publish_conflict', PREVIEW_CHANGED_MESSAGE, { hint: PREVIEW_CHANGED_HINT }),
    conflict: { ...check, conflict: true, reason: 'preview_replaced' },
  };
}

export interface AppliedAppPublish {
  apiName: string;
  liveVersion: string;
  previousLiveVersion: string | null;
  remembered: boolean;
  warnings: string[];
}

export async function applyPublish(
  context: AppContext,
  plan: AppPublishPlan,
  deps: AppDeps,
  { isAborted = () => false }: ApplyControl = {},
): Promise<AppStep<AppliedAppPublish>> {
  const entry = stateEntryOf(context);
  let promoted: { api_name: string; version: string };

  try {
    if (!plan.force) {
      const app = findApp(await context.api.listApps(context.baseApiName), context.baseApiName);

      if (app === null) {
        return failure('no_preview', NO_PREVIEW_MESSAGE(context.baseApiName));
      }

      let preview: BusinessAppDefinition;

      try {
        preview = await context.api.getPreview(app.api_name, context.credentials.userId);
      } catch (error) {
        return isNotFound(error)
          ? failure('no_preview', NO_PREVIEW_MESSAGE(context.baseApiName))
          : appFailure(error);
      }

      const recheckInput = {
        entry,
        app,
        previewUpdatedAt: findYourPreview(app, context.credentials.userId)?.updated ?? null,
        previewSourcePackageId: preview.source_filesystem_package,
      };

      if (preview.source_filesystem_package !== plan.previewSourcePackageId) {
        return previewChangedFailure(
          checkPublishConflict({ ...recheckInput, lineage: null, comparedSourcePackageId: null }),
        );
      }

      const comparedSourcePackageId = await comparedPackageFor(context, app, plan.lineage);

      if (!comparedSourcePackageId.ok) {
        return comparedSourcePackageId;
      }

      const recheck = checkPublishConflict({
        ...recheckInput,
        lineage: plan.lineage,
        comparedSourcePackageId: comparedSourcePackageId.value,
      });

      if (recheck.conflict) {
        return conflictFailure(recheck);
      }
    } else {
      let source: unknown;

      try {
        source = (await context.api.getPreview(plan.apiName, context.credentials.userId))
          .source_filesystem_package;
      } catch (error) {
        return isNotFound(error)
          ? failure('no_preview', NO_PREVIEW_MESSAGE(context.baseApiName))
          : appFailure(error);
      }

      if (source !== plan.previewSourcePackageId) {
        return previewChangedFailure(plan.conflictCheck);
      }
    }

    if (isAborted()) {
      return cancelled();
    }

    promoted = await context.api.promotePreview(plan.apiName, context.credentials.userId);
  } catch (error) {
    return appFailure(error);
  }

  const promoteWarnings: string[] = [];

  if (entry === undefined) {
    return success({
      apiName: promoted.api_name,
      liveVersion: promoted.version,
      previousLiveVersion: plan.summary.liveVersion,
      remembered: false,
      warnings: promoteWarnings,
    });
  }

  let pushedFromHere =
    entry.previewRestoredFrom === undefined && plan.conflictCheck.previewSourceMatches === true;

  if (pushedFromHere) {
    try {
      const released = await context.api.getVersion(promoted.api_name, promoted.version);

      if (released.source_filesystem_package !== plan.previewSourcePackageId) {
        pushedFromHere = false;
        promoteWarnings.push(UNREVIEWED_RELEASE_WARNING);
      }
    } catch (error) {
      pushedFromHere = false;
      promoteWarnings.push(RELEASE_UNCONFIRMED_WARNING(promoted.version, errorMessage(error)));
    }
  }

  const problem = await recordAppState(
    context,
    (previous) => {
      const next = without(previous, ...PREVIEW_STATE_KEYS);

      return pushedFromHere
        ? withFolderBase(next, promoted.version, plan.previewSourcePackageId)
        : next;
    },
    deps,
  );

  return success({
    apiName: promoted.api_name,
    liveVersion: promoted.version,
    previousLiveVersion: plan.summary.liveVersion,
    remembered: problem === null,
    warnings: [...promoteWarnings, ...(problem === null ? [] : [STATE_NOT_SAVED(problem)])],
  });
}

export interface AppMergeOptions {
  version?: string;
  base?: string;
  acceptLiveBase?: boolean;
}

export type MergeBaseSource = FolderBaseSource | 'flag' | 'none';

interface MergePlanBase {
  summary: AppSummary;
  targetVersion: string;
  targetIsLive: boolean;
  baseVersion: string | null | undefined;
  baseSource: MergeBaseSource;
  targetSourcePackageId: string | null;
  notices: string[];
  warnings: string[];
}

export type FallbackReason = 'no_base' | 'git_unavailable';

export type AppMergePlan =
  | (MergePlanBase & { kind: 'accept' })
  | (MergePlanBase & { kind: 'up_to_date'; ignoredIncoming: string[]; advancesBase: boolean })
  | (MergePlanBase & { kind: 'merge'; plan: ReadyMergePlan })
  | (MergePlanBase & {
      kind: 'fallback';
      reason: FallbackReason;
      detail: string;
      liveZip: Uint8Array;
      dir: string;
      choices: CommandChoice[];
    });

const stamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function noBaseDetail(base: string | null | undefined, baseMissing: boolean): string {
  if (base === undefined) {
    return "No base version is recorded for this folder, and its files don't match a released version.";
  }

  if (base === null) {
    return 'This folder was started before the app had a Live version, so there is nothing to merge against.';
  }

  return baseMissing
    ? `The base version v${base} no longer exists, so there is nothing to merge against.`
    : `The base version v${base} couldn't be used.`;
}

function fallbackChoices(app: BusinessAppRow, targetVersion: string): CommandChoice[] {
  const targetArgs = ['--release', targetVersion];

  return [
    ...releasedVersionsOf(app)
      .filter((version) => compareVersions(version, targetVersion) < 0)
      .slice(0, MAX_BASE_DETECTION_DOWNLOADS)
      .map((version) => ({
        value: `base:${version}`,
        label: `Merge, if this folder was copied from v${version}`,
        args: [],
        argv: ['appbuilder', 'app', 'merge', ...targetArgs, '--base', version, '--yes'],
      })),
    {
      value: 'accept',
      label: `This folder already contains v${targetVersion}`,
      args: [],
      argv: ['appbuilder', 'app', 'merge', ...targetArgs, '--accept-live-base', '--yes'],
    },
  ];
}

async function localZipBytes(deps: AppDeps): Promise<AppStep<Uint8Array>> {
  try {
    return success((await deps.zipSourceDir(deps.cwd)).bytes);
  } catch (error) {
    return appFailure(error);
  }
}

export async function planAppMerge(
  context: AppContext,
  options: AppMergeOptions,
  deps: AppDeps,
): Promise<AppStep<AppMergePlan>> {
  const target = withApp(context);

  if (target === null) {
    return notPublished(context, 'merge');
  }

  let targetVersion: string;

  if (options.version === undefined) {
    if (target.app.live_version === null) {
      return failure('not_found', `${context.baseApiName} has no Live version to merge.`);
    }

    targetVersion = target.app.live_version;
  } else {
    const parsed = parseVersionArg(options.version);

    if (!parsed.ok) {
      return parsed;
    }

    targetVersion = parsed.value;
  }

  let baseVersion: string | null | undefined = folderBaseOf(stateEntryOf(context));
  let baseSource: MergeBaseSource = baseVersion === undefined ? 'none' : 'recorded';
  let targetSourcePackageId: string | null = null;
  const notices: string[] = [];

  if (options.base !== undefined) {
    const parsed = parseVersionArg(options.base);

    if (!parsed.ok) {
      return parsed;
    }

    baseVersion = parsed.value;
    baseSource = 'flag';
  } else if (options.acceptLiveBase !== true && typeof baseVersion === 'string') {
    const recorded = await recordedFolderBase(context);

    if (!recorded.ok) {
      return recorded;
    }

    if (recorded.value.status === 'replaced' || recorded.value.status === 'gone') {
      notices.push(
        (recorded.value.status === 'replaced' ? REPLACED_BASE_NOTICE : GONE_BASE_NOTICE)(
          recorded.value.version,
        ),
      );
      baseVersion = undefined;
      baseSource = 'none';
    }
  }

  const leftover = await filesWithConflictMarkers(stateEntryOf(context), deps);
  const warnings =
    leftover.length === 0
      ? []
      : [
          `These files still have conflict markers from an earlier merge: ${leftover.join(', ')}. Resolve them before pushing.`,
        ];
  const common = (): MergePlanBase => ({
    summary: appSummary(context),
    targetVersion,
    targetIsLive: sameVersion(target.app.live_version, targetVersion),
    baseVersion,
    baseSource,
    targetSourcePackageId,
    notices,
    warnings,
  });

  if (options.acceptLiveBase === true) {
    const exists = await fetchDefinition(target, targetVersion);

    if (!exists.ok) {
      return exists;
    }

    targetSourcePackageId = exists.value.source_filesystem_package;

    return success({ ...common(), kind: 'accept' });
  }

  if (baseVersion === undefined) {
    const local = await localZipBytes(deps);

    if (!local.ok) {
      return local;
    }

    const detected = await detectFolderBase(context, local.value);

    if (!detected.ok) {
      return detected;
    }

    if (detected.value !== null) {
      baseVersion = detected.value.version;
      baseSource = 'detected';
      notices.push(detectedBaseNotice(detected.value.version));

      if (sameVersion(detected.value.version, targetVersion)) {
        targetSourcePackageId = detected.value.sourceId;
      }
    }
  }

  if (typeof baseVersion === 'string' && sameVersion(baseVersion, targetVersion)) {
    if (baseSource === 'flag') {
      const exists = await fetchDefinition(target, targetVersion);

      if (!exists.ok) {
        return exists;
      }

      targetSourcePackageId = exists.value.source_filesystem_package;
    }

    return success({
      ...common(),
      kind: 'up_to_date',
      ignoredIncoming: [],
      advancesBase: baseSource !== 'recorded',
    });
  }

  const liveSource = await fetchSourceZip(target, targetVersion);

  if (!liveSource.ok) {
    return liveSource;
  }

  const liveZip = liveSource.value.zip;
  let base: { version: string; zip: Uint8Array } | null = null;

  targetSourcePackageId = liveSource.value.sourceId;
  let baseMissing = false;

  if (typeof baseVersion === 'string') {
    const baseZip = await fetchSourceZip(target, baseVersion);

    if (baseZip.ok) {
      base = { version: baseVersion, zip: baseZip.value.zip };
    } else if (baseZip.code === 'not_found') {
      baseMissing = true;
    } else {
      return baseZip;
    }
  }

  let plan: MergePlan;

  try {
    plan = await deps.planMerge({
      pluginDir: deps.cwd,
      base,
      live: { version: targetVersion, zip: liveZip },
    });
  } catch (error) {
    return appFailure(error);
  }

  const fallback = (reason: FallbackReason, detail: string): AppStep<AppMergePlan> =>
    success({
      ...common(),
      kind: 'fallback',
      reason,
      detail,
      liveZip,
      dir: join(deps.cwd, '.kizenapp', `live-v${targetVersion}-${stamp(deps.now())}`),
      choices: fallbackChoices(target.app, targetVersion),
    });

  switch (plan.status) {
    case 'no_base':
      return fallback('no_base', noBaseDetail(baseVersion, baseMissing));
    case 'git_unavailable':
      return fallback('git_unavailable', plan.reason);
    case 'up_to_date':
      return success({
        ...common(),
        kind: 'up_to_date',
        ignoredIncoming: plan.ignoredIncoming,
        advancesBase: true,
      });
    case 'ready':
      return success({ ...common(), kind: 'merge', plan });
  }
}

export interface AppMergeLists {
  written: string[];
  deleted: string[];
  conflicted: string[];
  deletedOnLive: string[];
  deletedLocally: string[];
  binaryConflicts: string[];
  ignoredIncoming: string[];
}

export const EMPTY_MERGE_LISTS: AppMergeLists = {
  written: [],
  deleted: [],
  conflicted: [],
  deletedOnLive: [],
  deletedLocally: [],
  binaryConflicts: [],
  ignoredIncoming: [],
};

export function mergeListsOf(value: Partial<AppMergeLists>): AppMergeLists {
  return {
    written: value.written ?? [],
    deleted: value.deleted ?? [],
    conflicted: value.conflicted ?? [],
    deletedOnLive: value.deletedOnLive ?? [],
    deletedLocally: value.deletedLocally ?? [],
    binaryConflicts: value.binaryConflicts ?? [],
    ignoredIncoming: value.ignoredIncoming ?? [],
  };
}

const markedFiles = (lists: AppMergeLists): string[] =>
  lists.conflicted.filter(
    (path) => !lists.deletedOnLive.includes(path) && !lists.deletedLocally.includes(path),
  );

export type AppMergeStatus = 'accepted' | 'up_to_date' | 'merged' | 'conflicts' | 'fallback';

export interface AppliedAppMerge {
  status: AppMergeStatus;
  targetVersion: string;
  targetIsLive: boolean;
  baseLiveVersion: string | null | undefined;
  lists: AppMergeLists;
  markedPaths: string[];
  extracted?: { dir: string; written: number; skipped: string[] };
  remembered: boolean;
  warnings: string[];
}

export async function applyAppMerge(
  context: AppContext,
  plan: AppMergePlan,
  deps: AppDeps,
  control: ApplyControl = {},
): Promise<AppStep<AppliedAppMerge>> {
  const recordBase = async (conflictedPaths?: string[]): Promise<string[]> => {
    const problem = await recordAppState(
      context,
      (previous) => {
        const next = withFolderBase(previous, plan.targetVersion, plan.targetSourcePackageId);

        if (conflictedPaths === undefined) {
          return next;
        }

        return conflictedPaths.length === 0
          ? without(next, 'conflictedPaths')
          : { ...next, conflictedPaths };
      },
      deps,
    );

    return problem === null
      ? []
      : [
          `${STATE_NOT_SAVED(problem)} Run \`appbuilder app merge --accept-live-base${plan.targetIsLive ? '' : ` --release ${plan.targetVersion}`} --yes\` once it can be written.`,
        ];
  };

  const result = (
    status: AppMergeStatus,
    lists: AppMergeLists,
    warnings: string[],
    advanced: boolean,
  ): AppliedAppMerge => ({
    status,
    targetVersion: plan.targetVersion,
    targetIsLive: plan.targetIsLive,
    baseLiveVersion: advanced ? plan.targetVersion : plan.baseVersion,
    lists,
    markedPaths: [],
    remembered: advanced && warnings.length === 0,
    warnings,
  });

  switch (plan.kind) {
    case 'accept':
      return success(result('accepted', EMPTY_MERGE_LISTS, await recordBase(), true));
    case 'up_to_date': {
      const lists = { ...EMPTY_MERGE_LISTS, ignoredIncoming: plan.ignoredIncoming };

      return plan.advancesBase
        ? success(result('up_to_date', lists, await recordBase(), true))
        : success({ ...result('up_to_date', lists, [], false), remembered: true });
    }

    case 'merge': {
      let outcome: MergeOutcome;

      try {
        outcome = await deps.applyMerge(plan.plan, control);
      } catch (error) {
        return appFailure(error);
      }

      if (outcome.status === 'cancelled') {
        return cancelled();
      }

      if (outcome.status !== 'merged' && outcome.status !== 'conflicts') {
        return failure('local_error', `The merge didn't apply (${outcome.status}). Run it again.`);
      }

      const lists = mergeListsOf(outcome);
      const stillMarked = await filesWithConflictMarkers(stateEntryOf(context), deps);
      const writtenMarked = await filesWithMarkers(lists.written, deps, LABELED_MARKER);
      const tracked = [
        ...new Set([...stillMarked, ...markedFiles(lists), ...writtenMarked]),
      ].sort();

      return success({
        ...result(outcome.status, lists, await recordBase(tracked), true),
        markedPaths: tracked,
      });
    }

    case 'fallback': {
      let extracted: UnzipResult;

      try {
        deps.ensureGitignore(deps.cwd);
        extracted = await deps.unzipToDir(plan.liveZip, plan.dir);
      } catch (error) {
        return appFailure(error);
      }

      return success({
        ...result('fallback', EMPTY_MERGE_LISTS, [], false),
        extracted: { dir: plan.dir, written: extracted.written.length, skipped: extracted.skipped },
        remembered: false,
      });
    }
  }
}

export interface AppRollbackPlan {
  summary: AppSummary;
  version: string;
  preview: { exists: boolean; updated: string | null };
  deployable: DeployablePlugin;
  source: Uint8Array;
  warnings: string[];
}

/** The server strips services' auth_credentials from a stored version definition. */
export async function planRollback(
  context: AppContext,
  versionArg: string,
  deps: AppDeps,
): Promise<AppStep<AppRollbackPlan>> {
  const parsed = parseVersionArg(versionArg);

  if (!parsed.ok) {
    return parsed;
  }

  const target = withApp(context);

  if (target === null) {
    return notPublished(context, 'roll back');
  }

  const version = parsed.value;
  const source = await fetchSourceZip(target, version);

  if (!source.ok) {
    return source;
  }

  let tempDir: string;

  try {
    tempDir = await deps.makeTempDir();
  } catch (error) {
    return appFailure(error);
  }

  let packaged: AppStep<PackagedLocalPlugin & { deployable: [DeployablePlugin] }>;

  try {
    const sourceDir = join(tempDir, 'source');

    await deps.unzipToDir(source.value.zip, sourceDir);
    packaged = await packageOne(sourceDir, deps);
  } catch (error) {
    packaged = appFailure(error);
  } finally {
    await deps.removeDir(tempDir).catch(() => undefined);
  }

  if (!packaged.ok) {
    return {
      ...packaged,
      message: `Version ${version}'s source couldn't be packaged, so it can't be restored: ${packaged.message}`,
    };
  }

  const [deployable] = packaged.value.deployable;

  if (deployable.api_name !== context.baseApiName) {
    return failure(
      'local_error',
      `Version ${version}'s source is for ${deployable.api_name}, not ${context.baseApiName}.`,
    );
  }

  const lineage = await lineageFor(context, appSummary(context).liveVersion);

  if (!lineage.ok) {
    return lineage;
  }

  let restored: Uint8Array;

  try {
    restored = withSourceLineage(source.value.zip, lineage.value);
  } catch (error) {
    return appFailure(error);
  }

  const preview = {
    exists: context.yourPreview !== null,
    updated: context.yourPreview?.updated ?? null,
  };
  const warnings = [
    ...(preview.exists
      ? [`This replaces your current preview (last updated ${preview.updated ?? 'unknown'}).`]
      : []),
    `This folder's source isn't changed, and the next \`appbuilder app push\` replaces the restored preview with it. To keep working from version ${version}'s source, publish this preview, then pull the new Live version with \`appbuilder app pull\`.`,
  ];

  return success({
    summary: appSummary(context),
    version,
    preview,
    deployable,
    source: restored,
    warnings,
  });
}

export interface AppliedAppRollback {
  apiName: string;
  version: string;
  sourcePackageId: string;
  remembered: boolean;
  warnings: string[];
}

export async function applyRollback(
  context: AppContext,
  plan: AppRollbackPlan,
  deps: AppDeps,
  { isAborted = () => false }: ApplyControl = {},
): Promise<AppStep<AppliedAppRollback>> {
  let published: { api_name: string; version: string };
  let sourcePackageId: string;

  try {
    let thumbnailId: string | null;

    [sourcePackageId, thumbnailId] = await Promise.all([
      context.api.uploadFile(plan.source, {
        filename: `${context.baseApiName}-source.zip`,
        contentType: SOURCE_CONTENT_TYPE,
        source: 'plugin_app_source_filesystem',
      }),
      uploadThumbnail(context.api, plan.deployable.thumbnail),
    ]);

    if (isAborted()) {
      return cancelled();
    }

    const body: BusinessAppPublishBody = toPublishBody(plan.deployable, {
      release: false,
      sourcePackageId,
      thumbnailId,
    });

    published = await context.api.publish(body);
  } catch (error) {
    return appFailure(error);
  }

  const problem = await recordAppState(
    context,
    (previous) => ({
      ...previous,
      previewSourcePackageId: sourcePackageId,
      previewRestoredFrom: plan.version,
      lastPushedSourceHash: null,
    }),
    deps,
  );

  return success({
    apiName: published.api_name,
    version: plan.version,
    sourcePackageId,
    remembered: problem === null,
    warnings: problem === null ? [] : [STATE_NOT_SAVED(problem)],
  });
}

export type AppPullTarget = { kind: 'release'; version: string } | { kind: 'preview' };

export function pullTargetOf(
  version: string | undefined,
  preview: boolean,
): AppStep<AppPullTarget> {
  if (version !== undefined && preview) {
    return failure('usage_error', 'Pass either <version> or --preview, not both.');
  }

  if (version !== undefined) {
    return success({ kind: 'release', version });
  }

  return preview
    ? success({ kind: 'preview' })
    : failure(
        'usage_error',
        'Missing argument <version>. Usage: appbuilder app pull <version>, or appbuilder app pull --preview for your preview.',
      );
}

export type AppPullSource =
  | { source: 'release'; version: string }
  | { source: 'preview'; updated: string | null };

export type AppPullPlan = AppPullSource & {
  summary: AppSummary;
  dir: string;
  warnings: string[];
};

const isInside = (parent: string, child: string): boolean => child.startsWith(parent + sep);

const PREVIEW_HAS_NO_SOURCE_MESSAGE =
  "Your preview has no source package, so there's nothing to pull. Push it again with `appbuilder app push`.";

export async function planPull(
  context: AppContext,
  target: AppPullTarget,
  options: { out?: string },
  deps: AppDeps,
): Promise<AppStep<AppPullPlan>> {
  let source: AppPullSource;

  if (target.kind === 'release') {
    const parsed = parseVersionArg(target.version);

    if (!parsed.ok) {
      return parsed;
    }

    if (context.app === null) {
      return notPublished(context, 'pull');
    }

    source = { source: 'release', version: parsed.value };
  } else {
    if (context.app === null || context.yourPreview === null) {
      return failure('no_preview', NO_PREVIEW_MESSAGE(context.baseApiName));
    }

    source = { source: 'preview', updated: context.yourPreview.updated };
  }

  const cwd = resolve(deps.cwd);
  const dir =
    options.out === undefined || options.out === ''
      ? join(
          dirname(cwd),
          source.source === 'release'
            ? `${context.baseApiName}-v${source.version}`
            : `${context.baseApiName}-preview`,
        )
      : resolve(cwd, options.out);

  if (dir === cwd || isInside(dir, cwd)) {
    return failure(
      'usage_error',
      `${dir} holds the plugin folder; pass --out <dir> to choose a new folder.`,
    );
  }

  if (await deps.pathExists(dir)) {
    return failure(
      'usage_error',
      `${dir} already exists; pass --out <dir> to choose a new folder.`,
    );
  }

  const warnings =
    isInside(cwd, dir) && !isInside(join(cwd, '.kizenapp'), dir)
      ? [
          `${dir} is inside the plugin folder, so the next \`appbuilder app push\` includes it unless .gitignore or .kizenignore excludes it.`,
        ]
      : [];

  return success({ summary: appSummary(context), ...source, dir, warnings });
}

export interface PulledPreview {
  sourcePackageId: string;
  /** The base recorded for the new folder: the preview's lineage, when it checks out. */
  base: RecordedBase;
}

export interface AppliedAppPull {
  dir: string;
  written: string[];
  skipped: string[];
  remembered: boolean;
  warnings: string[];
  preview?: PulledPreview;
}

export const UNVERIFIED_PREVIEW_BASE_WARNING = (dir: string): string =>
  `Your preview's source doesn't say which release it's based on, or that release has been replaced, so no base is recorded for ${dir}. A push from there finds one when it can, or stops with \`base_required\`.`;

interface PulledSource {
  zip: Uint8Array;
  entry: AppStateEntry;
  preview?: PulledPreview;
}

async function pulledRelease(
  context: PublishedContext,
  version: string,
): Promise<AppStep<PulledSource>> {
  const source = await fetchSourceZip(context, version);

  return source.ok
    ? success({
        zip: source.value.zip,
        entry: withFolderBase(blankEntry(context.stateKey), version, source.value.sourceId),
      })
    : source;
}

/** The new folder holds your preview, so it's based on what the preview's verified lineage says. */
async function pulledPreview(context: PublishedContext): Promise<AppStep<PulledSource>> {
  let preview: BusinessAppDefinition;

  try {
    preview = await context.api.getPreview(context.app.api_name, context.credentials.userId);
  } catch (error) {
    return isNotFound(error)
      ? failure('no_preview', NO_PREVIEW_MESSAGE(context.baseApiName))
      : appFailure(error);
  }

  const sourceId = preview.source_filesystem_package;

  if (typeof sourceId !== 'string' || sourceId === '') {
    return failure('preview_incomplete', PREVIEW_HAS_NO_SOURCE_MESSAGE);
  }

  const source = await downloadPreviewSource(context.api, sourceId);

  if (!source.ok) {
    return source;
  }

  const lineage = await verifiedLineage(context, source.value.lineage);

  if (!lineage.ok) {
    return lineage;
  }

  const blank = blankEntry(context.stateKey);
  const base = lineage.value;

  return success({
    zip: source.value.zip,
    entry: {
      ...(base === null
        ? blank
        : withFolderBase(blank, base.baseLiveVersion, base.baseSourcePackageId)),
      previewSourcePackageId: sourceId,
    },
    preview: { sourcePackageId: sourceId, base: recordedBase(base?.baseLiveVersion) },
  });
}

export async function applyPull(
  context: AppContext,
  plan: AppPullPlan,
  deps: AppDeps,
  { isAborted = () => false }: ApplyControl = {},
): Promise<AppStep<AppliedAppPull>> {
  const target = withApp(context);

  if (target === null) {
    return plan.source === 'release'
      ? notPublished(context, 'pull')
      : failure('no_preview', NO_PREVIEW_MESSAGE(context.baseApiName));
  }

  const source =
    plan.source === 'release'
      ? await pulledRelease(target, plan.version)
      : await pulledPreview(target);

  if (!source.ok) {
    return source;
  }

  if (isAborted()) {
    return cancelled();
  }

  let extracted: UnzipResult;

  try {
    extracted = await deps.unzipToDir(source.value.zip, plan.dir);
  } catch (error) {
    return error instanceof ZipDestinationExistsError
      ? failure(
          'usage_error',
          `${plan.dir} already exists; pass --out <dir> to choose a new folder.`,
        )
      : appFailure(error);
  }

  let problem: string | null;

  try {
    await deps.writeAppState(plan.dir, upsertAppStateEntry(emptyAppStateDoc(), source.value.entry));
    problem = null;
  } catch (error) {
    problem = errorMessage(error);
  }

  const { preview } = source.value;
  const acceptVersion = plan.source === 'release' ? plan.version : (preview?.base.version ?? null);
  const unverified = preview !== undefined && !preview.base.recorded;

  return success({
    dir: plan.dir,
    written: extracted.written,
    skipped: extracted.skipped,
    remembered: problem === null,
    warnings: [
      ...(unverified ? [UNVERIFIED_PREVIEW_BASE_WARNING(plan.dir)] : []),
      ...(problem === null
        ? []
        : [
            acceptVersion === null
              ? STATE_NOT_SAVED(problem)
              : `${STATE_NOT_SAVED(problem)} Before pushing from ${plan.dir}, run \`appbuilder app merge --accept-live-base --release ${acceptVersion} --yes\` there.`,
          ]),
    ],
    ...(preview === undefined ? {} : { preview }),
  });
}

export interface AppPreviewOwner {
  id: string;
  fullName: string | null;
  yours: boolean;
}

export interface AppPreviewDeletePlan {
  summary: AppSummary;
  apiName: string;
  owner: AppPreviewOwner;
  preview: {
    updated: string | null;
    activeUsersCount: number | null;
    installedCount: number | null;
    otherActiveUsersCount: number | null;
  };
  deletesApp: boolean;
  warnings: string[];
}

const PREVIEW_STATE_KEYS = [
  'previewSourcePackageId',
  'previewRestoredFrom',
] as const satisfies readonly (keyof AppStateEntry)[];

const APP_STATE_KEYS = [
  'folderBaseLiveVersion',
  'folderBaseSourcePackageId',
  ...PREVIEW_STATE_KEYS,
] as const satisfies readonly (keyof AppStateEntry)[];

const previewRowOf = (app: BusinessAppRow, ownerId: string): BusinessAppVersionRow | null =>
  versionsOf(app).find((row) => row.status === 'preview' && row.preview_owner?.id === ownerId) ??
  null;

/** The server deletes an app once no version (release or preview) is left. */
const isOnlyVersion = (app: BusinessAppRow, ownerId: string): boolean =>
  versionsOf(app).every((row) => row.status === 'preview' && row.preview_owner?.id === ownerId);

const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

const ownerName = (owner: AppPreviewOwner): string => owner.fullName ?? owner.id;

const nameOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const previewOwnersHint = (app: BusinessAppRow): string | undefined => {
  const owners = versionsOf(app).flatMap((row) =>
    row.status === 'preview' && row.preview_owner !== null
      ? [`${nameOf(row.preview_owner.full_name) ?? 'unknown'} (${row.preview_owner.id})`]
      : [],
  );

  return owners.length === 0
    ? undefined
    : `Previews of ${app.base_api_name}: ${owners.join(', ')}. Pass one of these user ids to --owner.`;
};

export const NO_PREVIEW_TO_DELETE_MESSAGE = (
  baseApiName: string,
  ownerId: string,
  yours: boolean,
): string =>
  yours
    ? `You have no preview of ${baseApiName} on this business.`
    : `User ${ownerId} has no preview of ${baseApiName} on this business.`;

export const DELETES_APP_WARNING = (appName: string): string =>
  `This preview is the only version of ${appName}, so deleting it deletes the whole app from this business, with its settings and secrets.`;

export const NOT_YOUR_PREVIEW_WARNING = (name: string): string =>
  `This is ${name}'s preview, not yours.`;

export const PREVIEW_IN_USE_WARNING = (count: number, deletesApp: boolean): string =>
  `${String(count)} other ${count === 1 ? 'user is' : 'users are'} using this preview.${deletesApp ? '' : ' Deleting it switches them to their own preview, or Live, and notifies them.'}`;

const previewOf = (owner: AppPreviewOwner): string =>
  owner.yours ? 'Your preview' : `${ownerName(owner)}'s preview`;

const reviewAgain = (owner: AppPreviewOwner): string =>
  `Run \`appbuilder app preview delete --owner ${owner.id}\` to review it as it is now.`;

export const PREVIEW_GONE_MESSAGE = (baseApiName: string, owner: AppPreviewOwner): string =>
  `${previewOf(owner)} of ${baseApiName} no longer exists, so nothing was deleted.`;

export const PREVIEW_PUSHED_MESSAGE = (owner: AppPreviewOwner): string =>
  `${previewOf(owner)} was pushed again after this delete was reviewed, so nothing was deleted. ${reviewAgain(owner)}`;

export const NOW_DELETES_APP_MESSAGE = (owner: AppPreviewOwner): string =>
  `${previewOf(owner)} is now the app's only version, so deleting it would delete the whole app, which wasn't agreed to. Nothing was deleted. ${reviewAgain(owner)}`;

export interface PreviewDeleteOptions {
  owner?: string;
  expectUpdated?: string;
}

export function planPreviewDelete(
  context: AppContext,
  options: PreviewDeleteOptions,
): AppStep<AppPreviewDeletePlan> {
  const { app, credentials } = context;
  const ownerId = (options.owner ?? credentials.userId).trim();

  if (ownerId === '') {
    return failure('usage_error', '--owner needs the user id of the preview to delete.');
  }

  const yours = ownerId === credentials.userId;

  if (app === null) {
    return failure(
      'not_found',
      `${context.baseApiName} isn't published to this business yet, so it has no preview to delete.`,
    );
  }

  const row = previewRowOf(app, ownerId);

  if (row === null) {
    const hint = previewOwnersHint(app);

    return failure(
      'not_found',
      NO_PREVIEW_TO_DELETE_MESSAGE(context.baseApiName, ownerId, yours),
      hint === undefined ? {} : { hint },
    );
  }

  const owner: AppPreviewOwner = {
    id: ownerId,
    fullName: nameOf(row.preview_owner?.full_name),
    yours,
  };

  if (options.expectUpdated !== undefined && row.updated !== options.expectUpdated) {
    return failure('preview_changed', PREVIEW_PUSHED_MESSAGE(owner));
  }

  const activeUsersCount = countOf(row.active_users_count);
  // The server notifies every active user except the one deleting it.
  const otherActiveUsersCount =
    activeUsersCount === null
      ? null
      : Math.max(0, activeUsersCount - (row.is_current_for_viewer ? 1 : 0));
  const deletesApp = isOnlyVersion(app, ownerId);
  const warnings = [
    ...(deletesApp ? [DELETES_APP_WARNING(nameOf(app.name) ?? context.baseApiName)] : []),
    ...(yours ? [] : [NOT_YOUR_PREVIEW_WARNING(ownerName(owner))]),
    ...(otherActiveUsersCount !== null && otherActiveUsersCount > 0
      ? [PREVIEW_IN_USE_WARNING(otherActiveUsersCount, deletesApp)]
      : []),
  ];

  return success({
    summary: appSummary(context),
    apiName: app.api_name,
    owner,
    preview: {
      updated: row.updated,
      activeUsersCount,
      installedCount: countOf(row.installed_count),
      otherActiveUsersCount,
    },
    deletesApp,
    warnings,
  });
}

export const requireDeleteAppConsent = (
  plan: AppPreviewDeletePlan,
  deleteApp: boolean,
): AppFailure | null =>
  plan.deletesApp && !deleteApp
    ? failure('preview_changed', NOW_DELETES_APP_MESSAGE(plan.owner))
    : null;

export const APP_UNCHECKED_WARNING = (detail: string): string =>
  `The preview was deleted, but whether the app still exists couldn't be checked: ${detail}`;

export interface AppliedPreviewDelete {
  status: 'deleted';
  appDeleted: boolean | null;
  remembered: boolean;
  warnings: string[];
}

export async function applyPreviewDelete(
  context: AppContext,
  plan: AppPreviewDeletePlan,
  deps: AppDeps,
  { isAborted = () => false }: ApplyControl = {},
): Promise<AppStep<AppliedPreviewDelete>> {
  const { api, baseApiName } = context;

  if (isAborted()) {
    return cancelled();
  }

  let app: BusinessAppRow | null;

  try {
    app = findApp(await api.listApps(baseApiName), baseApiName);
  } catch (error) {
    return appFailure(error);
  }

  const row = app === null ? null : previewRowOf(app, plan.owner.id);

  if (app === null || row === null) {
    return failure('not_found', PREVIEW_GONE_MESSAGE(baseApiName, plan.owner));
  }

  if (row.updated !== plan.preview.updated) {
    return failure('preview_changed', PREVIEW_PUSHED_MESSAGE(plan.owner));
  }

  if (!plan.deletesApp && isOnlyVersion(app, plan.owner.id)) {
    return failure('preview_changed', NOW_DELETES_APP_MESSAGE(plan.owner));
  }

  if (isAborted()) {
    return cancelled();
  }

  try {
    await api.deletePreview(app.api_name, plan.owner.id);
  } catch (error) {
    return isNotFound(error)
      ? failure('not_found', PREVIEW_GONE_MESSAGE(baseApiName, plan.owner))
      : appFailure(error);
  }

  const warnings: string[] = [];
  let appDeleted: boolean | null;

  try {
    appDeleted = findApp(await api.listApps(baseApiName), baseApiName) === null;
  } catch (error) {
    appDeleted = null;
    warnings.push(APP_UNCHECKED_WARNING(errorMessage(error)));
  }

  const entry = stateEntryOf(context);
  const forgetPreview =
    plan.owner.yours && entry !== undefined && PREVIEW_STATE_KEYS.some((key) => key in entry);
  let problem: string | null = null;

  if (appDeleted === true) {
    const { environment, businessId, baseApiName: appName } = context.stateKey;
    const app = { environment, businessId, baseApiName: appName };

    problem = await rewriteAppStateIn(
      deps.cwd,
      (doc) =>
        updateAppStateEntries(doc, app, (recorded) => ({
          ...without(recorded, ...APP_STATE_KEYS),
          lastPushedSourceHash: null,
        })),
      deps,
    );
  } else if (forgetPreview) {
    problem = await recordAppState(
      context,
      (previous) => without(previous, ...PREVIEW_STATE_KEYS),
      deps,
    );
  }

  return success({
    status: 'deleted',
    appDeleted,
    remembered: problem === null,
    warnings: [...warnings, ...(problem === null ? [] : [STATE_NOT_SAVED(problem)])],
  });
}

export function deletedPreviewPlan(
  plan: AppPreviewDeletePlan,
  applied: AppliedPreviewDelete,
): AppPreviewDeletePlan {
  if (!plan.deletesApp || applied.appDeleted !== false) {
    return plan;
  }

  const appWarning = DELETES_APP_WARNING(nameOf(plan.summary.name) ?? plan.summary.baseApiName);
  const others = plan.preview.otherActiveUsersCount;

  return {
    ...plan,
    deletesApp: false,
    warnings: plan.warnings.flatMap((warning) =>
      warning === appWarning
        ? []
        : others !== null && warning === PREVIEW_IN_USE_WARNING(others, true)
          ? [PREVIEW_IN_USE_WARNING(others, false)]
          : [warning],
    ),
  };
}
