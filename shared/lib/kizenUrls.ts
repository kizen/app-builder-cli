import type { Environment } from './credentials.js';

export const BASE_URLS: Record<Environment, string> = {
  go: 'https://app.go.kizen.com/api',
  fmo: 'https://app.fmo.kizen.com/api',
  staging: 'https://staging.kizen.com/api',
  integration: 'https://integration.kizen.dev/api',
  test1: 'https://test1.kizen.dev/api',
};

export const APP_URLS: Record<Environment, string> = {
  go: 'https://go.kizen.com',
  fmo: 'https://fmo.kizen.com',
  staging: 'https://v2.staging.kizen.com',
  integration: 'https://v2.integration.kizen.dev',
  test1: 'https://test1.kizen.dev',
};

export const PRODUCTION_ENVIRONMENTS: readonly Environment[] = ['go', 'fmo'];

export function isProductionEnvironment(env: Environment): boolean {
  return PRODUCTION_ENVIRONMENTS.includes(env);
}
