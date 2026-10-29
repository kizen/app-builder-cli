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

/**
 * The steps behind `appbuilder app …`, free of any output: each command resolves its context
 * (`loadAppContext`), plans (`planPush`, `planPublish`, …), passes the write gate, then applies
 * (`applyPush`, `applyPublish`, …). The headless runners and the TTY UI both drive these.
 *
 * Two bases are tracked: the folder's (what this folder's source is based on, in its state,
 * appState.ts) and the preview's (what the pushed preview is based on). The preview's lives on the
 * server: every source zip push and rollback upload carries it (its lineage, `sourceZip.ts`), so
 * publish reads it from the preview itself wherever it was pushed from, and a push from a machine
 * with no state can recover it. Every local step (merge, accept, pull) moves only the folder's
 * base, and push writes the folder's into the preview's lineage.
 */

/**
 * What a failure's choices are for: `environment` re-runs the same command with `args` appended;
 * `base` and `object` (`app actions`' ambiguous object) choices are other commands, in `argv`
 * (their `args` is empty).
 */
export type AppChoiceKind = 'environment' | 'base' | 'object';

/** A failed app step; `conflict` is set on a `publish_conflict`. */
export type AppFailure = CommandFailure<AppChoiceKind> & { conflict?: ConflictCheck };

export type AppStep<T> = CommandStep<T, AppFailure>;

const failure = coreFailure<AppChoiceKind>;

export interface AppDeps extends CommandDeps {
  packageLocalPlugin: (dir: string) => Promise<PackagedLocalPlugin>;
  zipSourceDir: (dir: string) => Promise<SourceZip>;
  /** The base api_name kizen.json declares; throws with a readable message when it can't. */
  readManifestApiName: (dir: string) => Promise<string>;
  businessApps: (client: KizenClient, businessId: string) => BusinessAppsApi;
  readAppState: (dir: string) => Promise<AppStateRead>;
  writeAppState: (dir: string, doc: AppStateDoc) => Promise<void>;
  /** Adds the CLI's entries to the folder's `.gitignore`; true when it changed the file. */
  ensureGitignore: (dir: string) => boolean;
  planMerge: (input: MergeInput) => Promise<MergePlan>;
  applyMerge: (plan: MergePlan, control?: ApplyControl) => Promise<MergeOutcome>;
  unzipToDir: (bytes: Uint8Array, destDir: string) => Promise<UnzipResult>;
  pathExists: (path: string) => Promise<boolean>;
  /** A UTF-8 file's text; rejects when it can't be read. */
  readTextFile: (path: string) => Promise<string>;
  /** A new empty directory outside the plugin folder, for unpacking an old version. */
  makeTempDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  /** The out-of-date warnings of the agent skills appbuilder manages here (Claude, Codex). */
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

/**
 * Maps a thrown error to a failure, with the Business App permission hint on a 403.
 */
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

/** Numeric when both are whole numbers, which every release number is. */
export function compareVersions(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return Number(left) - Number(right);
  }

  return left.localeCompare(right, undefined, { numeric: true });
}

const sameVersion = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : compareVersions(left, right) === 0;

/** A release number from the command line: a whole number from 1. */
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

/** The released (and Live) version numbers the app lists, newest first. */
export const releasedVersionsOf = (app: BusinessAppRow): string[] =>
  [
    ...new Set(
      versionsOf(app)
        .filter((row) => row.status === 'live' || row.status === 'released')
        .map((row) => row.version),
    ),
  ].sort((left, right) => compareVersions(right, left));

/** A `published_by` / `built_by` value as a name, when it carries one. */
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
  /** The app on this business, or null before its first publish. */
  app: BusinessAppRow | null;
  /** The caller's preview, when the app lists one. Previews belong to the signed-in user. */
  yourPreview: BusinessAppVersionRow | null;
  stateKey: AppStateKey;
  /** This folder's state, with `promoted` already applied to its entry. */
  state: AppStateLookup;
  /**
   * Set when the preview this folder pushed is Live now, promoted outside this CLI (the Kizen UI,
   * another machine): that version is this folder's base. Applied to `state` here, and to the
   * entry on disk by the next state write (`recordAppState`).
   */
  promoted?: PromotedPreview;
  /**
   * Set when this folder's state describes a preview but you have none on the server: its fields
   * are dropped from `state` here, and from the entry on disk by the next state write.
   */
  previewGone?: GonePreview;
  /** One-line notices about the state file. */
  notices: string[];
}

/** The Live version that is the preview this folder pushed, and its (that push's) source package. */
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

/** Finds the app by its base api_name on the signed-in business, and this folder's state for it. */
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
  // You have no preview on the server (promoted or deleted outside this CLI): what this folder
  // recorded about one names nothing now. The app is listed, so the list is the server's answer.
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

/** The preview this folder's state described, which the server no longer lists as yours. */
export interface GonePreview {
  /** Its recorded source package (null: none recorded), so a write drops only that record. */
  sourceId: string | null;
}

/**
 * `entry` without its preview fields, when they describe `gone` (still the same recorded
 * package: another run may have pushed since this one read the server).
 */
function dropGonePreview(entry: AppStateEntry, gone: GonePreview | undefined): AppStateEntry {
  if (gone === undefined) {
    return entry;
  }

  return (entry.previewSourcePackageId ?? null) === gone.sourceId
    ? without(entry, ...PREVIEW_STATE_KEYS)
    : entry;
}

/** Placeholder copy. */
export const PROMOTED_PREVIEW_NOTICE = (version: string): string =>
  `The preview this folder pushed was published as Live v${version} outside this command, so v${version} is now this folder's base.`;

/**
 * Whether the preview this folder pushed is Live now, published outside this CLI's `app publish`
 * (which records it itself): Live's source package is exactly the one this folder's push uploaded
 * (a package id names one upload; a promote keeps the preview's package). Then Live is that push's
 * source, and so the folder's base, whatever the folder changed since: edits made after the push
 * descend from the pushed source, so a merge against Live as the base keeps them and takes only
 * what Live gains later; the old base would replay the pushed changes.
 *
 * Only while the folder's base is still the one it pushed with, which Live's own lineage (the one
 * the push wrote) says: a merge or `--accept-live-base` since moved the folder to another version,
 * whose changes it holds on top of the push, so neither version is its base and the recorded one
 * stays. Never for a restored preview (`previewRestoredFrom`): its source is the restored
 * version's, not this folder's. Reads Live's definition when the rest holds, and downloads its
 * source only when the package matches; a failed read changes nothing.
 */
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

    // The push's base is the folder's still: the same package (a package names one version's
    // upload), or both null.
    return lineage !== null &&
      lineage.baseSourcePackageId === (entry?.folderBaseSourcePackageId ?? null)
      ? { version: live, sourceId: pushed }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `entry` with `promoted` recorded as `applyPublish` records a publish of a preview pushed from
 * here: the folder's base is the new Live version and the preview is gone. Only while the entry
 * still names the pushed package (another run may have pushed since).
 */
function adoptPromoted(entry: AppStateEntry, promoted: PromotedPreview | undefined): AppStateEntry {
  if (promoted === undefined || entry.previewSourcePackageId !== promoted.sourceId) {
    return entry;
  }

  return withFolderBase(without(entry, ...PREVIEW_STATE_KEYS), promoted.version, promoted.sourceId);
}

/**
 * `context` with the app (and your preview) read again, for a step that changed them: a first push
 * installs the app, so the context loaded before it has none. This folder's state isn't re-read.
 */
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
  /** The business-suffixed api_name; null before the first publish. */
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

/** A fresh entry for `key` with nothing recorded but what `update` sets. */
const blankEntry = (key: AppStateKey): AppStateEntry => ({
  ...key,
  lastPushedSourceHash: null,
});

/**
 * Reads the state file in `dir`, changes it (`change`; null: nothing to write) and atomically
 * rewrites it, adding the CLI's entries to `.gitignore` before the first write; returns an error
 * message on failure. When another run changed the file in between, it re-reads and applies
 * `change` once more.
 */
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

/** `rewriteAppStateIn` of one entry: `update` gets it as recorded, or blank for a new one. */
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

/**
 * Records this folder's entry, with what loading the app found first: a preview promoted outside
 * this CLI, or a preview you no longer have.
 */
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

/** The entry minus the given optional fields; unknown keys are kept. */
function without(entry: AppStateEntry, ...keys: (keyof AppStateEntry)[]): AppStateEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !(keys as string[]).includes(key)),
  ) as AppStateEntry;
}

/** The entry with `version` recorded as this folder's base, with that version's source package. */
function withFolderBase(
  entry: AppStateEntry,
  version: string | null,
  sourceId: string | null,
): AppStateEntry {
  const next = without(entry, 'folderBaseLiveVersion', 'folderBaseSourcePackageId');

  if (version === null) {
    return { ...next, folderBaseLiveVersion: null };
  }

  // A version is never recorded without its package (appState.ts): none, then no base.
  return sourceId === null
    ? next
    : { ...next, folderBaseLiveVersion: version, folderBaseSourcePackageId: sourceId };
}

/** This folder's recorded base; undefined when none is recorded. */
export const folderBaseOf = (entry: AppStateEntry | undefined): string | null | undefined =>
  entry?.folderBaseLiveVersion;

/**
 * A recorded base names a version of the app as it was on this business when it was recorded.
 * With no app here now (deleted since), it names nothing, so it reads as unrecorded; the next push
 * records the base afresh. (A list row carries no app id, so an app deleted and created again
 * between two runs here can't be told apart from the one the base was recorded for.)
 */
const appBaseOf = (
  context: Pick<AppContext, 'app' | 'state'>,
  base: (entry: AppStateEntry | undefined) => string | null | undefined,
): string | null | undefined => (context.app === null ? undefined : base(stateEntryOf(context)));

/** The folder's recorded base that no longer applies because the app is gone, if any. */
const staleFolderBaseOf = (
  context: Pick<AppContext, 'app' | 'state'>,
): string | null | undefined =>
  context.app === null ? folderBaseOf(stateEntryOf(context)) : undefined;

/** Placeholder copy. */
export const STALE_BASE_NOTICE = (version: string): string =>
  `The base recorded for this folder (v${version}) is from a version of the app that's no longer on this business, so it's ignored.`;

const versionLabel = (version: string | null): string =>
  version === null ? 'no Live version' : `v${version}`;

/**
 * "<subject> is based on v3"; for a null base (recorded before the app had a Live version) the
 * sentence is `nullText` instead, so a message never reads "based on no Live version".
 */
const basedOn = (subject: string, version: string | null, nullText: string): string =>
  version === null ? `${subject} ${nullText}` : `${subject} is based on ${versionLabel(version)}`;

const FOLDER_NULL_BASE = 'was started before the app had a Live version';
const PREVIEW_NULL_BASE = 'was pushed before the app had a Live version';

const STATE_NOT_SAVED = (detail: string): string =>
  `.kizenapp/apps.json couldn't be written, so this isn't remembered: ${detail}`;

const isNotFound = (error: unknown): boolean =>
  error instanceof KizenApiError && error.kind === 'not_found';

// ---------------------------------------------------------------------------------------------
// version sources

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

// ---------------------------------------------------------------------------------------------
// lineage: the preview's base, as its source on the server records it

const NO_LINEAGE: SourceLineage = { baseLiveVersion: null, baseSourcePackageId: null };

/**
 * The source package version `version` has now; null when the version doesn't exist or has none.
 * Any other failure fails.
 */
async function currentSourcePackage(
  context: PublishedContext,
  version: string,
): Promise<AppStep<string | null>> {
  const read = await readVersionPackage(context, version);

  return read.ok ? success(read.value.found ? read.value.sourceId : null) : read;
}

/** Version `version`'s source package now, telling a version that's gone (404) apart. */
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

/**
 * The lineage a write that saves `base` as the preview's base records: `base` and its source
 * package now. A base version that's gone, or has no source package, fails (`not_found`).
 */
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

/** The caller's preview's source on the server: its package, its zip and the lineage it carries. */
interface PreviewSource {
  sourcePackageId: string;
  zip: Uint8Array;
  /** Null: the source has no lineage, or one that can't be read. */
  lineage: SourceLineage | null;
}

/** Downloads a preview's source package and reads its lineage: the one extra download. */
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

/** The caller's preview's source; null when they have no preview, or it has no source package. */
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

/**
 * `lineage` when a push may take its base: a null base, or a base version that still has the
 * source package the lineage names. Null for none, and for a base the server can't vouch for (that
 * version is gone, or has another package: the app was deleted and created again).
 */
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

// ---------------------------------------------------------------------------------------------
// the folder's base: recorded, not needed, detected, or required

/** How many versions base detection downloads at most. */
export const MAX_BASE_DETECTION_DOWNLOADS = 5;

/** SHA-256 of every file in a source zip (safety-listed entries left out, as on extraction). */
export function zipFileHashes(bytes: Uint8Array): Map<string, string> {
  const { files } = readZipEntries(bytes);

  return new Map([...files].map(([path, data]) => [path, sha256Hex(data)]));
}

const sameFiles = (left: Map<string, string>, right: Map<string, string>): boolean =>
  left.size === right.size && [...left].every(([path, hash]) => right.get(path) === hash);

/** A released version a folder's source matches exactly, and that version's source package. */
export interface DetectedBase {
  version: string;
  sourceId: string;
}

/**
 * The released version this folder's source matches exactly (same paths, same SHA-256 per file),
 * trying Live first and then the listed releases newest first, downloading at most
 * `MAX_BASE_DETECTION_DOWNLOADS`. Null when none matches; a partial match is no match.
 */
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

/** Whether two source zips hold the same files (lineage and other safety-listed entries aside). */
function sameSource(left: Uint8Array, right: Uint8Array): boolean {
  try {
    return sameFiles(zipFileHashes(left), zipFileHashes(right));
  } catch {
    return false;
  }
}

/**
 * Where a push's base came from: `recorded` in this folder's state; `never_published` (no Live
 * version, so none is needed); `detected`, an exact match with a release; `preview`, an exact
 * match with your preview, whose lineage on the server names the base; `base_from_preview`, your
 * preview's base taken because you chose it (`--base-from-preview`).
 */
export type FolderBaseSource =
  | 'recorded'
  | 'never_published'
  | 'detected'
  | 'preview'
  | 'base_from_preview';

export interface ResolvedFolderBase {
  version: string | null;
  source: FolderBaseSource;
  /** What a push of this folder records in its source zip: `version` and its source package. */
  lineage: SourceLineage;
  /** For `base_from_preview`: the source package of the preview the base was taken from. */
  previewSourcePackageId?: string;
  /** One-line notices, such as a recorded base ignored because its version was replaced. */
  notices: string[];
}

export const detectedBaseNotice = (version: string): string =>
  `No base is recorded for this folder, but its files match v${version} exactly, so v${version} is used as its base.`;

/** Placeholder copy. */
export const PREVIEW_BASE_NOTICE = (version: string | null): string =>
  `No base is recorded for this folder, but its files match your preview exactly, so your preview's base (${version === null ? 'no Live version' : `v${version}`}) is used as its base.`;

/** Placeholder copy. */
export const REPLACED_BASE_NOTICE = (version: string): string =>
  `The base recorded for this folder (v${version}) no longer matches v${version} on this business (the app or that version was deleted and created again), so it's ignored.`;

/** Placeholder copy. */
export const PREVIEW_CHANGED_BASE_NOTICE =
  "Your preview changed since this folder was said to continue it, so its base wasn't used.";

/** Placeholder copy: the base_required choice that takes your preview's base. */
export const CONTINUE_PREVIEW_LABEL = (version: string | null): string =>
  version === null
    ? 'This folder continues your preview (pushed before the app had a Live version)'
    : `This folder continues your preview (based on v${version})`;

/** The caller's preview, as a base_required choice offers to continue it. */
interface ContinuablePreview {
  sourcePackageId: string;
  lineage: SourceLineage;
}

/**
 * The base_required failure: no base is recorded, Live exists, and nothing matched exactly. The
 * choices name `--release` of the Live version the message names, so a publish meanwhile can't
 * make the accept record a version the user never said this folder contains. With `preview` (the
 * caller's preview carries a lineage the server vouches for), a third choice pushes this folder
 * with that preview's base, pinned to that preview's source package; it's never picked for the
 * user.
 */
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
  // Placeholder copy (the sentence after the original message).
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

/** This folder's recorded base, checked against the server. */
export type RecordedFolderBase =
  | { status: 'none' }
  /** The recorded version no longer exists on the business (it 404s). */
  | { status: 'gone'; version: string }
  /** The recorded version now has another source package: an app deleted and created again. */
  | { status: 'replaced'; version: string }
  /** `sourceId`: its source package (null for a null base). */
  | { status: 'recorded'; version: string | null; sourceId: string | null };

/**
 * This folder's recorded base (`appBaseOf`), checked against the server: a version that 404s is
 * `gone`; one whose source package now differs from the one recorded with it is `replaced`.
 * Neither is ever trusted. A null base needs no check. One version read.
 */
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

  // Just read for a preview promoted outside this CLI: no second read of the same version.
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

/** Placeholder copy. */
export const GONE_BASE_NOTICE = (version: string): string =>
  `The base recorded for this folder (v${version}) no longer exists on this business, so it's ignored.`;

export interface ResolveFolderBaseOptions {
  /**
   * `--base-from-preview <id>`: take the base from your preview's lineage, if your preview is
   * still source package `<id>` (a base_required choice prints it) and the server vouches for it.
   */
  baseFromPreview?: string;
}

/**
 * What this folder's source is based on, and the lineage a push of it records. In order:
 * `--base-from-preview` while your preview is still the one it names; the recorded base (while
 * the app it was recorded for is here, `appBaseOf`, and its version wasn't replaced since); none
 * needed (null) without a Live version; your preview's base when this folder's files equal your
 * preview's exactly and its lineage checks out; an exact match with a released version; otherwise
 * `base_required`, which offers continuing your preview when it has a lineage but never picks it.
 * Downloads your preview's source at most once. This is the one place first-push policy lives.
 */
export async function resolveFolderBase(
  context: AppContext,
  localZip: Uint8Array,
  options: ResolveFolderBaseOptions = {},
): Promise<AppStep<ResolvedFolderBase>> {
  const notices: string[] = [];
  let preview: { source: PreviewSource; lineage: SourceLineage | null } | null | undefined;
  // Your preview's source, read once, with its lineage when the server vouches for it.
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

// ---------------------------------------------------------------------------------------------
// versions

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
  /**
   * What this folder is based on, and whether Live moved past it. (Your preview's base is in its
   * source on the server; `publish` reads it.)
   */
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

/**
 * The versions report. `folderBase` is this folder's recorded base as `recordedFolderBase` checked
 * it: one that's gone or replaced is reported as not recorded, with a warning saying why.
 */
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

// ---------------------------------------------------------------------------------------------
// cancellation

/**
 * How an apply learns the run was cancelled (Ctrl+C at a terminal): checked right before each
 * server or file write that follows an await, so a write not yet sent never starts. Headless runs
 * pass nothing and never cancel. State is still recorded after a write that completed, so this
 * folder reflects what the server now has.
 */
export interface ApplyControl {
  isAborted?: () => boolean;
}

export const CANCELLED_MESSAGE = 'Cancelled.';

const cancelled = (): AppFailure => failure('local_error', CANCELLED_MESSAGE);

// ---------------------------------------------------------------------------------------------
// push

export interface PreparedPush {
  deployable: DeployablePlugin;
  /** Validation warnings (errors stop packaging). */
  issues: ValidationIssue[];
  source: SourceZip;
  sourceHash: string;
}

/** Packages `dir` and returns its one deployable app; validation errors fail. Writes nothing. */
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

/** Packages and validates the plugin, then zips its source. Writes nothing. */
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

/**
 * A line git's merge labels as ours or Live's: `<<<<<<< HEAD` / `>>>>>>> live`, with the
 * `:path` git adds when a rename is involved (`<<<<<<< HEAD:old.js`, `>>>>>>> live:new.js`).
 * Evidence on its own that a file holds a merge's markers.
 */
const LABELED_MARKER = /^(<{7} HEAD|>{7} live)(:[^\r\n]*)?[ \t\r]*$/m;

/**
 * A labeled marker, or git's lone `=======` separator, which is left behind when only the labeled
 * lines were deleted. Only checked in files a merge marked (`conflictedPaths`): a lone `=======`
 * is ordinary text elsewhere (a Markdown heading underline, say).
 */
const CONFLICT_MARKER = /^(?:(?:<{7} HEAD|>{7} live)(?::[^\r\n]*)?|={7})[ \t\r]*$/m;

/** Which of `paths` (relative to the plugin folder) have a line `marker` matches. */
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

/**
 * The files a merge left markers in that still have one: a `<<<<<<< HEAD` / `>>>>>>> live` line,
 * or a lone `=======`.
 */
export const filesWithConflictMarkers = (
  entry: AppStateEntry | undefined,
  deps: AppDeps,
): Promise<string[]> => filesWithMarkers(entry?.conflictedPaths ?? [], deps, CONFLICT_MARKER);

export interface AppPushPlan {
  summary: AppSummary;
  /** The app's display name from kizen.json. */
  appName: string;
  source: { files: number; mode: SourceZipMode; bytes: number; hash: string; notice?: string };
  thumbnail: boolean;
  /** The caller's preview this push overwrites, if any. */
  preview: { exists: boolean; updated: string | null };
  /** The folder's base, which the push records as the preview's base too. */
  base: { version: string | null; source: FolderBaseSource; liveMoved: boolean };
  /** The lineage the uploaded source zip carries: `base.version` and its source package. */
  lineage: SourceLineage;
  /**
   * For a base taken with `--base-from-preview`: the preview's source package. The apply checks
   * your preview is still that one before uploading.
   */
  basePreviewSourcePackageId?: string;
  /** Files still holding conflict markers, pushed anyway because of --force. */
  conflictMarkers: string[];
  /** One-line notices, such as a detected base. */
  notices: string[];
  warnings: string[];
}

/**
 * Checks the folder can be pushed (no leftover conflict markers unless --force, and a known base)
 * and plans the push. Writes nothing.
 */
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
  /** The business-suffixed api_name the server returned. */
  apiName: string;
  /** The source zip uploaded: the plan's, or its re-zip after `.gitignore` gained the CLI's entries. */
  source: AppPushPlan['source'];
  /** "0": the preview. */
  version: string;
  sourcePackageId: string;
  thumbnailId: string | null;
  remembered: boolean;
  warnings: string[];
}

const SOURCE_CONTENT_TYPE = 'application/zip';

/** `.gitignore` is the one file applyPush itself edits between the plan and the upload. */
const PUSH_EDITED_FILE = '.gitignore';

/** The files whose content differs between two source zips, `.gitignore` aside, sorted. */
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

/**
 * The folder changed after the push was planned. The upload would pair that source with the
 * artifacts packaged at planning, so the push stops instead.
 */
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

/** Placeholder copy. */
export const PREVIEW_CHANGED_BEFORE_PUSH_MESSAGE =
  "Your preview changed after this push was planned, so its base can't be taken for this folder and nothing was uploaded. Run `appbuilder app push` again to review it.";

/**
 * Adds the CLI's entries to `.gitignore` first, re-zipping the source when that changed it; then
 * uploads the source zip with the plan's lineage in it (and the thumbnail), saves it as the
 * caller's preview, and records the folder's base as both the folder's and the preview's base. A
 * base taken from your preview (`--base-from-preview`) is checked once more first: your preview
 * must still be the one the plan took it from.
 */
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

    // The re-read awaited; a cancel since then uploads nothing.
    if (isAborted()) {
      return cancelled();
    }
  }

  // Recording state below edits .gitignore when it lacks the CLI's entries. Edited after the zip,
  // the pushed source (and its recorded hash) would never match this folder again, so the next
  // publish would warn that it changed. A failure here is reported when state is recorded.
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

    // The re-zip reads the folder as it is now. Anything but .gitignore that changed since the
    // plan would ship source that doesn't match the artifacts packaged then.
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

  // The folder's files as zipped, plus the lineage: the hashes of the files don't change.
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

    // Uploaded but not saved: the preview on the server is unchanged.
    if (isAborted()) {
      return cancelled();
    }

    // A push only ever saves the preview; publishing a release is `app publish`.
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

      // Markers pushed with --force are still in the folder; keep checking them.
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

// ---------------------------------------------------------------------------------------------
// publish

/**
 * `base_replaced`: the preview's base is the version compared with, by number, but that version
 * now has another source package than the one the preview was based on (the app, or that
 * version, was deleted and created again). `base_unknown`: the preview's source doesn't say what
 * it's based on (its lineage is missing or can't be read). `preview_replaced`: the preview isn't
 * the one a dry run reviewed (`--expect-preview`), or was pushed again before the promote.
 */
export type ConflictReason =
  | 'live_moved'
  | 'base_ahead'
  | 'base_replaced'
  | 'base_unknown'
  | 'preview_replaced';

export interface ConflictCheck {
  conflict: boolean;
  reason: ConflictReason | null;
  /** The preview's base, from its source's lineage (null: none, or no lineage). */
  baseLiveVersion: string | null;
  liveVersion: string | null;
  /** What the base is compared with: Live, or the latest listed release when there's no Live. */
  comparedVersion: string | null;
  /** The source package the lineage says its base had; null without one. */
  baseSourcePackageId: string | null;
  /** The source package `comparedVersion` has now, read when it's the base by number; else null. */
  comparedSourcePackageId: string | null;
  /**
   * Whether the preview on the server is the one this folder last saved (same source package);
   * null when this folder recorded none.
   */
  previewSourceMatches: boolean | null;
  livePublishedAt: string | null;
  livePublishedBy: string | null;
  previewUpdatedAt: string | null;
}

/** What publish compares a preview's base with: Live, else the latest listed release. */
const comparedVersionOf = (app: BusinessAppRow): string | null =>
  app.live_version ?? releasedVersionsOf(app)[0] ?? null;

/**
 * Whether publishing the caller's preview would overwrite a release it isn't based on, judged
 * from the lineage its source on the server carries (wherever it was pushed from). The base is
 * compared with Live, or with the latest listed release when Live was removed: a conflict when
 * they differ in either direction (a base ahead means a version was removed, so what's there is
 * unknown), and when they're equal by number but the version's source package now differs from
 * the lineage's (`base_replaced`). A source without a readable lineage is `base_unknown`. Only an
 * app with no releases at all is never a conflict: a publish never proceeds on a guess.
 */
export function checkPublishConflict(input: {
  entry: AppStateEntry | undefined;
  app: BusinessAppRow;
  previewUpdatedAt: string | null;
  /** The source package of the caller's preview on the server. */
  previewSourcePackageId: string | null;
  /** The lineage that source carries; null for none. */
  lineage: SourceLineage | null;
  /** The source package the compared version has now (`comparedPackageFor`). */
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

/**
 * The source package the version publish compares with has now, when `lineage` names that version
 * as its base (the one case `checkPublishConflict` needs it); null otherwise. A request, not a
 * download.
 */
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

/** Placeholder copy. */
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
    // Placeholder copy.
    case 'base_unknown':
      return `Your preview's source doesn't say what it's based on (that record is missing or can't be read), so publishing it could overwrite changes. ${live}.`;
    case 'preview_replaced':
      return PREVIEW_CHANGED_MESSAGE;
    // Placeholder copy.
    case 'base_replaced':
      return `${live}, and ${base}, but v${check.baseLiveVersion ?? ''} on this business isn't the version your preview was based on (the app or that version was deleted and created again). Publishing could overwrite changes your preview doesn't have.`;
    case null:
      return 'No conflict.';
  }
}

/**
 * The failure for a conflict, `publish_conflict`: answered by merging Live, or, when the preview's
 * base is unknown, by pushing this folder again.
 */
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
  /** The suffixed api_name promoted. */
  apiName: string;
  previewUpdatedAt: string | null;
  conflictCheck: ConflictCheck;
  /** --force was passed: the conflict check (here and just before promoting) doesn't stop it. */
  force: boolean;
  /** The conflict check found a conflict and --force overrode it. */
  forced: boolean;
  /**
   * The lowest number the new release can get: one past the highest listed release. The server
   * also counts deleted releases, so the real number can be higher; only the result says.
   */
  nextReleaseAtLeast: string;
  /**
   * The source package of the preview this plan reviewed. The apply promotes only that preview,
   * --force or not: a preview pushed again since (from any folder or machine) stops it, first
   * release included.
   */
  previewSourcePackageId: string;
  /**
   * The lineage the reviewed preview's source carries (null: none or unreadable). A source
   * package never changes, so the apply reuses it for that preview.
   */
  lineage: SourceLineage | null;
  /** The JS action templates of the preview this plan reviewed (`artifacts.js_action_templates`). */
  jsActionTemplates: unknown[];
  warnings: string[];
}

/** Placeholder copy. */
export const REPLACED_PREVIEW_WARNING =
  "Your preview isn't the one this folder last pushed or restored: it was saved again from another folder or machine, and that's what publishing releases.";

/**
 * How your preview differs from this folder: it was saved from elsewhere since this folder's last
 * push or rollback (`previewSourcePackageId`, the server's), it's a restored version, or this
 * folder changed since its push.
 */
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

/** One artifact list of a stored definition, checked as the server sends it; [] when absent. */
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

/** Placeholder copy. */
export const PREVIEW_SOURCE_UNREADABLE_HINT =
  "Your preview's source couldn't be read, so what it's based on can't be checked, and publish stops even with --force. Try again; if it keeps failing, run `appbuilder app push` to save your preview again.";

/**
 * Checks the caller's preview can be released (it exists, has a thumbnail and a source package),
 * warns when this folder differs from it, and runs the conflict check (`--force` skips only that)
 * on the lineage its source carries, downloaded once (a source without one is `base_unknown`).
 */
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

  // Typed string | null, but checked as the server sends it.
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

  // The preview a dry run reviewed is gone: say that, rather than whatever the new one's check
  // says. --force doesn't override it; that dry run never showed this preview.
  if (options.expectPreview !== undefined && previewSourcePackageId !== options.expectPreview) {
    return previewChangedFailure(
      checkPublishConflict({ ...checkInput, lineage: null, comparedSourcePackageId: null }),
    );
  }

  // Read even with --force: a forced publish still reports what it overrode. A failed read stops
  // it (fail closed), --force included.
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

/**
 * Placeholder copy. The release isn't the preview this publish reviewed: it was pushed again in the
 * moment between the last re-read and the promote, which names no source package.
 */
export const UNREVIEWED_RELEASE_WARNING =
  "The preview published isn't the one this publish reviewed (it was pushed again, from another folder or machine), so this folder's base wasn't advanced.";

/** Placeholder copy. */
export const RELEASE_UNCONFIRMED_WARNING = (version: string, detail: string): string =>
  `Couldn't confirm that release ${version} is the preview this publish reviewed (${detail}), so this folder's base wasn't advanced.`;

/**
 * The preview on the server isn't the one the plan reviewed: a `publish_conflict` whose check says
 * `preview_replaced`, answered by planning the publish again (not by merging).
 */
function previewChangedFailure(check: ConflictCheck): AppFailure {
  return {
    ...failure('publish_conflict', PREVIEW_CHANGED_MESSAGE, { hint: PREVIEW_CHANGED_HINT }),
    conflict: { ...check, conflict: true, reason: 'preview_replaced' },
  };
}

export interface AppliedAppPublish {
  apiName: string;
  /** The new Live version, as the server numbered it. */
  liveVersion: string;
  previousLiveVersion: string | null;
  remembered: boolean;
  warnings: string[];
}

/**
 * Re-reads the preview right before promoting: one pushed again since the plan reviewed it stops
 * the publish (`preview_replaced`, answered by planning again), --force included. Without --force
 * it also re-reads the app and re-runs the conflict check on the plan's lineage, so a release
 * published since the plan still stops it.
 * Then promotes the caller's preview as is (no upload) and records state: the preview is gone; a
 * preview pushed from this folder makes the new Live version the folder's base.
 */
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

      // Checked whether or not a release exists, before anything else: the plan's lineage is that
      // source package's, and a preview replaced while a confirm was open must not be promoted
      // unreviewed.
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
      // --force overrides a conflict, never which preview is published: only the one this plan
      // reviewed (and read the lineage of).
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

    // The re-read above awaited; a cancel since then promotes nothing.
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

  // The published preview was this folder's source: pushed from here, not restored or replaced.
  let pushedFromHere =
    entry.previewRestoredFrom === undefined && plan.conflictCheck.previewSourceMatches === true;

  // The promote names no source package, so a preview pushed again between the re-read above and
  // the promote is published unreviewed. Only the release's own source confirms which one it was.
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

      // The release's source package is the reviewed preview's (confirmed above).
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

// ---------------------------------------------------------------------------------------------
// merge

export interface AppMergeOptions {
  /** A release to merge instead of the current Live version. */
  version?: string;
  /** The version this folder came from, when none is recorded (or to override it). */
  base?: string;
  /** Record Live (or --release) as this folder's base without merging, after a merge by hand. */
  acceptLiveBase?: boolean;
}

/** Where the merge base came from. */
export type MergeBaseSource = FolderBaseSource | 'flag' | 'none';

interface MergePlanBase {
  summary: AppSummary;
  /** The version merged in: --release, else Live. */
  targetVersion: string;
  /** Whether the target is the current Live version. */
  targetIsLive: boolean;
  /** The base merged against; undefined when none is known. */
  baseVersion: string | null | undefined;
  baseSource: MergeBaseSource;
  /** The target's source package, when the plan read it; recorded with it as the folder's base. */
  targetSourcePackageId: string | null;
  notices: string[];
  /** Such as files still holding conflict markers from an earlier merge. */
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
      /** Where the target's source is extracted: a new folder under `.kizenapp`. */
      dir: string;
      /** Runnable next steps in `argv`: `--base <n>` per release, or accept. */
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

/** Each pinned to `--release` of the version this plan merges, even Live: Live can move first. */
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

/**
 * Downloads the base and Live (or --release) and plans a three-way merge into this folder. The
 * base is `--base`, else the recorded folder base, else a released version the folder matches
 * exactly. Writes nothing. Without a usable base or git, plans a fallback that extracts the
 * target under `.kizenapp` for a merge by hand.
 */
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
    // A recorded base whose version is gone, or was replaced since (the app deleted and created
    // again), names nothing this folder came from: merge as if none were recorded.
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
    // `--base` equal to the target records it as the base, like an accept: with its package.
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
      // A detected or --base base isn't recorded yet.
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

/** The lists a merge plan or outcome carries, defaulting the ones it doesn't have to []. */
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

/** The conflicted files git wrote markers into (not the delete/modify ones, which have none). */
const markedFiles = (lists: AppMergeLists): string[] =>
  lists.conflicted.filter(
    (path) => !lists.deletedOnLive.includes(path) && !lists.deletedLocally.includes(path),
  );

export type AppMergeStatus = 'accepted' | 'up_to_date' | 'merged' | 'conflicts' | 'fallback';

export interface AppliedAppMerge {
  status: AppMergeStatus;
  targetVersion: string;
  targetIsLive: boolean;
  /** This folder's base after this merge; unchanged for a fallback. */
  baseLiveVersion: string | null | undefined;
  lists: AppMergeLists;
  /**
   * After a merge, the files that still have conflict markers (this merge's and earlier ones'),
   * which push refuses until they're resolved; [] for every other outcome.
   */
  markedPaths: string[];
  /** Set for a fallback: where the target's source was extracted, and what was left out. */
  extracted?: { dir: string; written: number; skipped: string[] };
  remembered: boolean;
  warnings: string[];
}

/**
 * Applies a merge plan: writes the merged files (or, for a fallback, extracts the target under
 * `.kizenapp`), and only after a successful apply records the merged version as this folder's
 * base (never the preview's: the preview changes only when pushed). A fallback never moves the
 * base; `--accept-live-base` or `--base <n>` does that.
 */
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

      // Cancelled while it prepared: nothing moved, so the base stays.
      if (outcome.status === 'cancelled') {
        return cancelled();
      }

      if (outcome.status !== 'merged' && outcome.status !== 'conflicts') {
        return failure('local_error', `The merge didn't apply (${outcome.status}). Run it again.`);
      }

      const lists = mergeListsOf(outcome);
      // Files an earlier merge marked that still have markers stay tracked alongside the new ones,
      // and so does any file this merge wrote with markers in it (a still-marked file Live renamed).
      const stillMarked = await filesWithConflictMarkers(stateEntryOf(context), deps);
      // Labeled markers only: these files weren't conflicts, so a lone `=======` is their text.
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

// ---------------------------------------------------------------------------------------------
// rollback

export interface AppRollbackPlan {
  summary: AppSummary;
  version: string;
  /** The caller's preview this replaces, if any. */
  preview: { exists: boolean; updated: string | null };
  /** Version `version`'s source, packaged as a push would package it. */
  deployable: DeployablePlugin;
  /**
   * Version `version`'s source files, re-zipped with the restored preview's lineage (based on the
   * current Live version, as the preview's base is recorded): the source package the apply
   * uploads. Its files are the version's, unchanged.
   */
  source: Uint8Array;
  warnings: string[];
}

/**
 * Packages version `version`'s source the way a push packages this folder: downloads its source
 * zip, extracts it into a temp folder outside the plugin folder (removed afterwards) and runs the
 * packager on it. The stored definition isn't reused, because the server strips secrets
 * (services' auth_credentials) from it. The source zip gets the restored preview's lineage, so the
 * apply uploads it anew rather than reusing the version's package (whose lineage is that
 * version's own base). Writes nothing on the server.
 */
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

  // The preview's base is the current Live version (see applyRollback); its lineage says so.
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
  /** The source package uploaded for the restored preview. */
  sourcePackageId: string;
  remembered: boolean;
  warnings: string[];
}

/**
 * Saves version `version` as the caller's preview: its packaged source with its source files
 * uploaded again carrying the preview's lineage, and a freshly uploaded thumbnail, published with
 * release false (which only ever writes the caller's own preview). The preview's base becomes the
 * current Live version, since publishing it means replacing Live on purpose; the lineage records
 * the same base. This folder's base is untouched.
 */
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

    // Uploaded but not saved: the preview on the server is unchanged.
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

// ---------------------------------------------------------------------------------------------
// pull

export interface AppPullPlan {
  summary: AppSummary;
  version: string;
  /** Absolute path of the new folder the source goes into. */
  dir: string;
  warnings: string[];
}

const isInside = (parent: string, child: string): boolean => child.startsWith(parent + sep);

/**
 * Where `app pull` extracts: `--out` (relative to the plugin folder), else a sibling folder
 * `<base_api_name>-v<version>` next to it, so the pulled copy is never part of this folder's source.
 */
export async function planPull(
  context: AppContext,
  versionArg: string,
  options: { out?: string },
  deps: AppDeps,
): Promise<AppStep<AppPullPlan>> {
  const parsed = parseVersionArg(versionArg);

  if (!parsed.ok) {
    return parsed;
  }

  if (context.app === null) {
    return notPublished(context, 'pull');
  }

  const version = parsed.value;
  const cwd = resolve(deps.cwd);
  const dir =
    options.out === undefined || options.out === ''
      ? join(dirname(cwd), `${context.baseApiName}-v${version}`)
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

  return success({ summary: appSummary(context), version, dir, warnings });
}

export interface AppliedAppPull {
  dir: string;
  written: string[];
  /** Entries the safety list kept out (a `.git` folder, `.env`, …). */
  skipped: string[];
  /** The new folder's state records `version` as its base, so a push from it is checked. */
  remembered: boolean;
  warnings: string[];
}

/**
 * Downloads the version's source zip, extracts it into the plan's new folder, and records the
 * version as that folder's base (same environment, business, app and user), so pushing and
 * publishing from it is checked against Live like any other folder.
 */
export async function applyPull(
  context: AppContext,
  plan: AppPullPlan,
  deps: AppDeps,
  { isAborted = () => false }: ApplyControl = {},
): Promise<AppStep<AppliedAppPull>> {
  const target = withApp(context);

  if (target === null) {
    return notPublished(context, 'pull');
  }

  const source = await fetchSourceZip(target, plan.version);

  if (!source.ok) {
    return source;
  }

  // Downloaded but not extracted: no folder is created.
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
    await deps.writeAppState(
      plan.dir,
      upsertAppStateEntry(
        emptyAppStateDoc(),
        withFolderBase(blankEntry(context.stateKey), plan.version, source.value.sourceId),
      ),
    );
    problem = null;
  } catch (error) {
    problem = errorMessage(error);
  }

  return success({
    dir: plan.dir,
    written: extracted.written,
    skipped: extracted.skipped,
    remembered: problem === null,
    warnings:
      problem === null
        ? []
        : [
            `${STATE_NOT_SAVED(problem)} Before pushing from ${plan.dir}, run \`appbuilder app merge --accept-live-base --release ${plan.version} --yes\` there.`,
          ],
  });
}

// ---------------------------------------------------------------------------------------------
// preview delete

export interface AppPreviewOwner {
  id: string;
  /** Null when the server names no one. */
  fullName: string | null;
  yours: boolean;
}

export interface AppPreviewDeletePlan {
  summary: AppSummary;
  /** The suffixed api_name. */
  apiName: string;
  owner: AppPreviewOwner;
  preview: {
    updated: string | null;
    /** The users using it now, its owner included; null when the server doesn't say. */
    activeUsersCount: number | null;
    installedCount: number | null;
    /**
     * The users other than you using it now: the ones the delete switches to their own preview
     * (else Live) and notifies. Null when the server doesn't say.
     */
    otherActiveUsersCount: number | null;
  };
  /** It's the app's only version (no release, no other preview): deleting it deletes the app. */
  deletesApp: boolean;
  warnings: string[];
}

/** The fields of a state entry that describe the caller's preview, cleared when it's deleted. */
const PREVIEW_STATE_KEYS = [
  'previewSourcePackageId',
  'previewRestoredFrom',
] as const satisfies readonly (keyof AppStateEntry)[];

/**
 * The fields of a state entry that name versions of the app on this business, cleared (with the
 * last push's hash) when the app is deleted. Conflict markers are this folder's files: they stay.
 */
const APP_STATE_KEYS = [
  'folderBaseLiveVersion',
  'folderBaseSourcePackageId',
  ...PREVIEW_STATE_KEYS,
] as const satisfies readonly (keyof AppStateEntry)[];

const previewRowOf = (app: BusinessAppRow, ownerId: string): BusinessAppVersionRow | null =>
  versionsOf(app).find((row) => row.status === 'preview' && row.preview_owner?.id === ownerId) ??
  null;

/**
 * Whether `ownerId`'s preview is the app's only version: the server deletes an app once no
 * version (release or preview) is left.
 */
const isOnlyVersion = (app: BusinessAppRow, ownerId: string): boolean =>
  versionsOf(app).every((row) => row.status === 'preview' && row.preview_owner?.id === ownerId);

const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

const ownerName = (owner: AppPreviewOwner): string => owner.fullName ?? owner.id;

/** A name as the server sends it; null for none or an empty one. */
const nameOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** Placeholder copy. */
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

/** Placeholder copy. */
export const NO_PREVIEW_TO_DELETE_MESSAGE = (
  baseApiName: string,
  ownerId: string,
  yours: boolean,
): string =>
  yours
    ? `You have no preview of ${baseApiName} on this business.`
    : `User ${ownerId} has no preview of ${baseApiName} on this business.`;

/** Placeholder copy. */
export const DELETES_APP_WARNING = (appName: string): string =>
  `This preview is the only version of ${appName}, so deleting it deletes the whole app from this business, with its settings and secrets.`;

/** Placeholder copy. */
export const NOT_YOUR_PREVIEW_WARNING = (name: string): string =>
  `This is ${name}'s preview, not yours.`;

/** Placeholder copy. */
export const PREVIEW_IN_USE_WARNING = (count: number, deletesApp: boolean): string =>
  `${String(count)} other ${count === 1 ? 'user is' : 'users are'} using this preview.${deletesApp ? '' : ' Deleting it switches them to their own preview, or Live, and notifies them.'}`;

/** Placeholder copy. "Your preview" or "Bo's preview", to start a sentence. */
const previewOf = (owner: AppPreviewOwner): string =>
  owner.yours ? 'Your preview' : `${ownerName(owner)}'s preview`;

/**
 * Placeholder copy. The dry run that reviews `owner`'s preview again: always by id, so it never
 * means another.
 */
const reviewAgain = (owner: AppPreviewOwner): string =>
  `Run \`appbuilder app preview delete --owner ${owner.id}\` to review it as it is now.`;

/** Placeholder copy. */
export const PREVIEW_GONE_MESSAGE = (baseApiName: string, owner: AppPreviewOwner): string =>
  `${previewOf(owner)} of ${baseApiName} no longer exists, so nothing was deleted.`;

/** Placeholder copy. */
export const PREVIEW_PUSHED_MESSAGE = (owner: AppPreviewOwner): string =>
  `${previewOf(owner)} was pushed again after this delete was reviewed, so nothing was deleted. ${reviewAgain(owner)}`;

/** Placeholder copy. */
export const NOW_DELETES_APP_MESSAGE = (owner: AppPreviewOwner): string =>
  `${previewOf(owner)} is now the app's only version, so deleting it would delete the whole app, which wasn't agreed to. Nothing was deleted. ${reviewAgain(owner)}`;

export interface PreviewDeleteOptions {
  /** A user id: delete this user's preview instead of yours. */
  owner?: string;
  /**
   * `--expect-updated`: the `updated` of the preview a dry run reviewed. The plan refuses with
   * `preview_changed` unless the preview is still that one.
   */
  expectUpdated?: string;
}

/**
 * Finds the preview to delete: yours, or `owner`'s (a user id), from the app's version rows, and
 * warns about what deleting it does. Writes nothing.
 */
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

  // The preview a dry run reviewed is gone: say that, rather than plan the new one.
  if (options.expectUpdated !== undefined && row.updated !== options.expectUpdated) {
    return failure('preview_changed', PREVIEW_PUSHED_MESSAGE(owner));
  }

  const activeUsersCount = countOf(row.active_users_count);
  // The server notifies every active user but the one deleting it, who is active on it exactly
  // when it's the version they're using.
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

/**
 * A plan that deletes the app needs the user's go-ahead for that (`--delete-app`, which a dry
 * run's `applyArgv` carries only when it showed the warning); without it, `preview_changed`.
 */
export const requireDeleteAppConsent = (
  plan: AppPreviewDeletePlan,
  deleteApp: boolean,
): AppFailure | null =>
  plan.deletesApp && !deleteApp
    ? failure('preview_changed', NOW_DELETES_APP_MESSAGE(plan.owner))
    : null;

/** Placeholder copy. */
export const APP_UNCHECKED_WARNING = (detail: string): string =>
  `The preview was deleted, but whether the app still exists couldn't be checked: ${detail}`;

export interface AppliedPreviewDelete {
  status: 'deleted';
  /**
   * The app no longer exists on this business, as re-read after the delete (the preview was its
   * last version); null when that re-read failed.
   */
  appDeleted: boolean | null;
  remembered: boolean;
  warnings: string[];
}

/**
 * Re-reads the app right before deleting: the preview must still be there, not pushed again since
 * the plan, and not have become the app's only version unannounced. Then deletes it, re-reads the
 * app to report whether the server deleted the app with it. For your own preview, it clears this
 * folder's record of it (its base stays); when the app went too, it clears every base recorded
 * here for that app, whoever's preview it was and whichever user recorded it. The DELETE names no precondition, so a change
 * between the re-read and the DELETE itself isn't caught (as with publish's promote).
 */
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

  // The re-read above awaited; a cancel since then deletes nothing.
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
  // Someone else's preview is never this folder's; nothing recorded, nothing to clear.
  const forgetPreview =
    plan.owner.yours && entry !== undefined && PREVIEW_STATE_KEYS.some((key) => key in entry);
  let problem: string | null = null;

  if (appDeleted === true) {
    // The app went with the preview: every base recorded here for it named a version of it, and
    // nothing pushed from here is on the server any more, whoever's preview it was and whichever
    // user recorded it.
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

/**
 * The plan as the delete turned out: when it was to delete the app but the re-read after it found
 * the app still there (another version appeared in the last moment), it no longer says so.
 */
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
