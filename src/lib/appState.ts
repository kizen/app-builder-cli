import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errorMessage, isMissingFileError, isRecord } from './guards.js';

/**
 * `.kizenapp/apps.json`: what this plugin folder knows about its Business App, per environment,
 * business, app and signed-in user. The preview's base isn't here: it's in the preview's source on
 * the server (its lineage, `sourceZip.ts`).
 *
 * - `folderBaseLiveVersion`: the Live version this folder's source is based on (null: none). Set
 *   by push, merge, `--accept-live-base`, pull (in the folder it creates) and a publish of a
 *   preview pushed from this folder (by this CLI or outside it).
 * - `folderBaseSourcePackageId`: that version's source package, required with a version. A
 *   version of that number whose package differs now belongs to an app deleted and created
 *   again, so the base no longer applies.
 * - `previewSourcePackageId`: the source package of the preview this folder last saved (push's
 *   or rollback's upload), which tells your preview on the server, or a release promoted from it,
 *   apart from one saved elsewhere.
 *
 * The file is `{ "apps": [entry, …], …other keys }`. Keys this version doesn't know, at the top
 * level and in each entry, are kept on write. A missing file is empty. A malformed one reads as
 * empty with a notice and is moved aside to `apps.json.corrupt` on the next write. An unreadable
 * one (EACCES, …) reads as empty with a notice and is never written over.
 *
 * Writes go to a temp file that is renamed over the old one, so a crash never leaves a
 * half-written file. A write also refuses (`AppStateChangedError`) when the file changed since it
 * was read (inode, size and mtime), so two runs can't silently drop each other's entries; callers
 * re-read and retry. The check and the rename aren't one atomic step: a write landing between
 * them can still be lost. That window is a few microseconds and needs two CLI runs on one folder
 * at once.
 */

export const APP_STATE_RELATIVE_PATH = '.kizenapp/apps.json';

const CORRUPT_SUFFIX = '.corrupt';

export interface AppStateKey {
  environment: string;
  businessId: string;
  /** The app's api_name as kizen.json has it (unsuffixed). */
  baseApiName: string;
  userId: string;
}

export interface AppStateEntry extends AppStateKey {
  /** The Live version this folder's source is based on (null: none); absent when unknown. */
  folderBaseLiveVersion?: string | null;
  /** The source package of `folderBaseLiveVersion`: present exactly when that's a version. */
  folderBaseSourcePackageId?: string;
  /** The source package id of the preview this folder saved; absent when none is recorded. */
  previewSourcePackageId?: string;
  /** SHA-256 (hex) of the source zip last pushed; null when the preview isn't this folder's source. */
  lastPushedSourceHash: string | null;
  /** Set by `app rollback`: the version the caller's preview was restored from. */
  previewRestoredFrom?: string;
  /** Files a merge left conflict markers in; `app push` refuses while any still has them. */
  conflictedPaths?: string[];
  [key: string]: unknown;
}

export interface AppStateDoc {
  /** Every top-level key of the file except `apps`. */
  rest: Record<string, unknown>;
  /** The `apps` list as read, unknown or malformed entries included. */
  entries: unknown[];
  /** The file on disk is malformed; the next write moves it aside first. */
  corrupt: boolean;
  /** The file exists but couldn't be read; writing is refused rather than replacing it. */
  unreadable?: boolean;
  /** The file's identity when read (null: it didn't exist); a write refuses if it changed. */
  fingerprint?: string | null;
}

export interface AppStateRead {
  doc: AppStateDoc;
  /** Why the file read as empty, when it existed but couldn't be used. */
  notice?: string;
}

/** The file changed between reading and writing it; re-read and apply the change again. */
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
    // A version always comes with its package; nothing else has one.
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

/** Reads the state file; never throws. */
export async function readAppState(pluginDir: string): Promise<AppStateRead> {
  const filePath = join(pluginDir, APP_STATE_RELATIVE_PATH);
  let fingerprint: string | null;
  let raw: string;

  try {
    // Taken before reading: if the file changes during the read, the write's check catches it.
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

/** The entry for `key`. A malformed entry for it counts as no entry, so callers treat it as unknown. */
export function findAppStateEntry(doc: AppStateDoc, key: AppStateKey): AppStateLookup {
  const matches = doc.entries.filter((entry) => matchesKey(entry, key));
  const last = matches.at(-1);

  if (last === undefined) {
    return { status: 'missing' };
  }

  return isAppStateEntry(last) ? { status: 'found', entry: last } : { status: 'malformed' };
}

/** An app on a business, for every signed-in user: an `AppStateKey` without its `userId`. */
export type AppStateAppKey = Omit<AppStateKey, 'userId'>;

const APP_KEY_FIELDS = ['environment', 'businessId', 'baseApiName'] as const;

/**
 * `doc` with `update` applied to every entry for `app`, whatever its user. Other apps' entries,
 * and malformed ones, are kept as read. Null when no entry changes, so there's nothing to write.
 */
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

/** Replaces every entry for `entry`'s key with `entry`; other entries are kept as read. */
export function upsertAppStateEntry(doc: AppStateDoc, entry: AppStateEntry): AppStateDoc {
  return {
    ...doc,
    entries: [...doc.entries.filter((existing) => !matchesKey(existing, entry)), entry],
  };
}

/**
 * Writes the state file atomically (a temp file in `.kizenapp`, renamed over the old one). A
 * corrupt file is renamed to `apps.json.corrupt` first. Throws `AppStateUnreadableError` for a
 * doc read from an unreadable file and `AppStateChangedError` when the file changed since `doc`
 * was read.
 */
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
