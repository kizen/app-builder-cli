import type { Environment } from '@kizenapps/packager';

// What the user picked. 'auto' derives dev/prod from release_environments.
export type EncryptionTargetSetting = 'auto' | 'dev' | 'prod';

// The concrete host the encryption call routes to.
export type ResolvedEncryptionTarget = 'dev' | 'prod';

// A plugin released to any of these environments must encrypt its secrets
// against production keys (KZN-16467). 'go'/'fmo' are the production Kizen
// clusters; 'prod' is the manifest alias. Any one of them present is the
// production signal, even alongside non-prod environments.
const PROD_RELEASE_ENVIRONMENTS = new Set<Environment>(['prod', 'go', 'fmo']);

/**
 * Derives the encryption target from a plugin's release_environments.
 * Defaults to 'dev' (safe — never prod) when no production environment is
 * present or the list is missing.
 */
export function autoEncryptionTarget(
  releaseEnvironments: readonly Environment[] | undefined,
): ResolvedEncryptionTarget {
  return releaseEnvironments?.some((env) => PROD_RELEASE_ENVIRONMENTS.has(env)) ? 'prod' : 'dev';
}

/** Resolves the saved setting to a concrete dev/prod target. */
export function resolveEncryptionTarget(
  setting: EncryptionTargetSetting,
  releaseEnvironments: readonly Environment[] | undefined,
): ResolvedEncryptionTarget {
  return setting === 'auto' ? autoEncryptionTarget(releaseEnvironments) : setting;
}
