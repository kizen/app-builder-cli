import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENCRYPTION_API_DEFAULTS, resolveWizardBase } from './wizardUrl.js';

// Every var the resolver reads, cleared before each scenario so the ambient
// environment cannot leak into an assertion.
const WIZARD_ENV_VARS = [
  'PLUGIN_WIZARD_URL',
  'PLUGIN_WIZARD_URL_PROD',
  'PLUGIN_WIZARD_URL_DEV',
  'APPBUILDER_LOCAL_DEV',
] as const;

function clearWizardEnv(): void {
  for (const name of WIZARD_ENV_VARS) {
    vi.stubEnv(name, undefined);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveWizardBase defaults', () => {
  it('falls back to the deployed dev service', () => {
    clearWizardEnv();

    expect(resolveWizardBase('dev')).toBe('https://plugin-wizard.kizen.dev');
    expect(resolveWizardBase('dev')).toBe(ENCRYPTION_API_DEFAULTS.dev);
  });

  it('falls back to the deployed prod service', () => {
    clearWizardEnv();

    expect(resolveWizardBase('prod')).toBe('https://plugin-wizard.kizen.com');
    expect(resolveWizardBase('prod')).toBe(ENCRYPTION_API_DEFAULTS.prod);
  });
});

describe('resolveWizardBase PLUGIN_WIZARD_URL override', () => {
  it('forces the same host for both targets', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL', 'https://forced.example.com');

    expect(resolveWizardBase('dev')).toBe('https://forced.example.com');
    expect(resolveWizardBase('prod')).toBe('https://forced.example.com');
  });

  it('outranks the per-target vars and APPBUILDER_LOCAL_DEV', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL', 'https://forced.example.com');
    vi.stubEnv('PLUGIN_WIZARD_URL_DEV', 'https://dev.example.com');
    vi.stubEnv('PLUGIN_WIZARD_URL_PROD', 'https://prod.example.com');
    vi.stubEnv('APPBUILDER_LOCAL_DEV', '1');

    expect(resolveWizardBase('dev')).toBe('https://forced.example.com');
    expect(resolveWizardBase('prod')).toBe('https://forced.example.com');
  });

  it('is ignored when set to an empty string', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL', '');

    expect(resolveWizardBase('dev')).toBe(ENCRYPTION_API_DEFAULTS.dev);
    expect(resolveWizardBase('prod')).toBe(ENCRYPTION_API_DEFAULTS.prod);
  });

  it('is ignored when empty, letting the next level win', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL', '');
    vi.stubEnv('PLUGIN_WIZARD_URL_DEV', 'https://dev.example.com');
    vi.stubEnv('PLUGIN_WIZARD_URL_PROD', 'https://prod.example.com');

    expect(resolveWizardBase('dev')).toBe('https://dev.example.com');
    expect(resolveWizardBase('prod')).toBe('https://prod.example.com');
  });
});

describe('resolveWizardBase per-target overrides', () => {
  it('uses PLUGIN_WIZARD_URL_DEV for the dev target only', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL_DEV', 'https://dev.example.com');

    expect(resolveWizardBase('dev')).toBe('https://dev.example.com');
    expect(resolveWizardBase('prod')).toBe(ENCRYPTION_API_DEFAULTS.prod);
  });

  it('uses PLUGIN_WIZARD_URL_PROD for the prod target only', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL_PROD', 'https://prod.example.com');

    expect(resolveWizardBase('prod')).toBe('https://prod.example.com');
    expect(resolveWizardBase('dev')).toBe(ENCRYPTION_API_DEFAULTS.dev);
  });

  it('falls back to the default when PLUGIN_WIZARD_URL_PROD is an empty string', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL_PROD', '');

    expect(resolveWizardBase('prod')).toBe(ENCRYPTION_API_DEFAULTS.prod);
  });

  it('falls back to the default when PLUGIN_WIZARD_URL_DEV is an empty string', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL_DEV', '');

    expect(resolveWizardBase('dev')).toBe(ENCRYPTION_API_DEFAULTS.dev);
  });

  it('outranks APPBUILDER_LOCAL_DEV on the dev target', () => {
    clearWizardEnv();

    vi.stubEnv('PLUGIN_WIZARD_URL_DEV', 'https://dev.example.com');
    vi.stubEnv('APPBUILDER_LOCAL_DEV', '1');

    expect(resolveWizardBase('dev')).toBe('https://dev.example.com');
  });
});

describe('resolveWizardBase APPBUILDER_LOCAL_DEV', () => {
  it('points the dev target at the local plugin-wizard for any non-empty value', () => {
    for (const value of ['1', 'true', 'false', '0', 'anything']) {
      clearWizardEnv();

      vi.stubEnv('APPBUILDER_LOCAL_DEV', value);

      expect(resolveWizardBase('dev')).toBe('http://localhost:9823');
      expect(resolveWizardBase('dev')).toBe(ENCRYPTION_API_DEFAULTS.localDev);
    }
  });

  it('is ignored when set to an empty string', () => {
    clearWizardEnv();

    vi.stubEnv('APPBUILDER_LOCAL_DEV', '');

    expect(resolveWizardBase('dev')).toBe(ENCRYPTION_API_DEFAULTS.dev);
  });

  it('never affects the prod target', () => {
    clearWizardEnv();

    vi.stubEnv('APPBUILDER_LOCAL_DEV', '1');

    expect(resolveWizardBase('prod')).toBe(ENCRYPTION_API_DEFAULTS.prod);
  });
});
