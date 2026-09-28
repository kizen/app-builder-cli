import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from './credentials.js';
import { APP_URLS, BASE_URLS, isProductionEnvironment } from './kizenUrls.js';

describe('kizenUrls', () => {
  it('defines a base and app url for every environment', () => {
    for (const env of ENVIRONMENTS) {
      expect(BASE_URLS[env]).toMatch(/^https:\/\/.+\/api$/);
      expect(APP_URLS[env]).toMatch(/^https:\/\//);
    }
  });

  it('treats only go and fmo as production', () => {
    expect(ENVIRONMENTS.filter((env) => isProductionEnvironment(env))).toEqual(['go', 'fmo']);
  });
});
