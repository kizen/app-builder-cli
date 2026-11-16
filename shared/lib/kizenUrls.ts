import type { Environment } from './credentials.js';

export const BASE_URLS: Record<Environment, string> = {
  go: 'https://app.go.kizen.com/api',
  fmo: 'https://app.fmo.kizen.com/api',
  staging: 'https://staging.kizen.com/api',
  'e2e-staging': 'https://app.e2e-staging.kizen.com/api',
  integration: 'https://integration.kizen.dev/api',
  'e2e-integration': 'https://e2e-integration.kizen.dev/api',
  test1: 'https://app.test1.kizen.dev/api',
  perf: 'https://app.perf.kizen.dev/api',
};

/** The origin of an environment's API, without `/api`. It is also its OAuth issuer. */
export const apiOriginFor = (env: Environment): string => new URL(BASE_URLS[env]).origin;

export const APP_URLS: Record<Environment, string> = {
  go: 'https://go.kizen.com',
  fmo: 'https://fmo.kizen.com',
  staging: 'https://v2.staging.kizen.com',
  'e2e-staging': 'https://e2e-staging.kizen.com',
  integration: 'https://v2.integration.kizen.dev',
  'e2e-integration': 'https://v2.e2e-integration.kizen.dev',
  test1: 'https://test1.kizen.dev',
  perf: 'https://perf.kizen.dev',
};

export const PRODUCTION_ENVIRONMENTS: readonly Environment[] = ['go', 'fmo'];

export function isProductionEnvironment(env: Environment): boolean {
  return PRODUCTION_ENVIRONMENTS.includes(env);
}
