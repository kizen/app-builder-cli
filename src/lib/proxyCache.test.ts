import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProxyCache,
  MAX_PROXY_BYTES,
  ProxyResponseTooLargeError,
  readBodyWithLimit,
  sanitizeUpstreamHeaders,
} from './proxyCache.js';

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' }, ...init });
}

describe('sanitizeUpstreamHeaders', () => {
  it('passes through ordinary headers untouched', () => {
    expect(
      sanitizeUpstreamHeaders({ 'content-type': 'application/json', etag: 'W/"abc"' }),
    ).toEqual({ 'content-type': 'application/json', etag: 'W/"abc"' });
  });

  it('strips headers that must not reach the local viewer', () => {
    const filtered = sanitizeUpstreamHeaders({
      'set-cookie': 'session=1',
      'strict-transport-security': 'max-age=31536000',
      'content-security-policy': "default-src 'none'",
      'content-security-policy-report-only': "default-src 'none'",
      'x-frame-options': 'DENY',
      'content-encoding': 'gzip',
      'content-length': '1234',
      'content-type': 'application/json',
    });

    expect(filtered).toEqual({ 'content-type': 'application/json' });
  });

  it('strips every access-control-* header', () => {
    const filtered = sanitizeUpstreamHeaders({
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'x-thing',
      'x-request-id': 'abc',
    });

    expect(filtered).toEqual({ 'x-request-id': 'abc' });
  });

  it('matches stripped names case-insensitively', () => {
    expect(
      sanitizeUpstreamHeaders({
        'Set-Cookie': 'session=1',
        'X-Frame-Options': 'DENY',
        'Access-Control-Allow-Origin': '*',
      }),
    ).toEqual({});
  });

  it('preserves the original casing of headers it keeps', () => {
    expect(sanitizeUpstreamHeaders({ 'X-Request-Id': 'abc' })).toEqual({ 'X-Request-Id': 'abc' });
  });

  it('does not mutate its input', () => {
    const input = { 'set-cookie': 'session=1', 'content-type': 'application/json' };

    sanitizeUpstreamHeaders(input);

    expect(Object.keys(input)).toHaveLength(2);
  });

  it('handles an empty header set', () => {
    expect(sanitizeUpstreamHeaders({})).toEqual({});
  });
});

describe('readBodyWithLimit', () => {
  it('caps the proxy at 10 MiB', () => {
    expect(MAX_PROXY_BYTES).toBe(10 * 1024 * 1024);
  });

  it('returns an empty buffer for a body-less response', async () => {
    const body = await readBodyWithLimit(new Response(null, { status: 204 }), MAX_PROXY_BYTES);

    expect(body).toHaveLength(0);
  });

  it('reads a body that fits within the limit', async () => {
    const body = await readBodyWithLimit(jsonResponse('hello world'), MAX_PROXY_BYTES);

    expect(body.toString('utf-8')).toBe('hello world');
  });

  it('accepts a body exactly at the limit', async () => {
    const payload = 'x'.repeat(64);

    const body = await readBodyWithLimit(jsonResponse(payload), 64);

    expect(body.toString('utf-8')).toBe(payload);
  });

  it('throws ProxyResponseTooLargeError past the limit', async () => {
    const error = await readBodyWithLimit(jsonResponse('x'.repeat(100)), 10).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ProxyResponseTooLargeError);
    expect((error as ProxyResponseTooLargeError).limit).toBe(10);
    expect((error as ProxyResponseTooLargeError).bytesRead).toBeGreaterThan(10);
    expect((error as Error).name).toBe('ProxyResponseTooLargeError');
    expect((error as Error).message).toContain('10');
  });

  it('preserves binary payloads byte for byte', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    const body = await readBodyWithLimit(new Response(bytes), MAX_PROXY_BYTES);

    expect([...body]).toEqual([...bytes]);
  });
});

describe('createProxyCache', () => {
  it('misses on the first request and hits on the second', async () => {
    const cache = createProxyCache();
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse('payload')));

    const first = await cache.get('key', fetcher);

    expect(first.fromCache).toBe(false);
    expect(first.response.body.toString('utf-8')).toBe('payload');

    const second = await cache.get('key', fetcher);

    expect(second.fromCache).toBe(true);
    expect(second.response.body.toString('utf-8')).toBe('payload');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keys entries independently', async () => {
    const cache = createProxyCache();
    const fetcher = vi.fn((key: string) => Promise.resolve(jsonResponse(key)));

    const a = await cache.get('a', () => fetcher('a'));
    const b = await cache.get('b', () => fetcher('b'));

    expect(a.response.body.toString('utf-8')).toBe('a');
    expect(b.response.body.toString('utf-8')).toBe('b');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent requests for the same key', async () => {
    const cache = createProxyCache();
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse('payload')));

    const [first, second] = await Promise.all([
      cache.get('key', fetcher),
      cache.get('key', fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.response.body.toString('utf-8')).toBe('payload');
    expect(second.fromCache).toBe(true);
  });

  it('sanitizes upstream headers before caching', async () => {
    const cache = createProxyCache();

    const { response } = await cache.get('key', () =>
      Promise.resolve(
        jsonResponse('payload', {
          headers: { 'set-cookie': 'session=1', 'x-request-id': 'abc' },
        }),
      ),
    );

    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-request-id']).toBe('abc');
  });

  it('preserves the upstream status code', async () => {
    const cache = createProxyCache();

    const { response } = await cache.get('key', () =>
      Promise.resolve(jsonResponse('created', { status: 201 })),
    );

    expect(response.status).toBe(201);
  });

  it('clear() drops cached entries so the next request refetches', async () => {
    const cache = createProxyCache();
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse('payload')));

    await cache.get('key', fetcher);

    cache.clear();

    const after = await cache.get('key', fetcher);

    expect(after.fromCache).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports cache size changes through onChange', async () => {
    const onChange = vi.fn<(size: number) => void>();
    const cache = createProxyCache({ onChange });

    await cache.get('a', () => Promise.resolve(jsonResponse('a')));
    await cache.get('b', () => Promise.resolve(jsonResponse('b')));

    expect(onChange.mock.calls.map(([size]) => size)).toEqual([1, 2]);

    cache.clear();

    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('does not keep non-2xx responses', async () => {
    const cache = createProxyCache();
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse('nope', { status: 404 })));

    const first = await cache.get('key', fetcher);

    expect(first.response.status).toBe(404);

    const second = await cache.get('key', fetcher);

    expect(second.fromCache).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not keep 5xx responses', async () => {
    const cache = createProxyCache();
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse('boom', { status: 503 })));

    await cache.get('key', fetcher);
    await cache.get('key', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('evicts a failed fetch so the next request retries', async () => {
    const cache = createProxyCache();
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse('recovered'));

    await expect(cache.get('key', fetcher)).rejects.toThrow('network down');

    const retry = await cache.get('key', fetcher);

    expect(retry.response.body.toString('utf-8')).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('propagates an oversized-response error without caching it', async () => {
    const cache = createProxyCache();
    const oversized = new Response(new Uint8Array(MAX_PROXY_BYTES + 1024));
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(jsonResponse('small'));

    await expect(cache.get('key', fetcher)).rejects.toBeInstanceOf(ProxyResponseTooLargeError);

    const retry = await cache.get('key', fetcher);

    expect(retry.response.body.toString('utf-8')).toBe('small');
  });
});

describe('createProxyCache with caching disabled', () => {
  it('always fetches and never reports a cache hit', async () => {
    const cache = createProxyCache({ enabled: false });
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse('payload')));

    const first = await cache.get('key', fetcher);
    const second = await cache.get('key', fetcher);

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(false);
    expect(second.response.body.toString('utf-8')).toBe('payload');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('still sanitizes headers on the pass-through path', async () => {
    const cache = createProxyCache({ enabled: false });

    const { response } = await cache.get('key', () =>
      Promise.resolve(jsonResponse('payload', { headers: { 'set-cookie': 'session=1' } })),
    );

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('has a no-op clear() and never emits size changes', async () => {
    const onChange = vi.fn<(size: number) => void>();
    const cache = createProxyCache({ enabled: false, onChange });

    await cache.get('key', () => Promise.resolve(jsonResponse('payload')));

    expect(() => {
      cache.clear();
    }).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('createProxyCache expiry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves from cache until the TTL elapses, then refetches', async () => {
    vi.useFakeTimers();

    const cache = createProxyCache();
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse('payload')));

    await cache.get('key', fetcher);

    vi.advanceTimersByTime(59_000);

    expect((await cache.get('key', fetcher)).fromCache).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);

    expect((await cache.get('key', fetcher)).fromCache).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports the size drop when a stale entry is evicted', async () => {
    vi.useFakeTimers();

    const onChange = vi.fn<(size: number) => void>();
    const cache = createProxyCache({ onChange });
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse('payload')));

    await cache.get('key', fetcher);

    vi.advanceTimersByTime(61_000);

    await cache.get('key', fetcher);

    // insert → 1, stale eviction → 0, re-insert → 1
    expect(onChange.mock.calls.map(([size]) => size)).toEqual([1, 0, 1]);
  });
});
