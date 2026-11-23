import { describe, expect, it } from 'vitest';
import { apiNameFromPath, bundleApiNames, isAppPath } from './lastPath.js';

describe('apiNameFromPath', () => {
  it('returns the first segment of an app route', () => {
    expect(apiNameFromPath('/demo_app/sandbox')).toBe('demo_app');
    expect(apiNameFromPath('/demo_app/code-steps/run_report')).toBe('demo_app');
  });

  it('returns undefined for paths that are not app routes', () => {
    expect(apiNameFromPath('/')).toBeUndefined();
    expect(apiNameFromPath('')).toBeUndefined();
    expect(apiNameFromPath('/demo_app')).toBeUndefined();
    expect(apiNameFromPath('/demo_app/')).toBeUndefined();
  });
});

describe('bundleApiNames', () => {
  it('collects every string api_name in a bundle array', () => {
    expect(bundleApiNames([{ api_name: 'first' }, { api_name: 'second' }])).toEqual([
      'first',
      'second',
    ]);
  });

  it('skips entries without a string api_name', () => {
    expect(bundleApiNames([{ api_name: 'kept' }, { api_name: 7 }, {}, null, 'loose'])).toEqual([
      'kept',
    ]);
  });

  it('treats a non-array bundle as having no apps', () => {
    expect(bundleApiNames({})).toEqual([]);
    expect(bundleApiNames(null)).toEqual([]);
    expect(bundleApiNames(undefined)).toEqual([]);
    expect(bundleApiNames({ api_name: 'not_in_an_array' })).toEqual([]);
  });
});

describe('isAppPath', () => {
  const apiNames = ['app', 'demo_app'];

  it('accepts a tab route of a bundle app', () => {
    expect(isAppPath('/app/sandbox', apiNames)).toBe(true);
    expect(isAppPath('/demo_app/summary', apiNames)).toBe(true);
  });

  it('accepts a nested route of a bundle app', () => {
    expect(isAppPath('/app/code-steps/run_report', apiNames)).toBe(true);
  });

  it('rejects a route whose first segment is not a bundle app', () => {
    expect(isAppPath('/embed/sandbox', apiNames)).toBe(false);
    expect(isAppPath('/embed/ai-chat', apiNames)).toBe(false);
  });

  it('accepts the same route once its first segment is in the bundle', () => {
    expect(isAppPath('/embed/sandbox', [...apiNames, 'embed'])).toBe(true);
  });

  it('is not fooled by an api name that is a prefix of the segment', () => {
    expect(isAppPath('/application/sandbox', apiNames)).toBe(false);
    expect(isAppPath('/app_extra/sandbox', apiNames)).toBe(false);
  });

  it('rejects the root, the empty string, and a bare app segment', () => {
    expect(isAppPath('/', apiNames)).toBe(false);
    expect(isAppPath('', apiNames)).toBe(false);
    // No viewer route is `/$apiName` on its own, so it is never restorable.
    expect(isAppPath('/app', apiNames)).toBe(false);
    expect(isAppPath('/app/', apiNames)).toBe(false);
  });

  it('rejects every path when the bundle has no apps', () => {
    expect(isAppPath('/app/sandbox', [])).toBe(false);
  });

  // Chrome opens `${baseUrl}${path}`, and URL parsing normalizes the path. A
  // path is only accepted when that normalization leaves it unchanged, so the
  // page that opens is the page that was checked.
  it.each([
    '/demo_app/../embed/sandbox',
    '/demo_app/%2e%2e/embed/sandbox',
    '/demo_app/%2E%2E/embed/sandbox',
    '/demo_app/./sandbox',
    '/demo_app/sandbox?x=1',
    '/demo_app/sandbox#h',
    '//demo_app/sandbox',
    '/demo_app\\..\\embed\\sandbox',
  ])('rejects the noncanonical path %o even though its first segment is a bundle app', (path) => {
    expect(isAppPath(path, apiNames)).toBe(false);
  });

  it('still accepts canonical app paths', () => {
    expect(isAppPath('/demo_app/sandbox', apiNames)).toBe(true);
    expect(isAppPath('/demo_app/code-steps/run_report', apiNames)).toBe(true);
  });

  it('accepts an already-encoded segment, which URL parsing leaves as is', () => {
    expect(isAppPath('/demo_app/code-steps/a%20b', apiNames)).toBe(true);
  });

  it('rejects a segment URL parsing would percent-encode', () => {
    expect(isAppPath('/demo_app/code-steps/a b', apiNames)).toBe(false);
  });

  it('rejects input URL parsing cannot handle instead of throwing', () => {
    expect(() => isAppPath('//[', apiNames)).not.toThrow();
    expect(isAppPath('//[', apiNames)).toBe(false);
  });
});
