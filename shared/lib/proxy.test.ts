import { describe, expect, it } from 'vitest';
import { proxyLogEntryToString } from './proxy.js';
import type { ProxyLogEntry } from './proxy.js';

function request(
  overrides: Partial<Extract<ProxyLogEntry, { kind: 'request' }>> = {},
): ProxyLogEntry {
  return {
    kind: 'request',
    method: 'GET',
    status: 200,
    fromCache: false,
    url: '/api/things',
    ...overrides,
  };
}

describe('proxyLogEntryToString', () => {
  it('returns an info entry message verbatim', () => {
    expect(proxyLogEntryToString({ kind: 'info', message: 'Proxy cache cleared' })).toBe(
      'Proxy cache cleared',
    );
  });

  it('returns an empty info message unchanged', () => {
    expect(proxyLogEntryToString({ kind: 'info', message: '' })).toBe('');
  });

  it('formats a plain request as method, url and status', () => {
    expect(proxyLogEntryToString(request())).toBe('GET /api/things → 200');
  });

  it('marks cache hits', () => {
    expect(proxyLogEntryToString(request({ fromCache: true }))).toBe(
      'GET /api/things → 200 [cache]',
    );
  });

  it('appends the upstream status when present', () => {
    expect(proxyLogEntryToString(request({ status: 200, upstreamStatus: 404 }))).toBe(
      'GET /api/things → 200 (upstream 404)',
    );
  });

  it('omits the upstream status when undefined', () => {
    expect(proxyLogEntryToString(request({ upstreamStatus: undefined }))).not.toContain('upstream');
  });

  it('includes an upstream status of 0', () => {
    expect(proxyLogEntryToString(request({ upstreamStatus: 0 }))).toContain('(upstream 0)');
  });

  it('orders the upstream status before the cache marker', () => {
    expect(
      proxyLogEntryToString(
        request({ method: 'POST', status: 200, upstreamStatus: 500, fromCache: true }),
      ),
    ).toBe('POST /api/things → 200 (upstream 500) [cache]');
  });

  it('preserves the method and full url as given', () => {
    expect(
      proxyLogEntryToString(
        request({ method: 'DELETE', url: 'https://go.kizen.com/api/x?y=1&z=2', status: 204 }),
      ),
    ).toBe('DELETE https://go.kizen.com/api/x?y=1&z=2 → 204');
  });
});
