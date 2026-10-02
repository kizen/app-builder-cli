import { posix } from 'node:path';

/** A plain object: not null and not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Normalizes a kizen.json `entry` to a root-relative directory with no leading
 * "./" and no trailing slash. "", "." and "./" mean the plugin root and map to "".
 */
export const normalizeEntryDir = (entry: string): string => {
  const normalized = posix.normalize(entry.trim().replaceAll('\\', '/')).replace(/\/+$/, '');

  return normalized === '.' ? '' : normalized;
};
