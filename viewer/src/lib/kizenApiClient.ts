import type { JSONObject } from '@kizenapps/engine';

type RequestFn = (
  path: string,
  init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
) => Promise<Response>;

export interface RequestConfig {
  headers?: Record<string, string>;
}

export type KizenApiMethod = 'get' | 'delete' | 'head' | 'post' | 'put' | 'patch';

const BODYLESS_METHODS: ReadonlySet<KizenApiMethod> = new Set(['get', 'delete', 'head']);

/**
 * Axios-shaped client over `fetch`. Mirrors the engine's internal API so that
 * plugin code calling `ctx.get(url, options)` / `ctx.post(url, body, options)`
 * reaches the right slots without per-method branching at the callsite.
 *
 * Use the named methods directly, or `.request(method, url, payload, options)`
 * to forward uniformly — the latter matches the engine's `onNetworkRequest`
 * shape, where GET/DELETE pass options in the `payload` slot.
 */
export interface KizenApiClient {
  get(url: string, config?: RequestConfig): Promise<JSONObject>;
  delete(url: string, config?: RequestConfig): Promise<JSONObject>;
  head(url: string, config?: RequestConfig): Promise<JSONObject>;
  post(url: string, body?: unknown, config?: RequestConfig): Promise<JSONObject>;
  put(url: string, body?: unknown, config?: RequestConfig): Promise<JSONObject>;
  patch(url: string, body?: unknown, config?: RequestConfig): Promise<JSONObject>;
  request(method: string, url: string, payload?: unknown, options?: unknown): Promise<JSONObject>;
}

const send = async (
  request: RequestFn,
  method: string,
  url: string,
  body: unknown,
  config: RequestConfig | undefined,
): Promise<JSONObject> => {
  const hasBody = body !== undefined && body !== null;
  const isRawBody = body instanceof FormData || body instanceof Blob;
  const headers =
    hasBody && !isRawBody
      ? { 'Content-Type': 'application/json', ...config?.headers }
      : config?.headers;
  const res = await request(url, {
    method,
    ...(hasBody && {
      body: isRawBody ? body : JSON.stringify(body),
    }),
    ...(headers && { headers }),
  });

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return {};
  }

  return (await res.json()) as JSONObject;
};

export function createKizenApiClient(request: RequestFn): KizenApiClient {
  return {
    get: (url, config) => send(request, 'GET', url, undefined, config),
    delete: (url, config) => send(request, 'DELETE', url, undefined, config),
    head: (url, config) => send(request, 'HEAD', url, undefined, config),
    post: (url, body, config) => send(request, 'POST', url, body, config),
    put: (url, body, config) => send(request, 'PUT', url, body, config),
    patch: (url, body, config) => send(request, 'PATCH', url, body, config),
    request: (method, url, payload, options) => {
      const lower = method.toLowerCase() as KizenApiMethod;
      // For bodyless methods, the engine passes the config in the payload slot.
      const config = (BODYLESS_METHODS.has(lower) ? payload : options) as RequestConfig | undefined;
      const body = BODYLESS_METHODS.has(lower) ? undefined : payload;

      return send(request, method.toUpperCase(), url, body, config);
    },
  };
}
