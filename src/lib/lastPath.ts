import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bundleApiNames, isAppPath } from '../../shared/lib/lastPath.js';
import { loadConfig, saveConfig } from './config.js';

/**
 * The api names in `<outputDir>/bundle.json`. A missing or unparseable bundle
 * has no apps.
 */
export async function readBundleApiNames(outputDir: string): Promise<string[]> {
  try {
    const content = await readFile(join(outputDir, 'bundle.json'), 'utf-8');

    return bundleApiNames(JSON.parse(content));
  } catch {
    return [];
  }
}

/**
 * `path` when its `$apiName` is an app in the current `<outputDir>/bundle.json`,
 * otherwise undefined. Reads the bundle on every call, so it reflects rebuilds
 * made since the dev session started.
 */
export async function restorablePath(
  outputDir: string,
  path: string | undefined,
): Promise<string | undefined> {
  if (path === undefined) {
    return undefined;
  }

  return isAppPath(path, await readBundleApiNames(outputDir)) ? path : undefined;
}

/**
 * The saved `lastPath` the viewer may reopen at, or undefined to open at `/`.
 * A saved path whose `$apiName` isn't an app in bundle.json (for example
 * `/embed/sandbox`, persisted by a viewer copy nested in a plugin iframe) is
 * removed from config.json so the bad value doesn't survive to the next start.
 * That removal is best-effort: a failed write never blocks dev startup.
 */
export async function resolveRestorableLastPath(outputDir: string): Promise<string | undefined> {
  const config = await loadConfig(outputDir);
  const { lastPath } = config;

  if (lastPath === undefined) {
    return undefined;
  }

  const restorable = await restorablePath(outputDir, lastPath);

  if (restorable !== undefined) {
    return restorable;
  }

  const healed = { ...config };

  delete healed.lastPath;

  try {
    await saveConfig(outputDir, healed);
  } catch {
    // Unwritable config.json: the bad path is still not restored this run.
  }

  return undefined;
}
