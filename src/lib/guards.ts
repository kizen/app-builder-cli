import { posix } from 'node:path';

/** A plain object: not null and not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `error` carries this errno `code` (ENOENT, EEXIST, ESRCH, …). */
export const isErrnoCode = (error: unknown, code: string): boolean =>
  (error as { code?: unknown } | null)?.code === code;

export const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && isErrnoCode(error, 'ENOENT');

/** `p`'s value, or undefined when it rejects with ENOENT; any other rejection propagates. */
export const ifExists = async <T>(p: Promise<T>): Promise<T | undefined> => {
  try {
    return await p;
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }
};

export const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The most specific reason a request failed: fetch's underlying `cause` code
 * (ECONNREFUSED, ENOTFOUND, …), else the error's own code or message.
 */
export const errorCause = (error: unknown): string => {
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };

  return e.cause?.code ?? e.code ?? e.cause?.message ?? e.message ?? String(error);
};

/**
 * Normalizes a kizen.json `entry` to a root-relative directory with no leading
 * "./" and no trailing slash. "", "." and "./" mean the plugin root and map to "".
 */
export const normalizeEntryDir = (entry: string): string => {
  const normalized = posix.normalize(entry.trim().replaceAll('\\', '/')).replace(/\/+$/, '');

  return normalized === '.' ? '' : normalized;
};
