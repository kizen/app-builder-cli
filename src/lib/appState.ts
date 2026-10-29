import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errorMessage, isMissingFileError, isRecord } from './guards.js';

export const APP_STATE_RELATIVE_PATH = '.kizenapp/apps.json';

const CORRUPT_SUFFIX = '.corrupt';

export interface AppStateKey {
  environment: string;
  businessId: string;
  baseApiName: string;
  userId: string;
}

export interface AppStateEntry extends AppStateKey {
  folderBaseLiveVersion?: string | null;
  folderBaseSourcePackageId?: string;
  previewSourcePackageId?: string;
  lastPushedSourceHash: string | null;
  previewRestoredFrom?: string;
  conflictedPaths?: string[];
  [key: string]: unknown;
}

export interface AppStateDoc {
  rest: Record<string, unknown>;
  entries: unknown[];
  corrupt: boolean;
  unreadable?: boolean;
  fingerprint?: string | null;
}

export interface AppStateRead {
  doc: AppStateDoc;
  notice?: string;
}

export class AppStateChangedError extends Error {
  constructor() {
    super(`${APP_STATE_RELATIVE_PATH} changed while this command ran, so it wasn't written.`);
    this.name = 'AppStateChangedError';
  }
}

export class AppStateUnreadableError extends Error {
  constructor() {
    super(
      `${APP_STATE_RELATIVE_PATH} exists but couldn't be read, so it wasn't overwritten. Fix its permissions and run the command again.`,
    );
    this.name = 'AppStateUnreadableError';
  }
}

export const emptyAppStateDoc = (): AppStateDoc => ({
  rest: {},
  entries: [],
  corrupt: false,
  fingerprint: null,
});

const KEY_FIELDS = ['environment', 'businessId', 'baseApiName', 'userId'] as const;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isOptionalNullableString = (value: unknown): boolean =>
  value === undefined || isNullableString(value);

const matchesKey = (value: unknown, key: AppStateKey): boolean =>
  isRecord(value) && KEY_FIELDS.every((field) => value[field] === key[field]);

function isAppStateEntry(value: unknown): value is AppStateEntry {
  return (
    isRecord(value) &&
    KEY_FIELDS.every((field) => typeof value[field] === 'string' && value[field] !== '') &&
    isOptionalNullableString(value.folderBaseLiveVersion) &&
    (typeof value.folderBaseLiveVersion === 'string'
      ? typeof value.folderBaseSourcePackageId === 'string' &&
        value.folderBaseSourcePackageId !== ''
      : value.folderBaseSourcePackageId === undefined) &&
    (value.previewSourcePackageId === undefined ||
      typeof value.previewSourcePackageId === 'string') &&
    isNullableString(value.lastPushedSourceHash) &&
    (value.previewRestoredFrom === undefined || typeof value.previewRestoredFrom === 'string') &&
    (value.conflictedPaths === undefined ||
      (Array.isArray(value.conflictedPaths) &&
        value.conflictedPaths.every((path) => typeof path === 'string')))
  );
}

async function fingerprintOf(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath, { bigint: true });

    return `${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

const corruptRead = (problem: string, fingerprint: string | null): AppStateRead => ({
  doc: { ...emptyAppStateDoc(), corrupt: true, fingerprint },
  notice: `${APP_STATE_RELATIVE_PATH} ${problem}, so it was ignored. It will be moved to ${APP_STATE_RELATIVE_PATH}${CORRUPT_SUFFIX} on the next write.`,
});

export async function readAppState(pluginDir: string): Promise<AppStateRead> {
  const filePath = join(pluginDir, APP_STATE_RELATIVE_PATH);
  let fingerprint: string | null;
  let raw: string;

  try {
    fingerprint = await fingerprintOf(filePath);
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return { doc: emptyAppStateDoc() };
    }

    return {
      doc: { ...emptyAppStateDoc(), unreadable: true },
      notice: `Couldn't read ${APP_STATE_RELATIVE_PATH} (${errorMessage(error)}), so it was ignored and won't be written.`,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return corruptRead('is not valid JSON', fingerprint);
  }

  if (!isRecord(parsed) || (parsed.apps !== undefined && !Array.isArray(parsed.apps))) {
    return corruptRead('is not in the expected format', fingerprint);
  }

  const { apps, ...rest } = parsed;
  const entries: unknown[] = Array.isArray(apps) ? [...(apps as unknown[])] : [];

  return { doc: { rest, entries, corrupt: false, fingerprint } };
}

export type AppStateLookup =
  | { status: 'found'; entry: AppStateEntry }
  | { status: 'missing' }
  | { status: 'malformed' };

export function findAppStateEntry(doc: AppStateDoc, key: AppStateKey): AppStateLookup {
  const matches = doc.entries.filter((entry) => matchesKey(entry, key));
  const last = matches.at(-1);

  if (last === undefined) {
    return { status: 'missing' };
  }

  return isAppStateEntry(last) ? { status: 'found', entry: last } : { status: 'malformed' };
}

export type AppStateAppKey = Omit<AppStateKey, 'userId'>;

const APP_KEY_FIELDS = ['environment', 'businessId', 'baseApiName'] as const;

export function updateAppStateEntries(
  doc: AppStateDoc,
  app: AppStateAppKey,
  update: (entry: AppStateEntry) => AppStateEntry,
): AppStateDoc | null {
  const entries = doc.entries.map((value) => {
    if (!isRecord(value) || !APP_KEY_FIELDS.every((field) => value[field] === app[field])) {
      return value;
    }

    if (!isAppStateEntry(value)) {
      return value;
    }

    const next = update(value);

    return JSON.stringify(next) === JSON.stringify(value) ? value : next;
  });

  return entries.some((entry, index) => entry !== doc.entries[index]) ? { ...doc, entries } : null;
}

export function upsertAppStateEntry(doc: AppStateDoc, entry: AppStateEntry): AppStateDoc {
  return {
    ...doc,
    entries: [...doc.entries.filter((existing) => !matchesKey(existing, entry)), entry],
  };
}

export async function writeAppState(pluginDir: string, doc: AppStateDoc): Promise<void> {
  if (doc.unreadable === true) {
    throw new AppStateUnreadableError();
  }

  const filePath = join(pluginDir, APP_STATE_RELATIVE_PATH);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;

  await mkdir(dirname(filePath), { recursive: true });

  const body = { ...doc.rest, apps: doc.entries };

  try {
    await writeFile(tempPath, `${JSON.stringify(body, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    if ((await fingerprintOf(filePath)) !== (doc.fingerprint ?? null)) {
      throw new AppStateChangedError();
    }

    if (doc.corrupt) {
      try {
        await rename(filePath, `${filePath}${CORRUPT_SUFFIX}`);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }

    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);

    throw error;
  }
}
