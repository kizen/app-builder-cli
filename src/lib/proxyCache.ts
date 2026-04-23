export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// Headers we refuse to pass through from upstream to the browser.
//   - set-cookie: would set Kizen cookies on the localhost origin.
//   - access-control-*: would let upstream relax CORS on our responses.
//   - strict-transport-security: shouldn't govern localhost.
//   - content-security-policy(-report-only), x-frame-options: upstream policy
//     doesn't apply to the local viewer and can conflict with our own CSP.
// content-encoding / content-length are dropped because fetch auto-decompresses
// the body; the original sizes/encoding no longer match what we forward.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'strict-transport-security',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-encoding',
  'content-length',
]);

export function sanitizeUpstreamHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();

    if (STRIPPED_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-')) {
      continue;
    }

    filtered[key] = value;
  }

  return filtered;
}

export const MAX_PROXY_BYTES = 10 * 1024 * 1024;

// 60s TTL keeps dev-session queries de-duplicated without masking server-side
// changes for long. 200 entries caps worst-case memory at ~2GB if every entry
// were maxed out, which it won't be — typical Kizen JSON responses are <100KB.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

export class ProxyResponseTooLargeError extends Error {
  readonly bytesRead: number;
  readonly limit: number;

  constructor(bytesRead: number, limit: number) {
    super(`Upstream response exceeded ${String(limit)} bytes (read ${String(bytesRead)}).`);
    this.name = 'ProxyResponseTooLargeError';
    this.bytesRead = bytesRead;
    this.limit = limit;
  }
}

export async function readBodyWithLimit(response: Response, limit: number): Promise<Buffer> {
  const body = response.body;

  if (body === null) {
    return Buffer.alloc(0);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    total += chunk.length;

    if (total > limit) {
      throw new ProxyResponseTooLargeError(total, limit);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export interface ProxyCache {
  get(
    key: string,
    fetcher: () => Promise<Response>,
  ): Promise<{ response: CachedResponse; fromCache: boolean }>;
  clear(): void;
}

export interface ProxyCacheOptions {
  onChange?: (size: number) => void;
}

interface CacheEntry {
  insertedAt: number;
  promise: Promise<CachedResponse>;
}

export function createProxyCache(options: ProxyCacheOptions = {}): ProxyCache {
  const cache = new Map<string, CacheEntry>();
  const { onChange } = options;
  const emitChange = (): void => {
    onChange?.(cache.size);
  };

  const evict = (key: string): void => {
    if (cache.delete(key)) {
      emitChange();
    }
  };

  return {
    get(
      key: string,
      fetcher: () => Promise<Response>,
    ): Promise<{ response: CachedResponse; fromCache: boolean }> {
      const existing = cache.get(key);

      if (existing !== undefined) {
        if (Date.now() - existing.insertedAt < CACHE_TTL_MS) {
          return existing.promise.then((response) => ({ response, fromCache: true }));
        }

        // Stale — drop and refetch.
        evict(key);
      }

      // Map iteration order is insertion order, so the first key is the oldest.
      // Evicting before insert keeps size strictly ≤ CACHE_MAX_ENTRIES.
      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;

        if (oldest !== undefined) {
          evict(oldest);
        }
      }

      const pending = fetcher()
        .then(async (response): Promise<CachedResponse> => {
          const headers = sanitizeUpstreamHeaders(Object.fromEntries(response.headers));
          const body = await readBodyWithLimit(response, MAX_PROXY_BYTES);

          return { status: response.status, headers, body };
        })
        .catch((error: unknown) => {
          evict(key);
          throw error;
        });

      cache.set(key, { insertedAt: Date.now(), promise: pending });

      emitChange();

      return pending.then((response) => {
        // Only 2xx responses stay cached; everything else is served once and
        // evicted so the next request re-fetches.
        if (response.status < 200 || response.status >= 300) {
          evict(key);
        }

        return { response, fromCache: false };
      });
    },

    clear(): void {
      cache.clear();

      emitChange();
    },
  };
}
