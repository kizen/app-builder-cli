/**
 * Shared helper for resolving the encryption API (plugin-wizard) base URL.
 * Imported by both the dev server request handler and the `encrypt` CLI command
 * so the host defaults and env-var names live in one place. KZN-16467.
 */

export const ENCRYPTION_API_DEFAULTS = {
  prod: 'https://plugin-wizard.kizen.com', // deployed prod encryption service
  dev: 'https://plugin-wizard.kizen.dev', // deployed dev encryption service
  localDev: 'http://localhost:9823', // local plugin-wizard (APPBUILDER_LOCAL_DEV)
} as const;

/**
 * Resolves the base URL for the encryption API (plugin-wizard) public-key
 * endpoint. Precedence for the `dev` target:
 *   1. `PLUGIN_WIZARD_URL`     — forces a single host for ALL targets.
 *   2. `PLUGIN_WIZARD_URL_DEV` — explicit dev URL.
 *   3. `APPBUILDER_LOCAL_DEV`  — any non-empty value → localhost:9823.
 *   4. Hardcoded default       — deployed dev service.
 * Prod follows the same pattern minus step 3.
 */
export function resolveWizardBase(target: 'dev' | 'prod'): string {
  const forced = process.env.PLUGIN_WIZARD_URL;

  if (forced !== undefined && forced !== '') {
    return forced;
  }

  if (target === 'prod') {
    // `||` (not `??`) so an empty-string env var falls back to the default,
    // matching the PLUGIN_WIZARD_URL / *_DEV branches above and below.
    return process.env.PLUGIN_WIZARD_URL_PROD || ENCRYPTION_API_DEFAULTS.prod;
  }

  if (process.env.PLUGIN_WIZARD_URL_DEV !== undefined && process.env.PLUGIN_WIZARD_URL_DEV !== '') {
    return process.env.PLUGIN_WIZARD_URL_DEV;
  }

  if (process.env.APPBUILDER_LOCAL_DEV !== undefined && process.env.APPBUILDER_LOCAL_DEV !== '') {
    return ENCRYPTION_API_DEFAULTS.localDev;
  }

  return ENCRYPTION_API_DEFAULTS.dev;
}
