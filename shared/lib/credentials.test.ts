import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from './credentials.js';
import type { Credentials } from './credentials.js';

describe('ENVIRONMENTS', () => {
  it('lists every Kizen environment the CLI can talk to', () => {
    expect(ENVIRONMENTS).toEqual(['go', 'fmo', 'staging', 'integration', 'test1']);
  });

  // src/lib/credentials.ts falls back to 'go' for an unknown environment, so the
  // first entry and that fallback have to stay the same value.
  it('starts with go, the parse fallback', () => {
    expect(ENVIRONMENTS[0]).toBe('go');
  });

  it('has no duplicates', () => {
    expect(new Set(ENVIRONMENTS).size).toBe(ENVIRONMENTS.length);
  });

  it('uses lowercase, url-safe names', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe('Credentials shape', () => {
  it('accepts a fully populated credential object', () => {
    const credentials: Credentials = {
      apiKey: 'key',
      userId: 'user',
      businessId: 'biz',
      environment: 'staging',
    };

    expect(Object.keys(credentials).sort()).toEqual([
      'apiKey',
      'businessId',
      'environment',
      'userId',
    ]);
  });
});
