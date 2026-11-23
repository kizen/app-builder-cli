// Shared by the CLI (dev startup, POST /api/last-path) and the viewer so the
// rule for "is this a path we may persist and restore?" has one definition.
//
// Every viewer route other than `/` has the shape `/$apiName/<tab>[/...]`
// (viewer/src/router.tsx). A bare `/<segment>` matches no viewer route, so it
// yields no api name and is never a restorable path.
const APP_PATH = /^\/([^/]+)\/.+/;

/** The `$apiName` segment of a viewer app route, or undefined for any other path. */
export function apiNameFromPath(path: string): string | undefined {
  return APP_PATH.exec(path)?.[1];
}

/**
 * The api names in a parsed bundle.json. Anything that isn't an array (for
 * example the `{}` /api/bundle serves when no bundle has been built) has no apps.
 */
export function bundleApiNames(bundle: unknown): string[] {
  if (!Array.isArray(bundle)) {
    return [];
  }

  return bundle.flatMap((app: unknown) => {
    const apiName = (app as { api_name?: unknown } | null)?.api_name;

    return typeof apiName === 'string' ? [apiName] : [];
  });
}

/** True when `path` is a viewer app route whose `$apiName` is one of `apiNames`. */
export function isAppPath(path: string, apiNames: readonly string[]): boolean {
  const apiName = apiNameFromPath(path);

  return apiName !== undefined && apiNames.includes(apiName);
}
