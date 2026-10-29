import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '../../shared/lib/credentials.js';
import {
  createKizenClient,
  dashletPath,
  formatDrfError,
  KizenApiError,
  type KizenClientAuth,
  type KizenSessionClient,
} from './kizenClient.js';
import type { KizenClient } from './kizenTypes.js';
import { OAuthError } from './oauth.js';
import type { BearerTokenProvider } from './oauthSession.js';
import type * as ProxyEnvModule from './proxyEnv.js';
import type { ProxyEnvStatus } from './proxyEnv.js';
import { PROXY_UNAVAILABLE_HINT } from './proxyEnv.js';
import { jsonResponse, rejectionOf } from '../test/oauth.js';

const proxyState = vi.hoisted(() => ({ status: 'not-configured' as ProxyEnvStatus }));

vi.mock('./proxyEnv.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxyEnvModule>()),
  getProxyEnvStatus: () => proxyState.status,
}));

afterEach(() => {
  proxyState.status = 'not-configured';
});

const CREDENTIALS: Credentials = {
  apiKey: 'key-123',
  userId: 'user-123',
  businessId: 'biz-123',
  environment: 'integration',
};

const BASE = 'https://integration.kizen.dev/api';

interface Setup {
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  client: KizenSessionClient;
  call: (index: number) => { url: string; init: RequestInit };
}

const API_KEY = { credentials: CREDENTIALS };

/** A client with `auth` (and any baseUrl) whose fetch answers with `responses` in order. */
const setup = (auth: KizenClientAuth & { baseUrl?: string }, ...responses: Response[]): Setup => {
  const fetchMock = vi.fn<typeof fetch>();

  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }

  const client = createKizenClient({ ...auth, fetch: fetchMock });

  const call = (index: number): { url: string; init: RequestInit } => {
    const args = fetchMock.mock.calls[index];

    if (!args) {
      throw new Error(`fetch was not called ${String(index + 1)} times`);
    }

    return { url: args[0] as string, init: args[1] ?? {} };
  };

  return { fetchMock, client, call };
};

const rejection = (promise: Promise<unknown>): Promise<KizenApiError> =>
  rejectionOf(promise, KizenApiError);

const AUTH_HEADERS = {
  'X-API-KEY': 'key-123',
  'X-USER-ID': 'user-123',
  'X-BUSINESS-ID': 'biz-123',
  Accept: 'application/json',
};

describe('createKizenClient requests', () => {
  const DASHBOARD = { id: 'a/b', name: 'D', type: 'homepage', custom_object: null, dashlets: [] };
  const CUSTOM_OBJECT = { id: 'o/1', object_name: 'deals', fetch_url: 'pipeline', extra: true };

  it.each([
    [
      'lists dashboards of a type',
      (client: KizenClient) => client.listDashboards('generic_dashboard'),
      { results: [{ id: 'd1', name: 'Main' }] },
      [{ id: 'd1', name: 'Main' }],
      `${BASE}/dashboards/mine?size=10000&include_sharing=true&dashboard_type=generic_dashboard`,
    ],
    [
      'gets a custom object by encoded id',
      (client: KizenClient) => client.getCustomObject('o/1'),
      CUSTOM_OBJECT,
      CUSTOM_OBJECT,
      `${BASE}/custom-objects/o%2F1`,
    ],
    [
      'reads the client object id from bootstrap',
      (client: KizenClient) => client.getClientObjectId(),
      { business: { id: 'biz-123', client_object: { id: 'contacts-1' } } },
      'contacts-1',
      `${BASE}/auth/bootstrap`,
    ],
    [
      'gets a dashboard by encoded id',
      (client: KizenClient) => client.getDashboard('a/b'),
      DASHBOARD,
      DASHBOARD,
      `${BASE}/dashboards/a%2Fb`,
    ],
  ] as const)(
    '%s with a bodiless authenticated GET',
    async (_name, invoke, body, expected, url) => {
      const { client, call } = setup(API_KEY, jsonResponse(body));

      await expect(invoke(client)).resolves.toEqual(expected);

      const { url: calledUrl, init } = call(0);

      expect(calledUrl).toBe(url);
      expect(init.method).toBe('GET');
      expect(init.headers).toEqual(AUTH_HEADERS);
      expect(init.body).toBeUndefined();
    },
  );

  it('adds an encoded custom_object_id when given and tolerates a bare array', async () => {
    const { client, call } = setup(API_KEY, jsonResponse([{ id: 'd2', name: 'Group' }]));

    await expect(client.listDashboards('chart_group', 'obj 1&x')).resolves.toEqual([
      { id: 'd2', name: 'Group' },
    ]);
    expect(call(0).url).toBe(
      `${BASE}/dashboards/mine?size=10000&include_sharing=true&dashboard_type=chart_group&custom_object_id=obj+1%26x`,
    );
  });

  it('follows next links when listing custom objects', async () => {
    const next = `${BASE}/custom-objects?page=2&page_size=200`;
    const first = { id: 'o1', object_name: 'contacts', fetch_url: 'client' };
    const second = { id: 'o2', object_name: 'deals', fetch_url: 'deals' };
    const { client, call, fetchMock } = setup(
      API_KEY,
      jsonResponse({ count: 2, next, results: [first] }),
      jsonResponse({ count: 2, next: null, results: [second] }),
    );

    await expect(client.listCustomObjects()).resolves.toEqual([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(0).url).toBe(`${BASE}/custom-objects?page_size=200`);
    expect(call(1).url).toBe(next);
    expect(call(1).init.headers).toEqual(AUTH_HEADERS);
  });

  it('lists every object, Contacts included, only when asked (custom_only=false)', async () => {
    const { client, call } = setup(
      API_KEY,
      jsonResponse({ next: null, results: [] }),
      jsonResponse({ next: null, results: [] }),
      jsonResponse({ next: null, results: [] }),
    );

    await client.listCustomObjects({ customOnly: false });
    await client.listCustomObjects();
    await client.listCustomObjects({ customOnly: true });

    expect(call(0).url).toBe(`${BASE}/custom-objects?page_size=200&custom_only=false`);
    // Existing callers are unchanged: the server's default (custom objects only).
    expect(call(1).url).toBe(`${BASE}/custom-objects?page_size=200`);
    expect(call(2).url).toBe(`${BASE}/custom-objects?page_size=200`);
  });

  it.each([
    [
      'a same-host http next over the base scheme',
      'http://integration.kizen.dev/api/custom-objects?page=2',
    ],
    ['a relative next against the base origin', '/api/custom-objects?page=2'],
  ])('resolves %s', async (_name, next) => {
    const { client, call, fetchMock } = setup(
      API_KEY,
      jsonResponse({ next, results: [{ id: 'o1' }] }),
      jsonResponse({ next: null, results: [{ id: 'o2' }] }),
    );

    await expect(client.listCustomObjects()).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).url).toBe(`${BASE}/custom-objects?page=2`);
  });

  it('refuses to follow a next on a foreign host', async () => {
    const { client, fetchMock } = setup(
      API_KEY,
      jsonResponse({ next: 'https://evil.example.com/steal?page=2', results: [{ id: 'o1' }] }),
      jsonResponse({ next: null, results: [] }),
    );
    const error = await rejection(client.listCustomObjects());

    expect(error.kind).toBe('api_error');
    expect(error.message).toBe(
      'GET /custom-objects pagination pointed at an unexpected location https://evil.example.com/steal',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => (url as string).includes('evil.example.com'))).toBe(
      false,
    );
  });

  it('follows a same-origin next whose path starts with //', async () => {
    const next = 'https://integration.kizen.dev//evil.example/x';
    const { client, call } = setup(
      API_KEY,
      jsonResponse({ next, results: [{ id: 'o1' }] }),
      jsonResponse({ next: null, results: [] }),
    );

    await client.listCustomObjects();

    expect(call(1).url).toBe(next);
  });

  it('stops paginating when next repeats', async () => {
    const next = `${BASE}/custom-objects?page=2&page_size=200`;
    const { client, fetchMock } = setup(
      API_KEY,
      jsonResponse({ next, results: [{ id: 'o1' }] }),
      jsonResponse({ next, results: [{ id: 'o2' }] }),
    );

    await expect(client.listCustomObjects()).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([[{ id: 'o1' }], [{ fetch_url: 'client' }], [{ id: 1, fetch_url: 'client' }], [[]]])(
    'rejects a custom object body shaped %j',
    async (body) => {
      const { client } = setup(API_KEY, jsonResponse(body));
      const error = await rejection(client.getCustomObject('o1'));

      expect(error.kind).toBe('api_error');
      expect(error.message).toBe('GET /custom-objects/o1 returned an unexpected response shape');
    },
  );

  it.each([
    [{}],
    [{ business: {} }],
    [{ business: { client_object: null } }],
    [{ business: { client_object: { id: '' } } }],
    [{ business: { client_object: { id: 7 } } }],
  ])('returns null for a bootstrap body shaped %j', async (body) => {
    const { client } = setup(API_KEY, jsonResponse(body));

    await expect(client.getClientObjectId()).resolves.toBeNull();
  });

  it("reuses the identity lookup's /auth/bootstrap for getClientObjectId", async () => {
    const { client, fetchMock } = setup(
      API_KEY,
      jsonResponse({
        team: { user: 'user-123' },
        business: { id: 'biz-123', client_object: { id: 'contacts-1' } },
      }),
    );

    await client.getIdentity();
    await expect(client.getClientObjectId()).resolves.toBe('contacts-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getIdentity does not keep a malformed bootstrap for getClientObjectId', async () => {
    const malformed = { team: { user: 'user-123' }, business: { client_object: { id: 'stale' } } };
    const { client, fetchMock } = setup(
      API_KEY,
      jsonResponse(malformed),
      jsonResponse({ business: { id: 'biz-123', client_object: { id: 'contacts-1' } } }),
    );

    await rejection(client.getIdentity());
    await expect(client.getClientObjectId()).resolves.toBe('contacts-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'posts a new dashlet',
      'POST',
      {
        name: 'Block',
        layout: { i: 'x', x: 0, y: 0, w: 4, h: 4 },
        config: { kind: 'custom_code' },
      },
      `${BASE}/dashboards/d1/dashlet`,
    ],
    [
      'patches an existing dashlet',
      'PATCH',
      { config: { kind: 'custom_code', version: 1 } },
      `${BASE}/dashboards/d1/dashlet/dl1`,
    ],
  ] as const)('%s as JSON', async (_name, method, body, url) => {
    const returned = {
      id: 'dl1',
      name: 'Block',
      layout: 'layout' in body ? body.layout : null,
      config: body.config,
      dashboard: 'd1',
    };
    const { client, call } = setup(API_KEY, jsonResponse(returned, method === 'POST' ? 201 : 200));

    await expect(
      method === 'POST'
        ? client.createDashlet('d1', body as Parameters<KizenClient['createDashlet']>[1])
        : client.updateDashlet('d1', 'dl1', body),
    ).resolves.toEqual(returned);

    const { url: calledUrl, init } = call(0);

    expect(calledUrl).toBe(url);
    expect(init.method).toBe(method);
    expect(init.headers).toEqual({ ...AUTH_HEADERS, 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('dashletPath encodes dashboard and dashlet ids', async () => {
    expect(dashletPath('d1')).toBe('/dashboards/d1/dashlet');
    expect(dashletPath('d1', 'dl1')).toBe('/dashboards/d1/dashlet/dl1');
    expect(dashletPath('a/b c')).toBe('/dashboards/a%2Fb%20c/dashlet');
    expect(dashletPath('a/b c', 'x?y#1')).toBe('/dashboards/a%2Fb%20c/dashlet/x%3Fy%231');

    const { client, call } = setup(API_KEY, jsonResponse({}), jsonResponse({}));

    await client.createDashlet('a/b c', {
      name: 'B',
      layout: { i: 'x', x: 0, y: 0, w: 1, h: 1 },
      config: {},
    });
    await client.updateDashlet('a/b c', 'x?y#1', { config: {} });

    expect(call(0).url).toBe(`${BASE}/dashboards/a%2Fb%20c/dashlet`);
    expect(call(1).url).toBe(`${BASE}/dashboards/a%2Fb%20c/dashlet/x%3Fy%231`);
  });

  it('uses an explicit baseUrl', async () => {
    const { client, call } = setup(
      { ...API_KEY, baseUrl: 'http://localhost:9000/api' },
      jsonResponse({ results: [] }),
    );

    await client.listCustomObjects();

    expect(call(0).url).toBe('http://localhost:9000/api/custom-objects?page_size=200');
  });
});

describe('createKizenClient errors', () => {
  const failingFetch = (error: Error): KizenClient =>
    createKizenClient({
      credentials: CREDENTIALS,
      fetch: vi.fn<typeof fetch>().mockRejectedValueOnce(error),
    });

  const fetchFailed = (code: string): Error =>
    Object.assign(new TypeError('fetch failed'), { cause: { code } });

  it('maps 401 to auth_failed with a credentials hint', async () => {
    const { client } = setup(API_KEY, jsonResponse({ detail: 'Invalid API key.' }, 401));
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('auth_failed');
    expect(error.status).toBe(401);
    expect(error.hint).toContain("Check the credentials file's apiKey, userId and businessId.");
    expect(error.message).toBe('GET /dashboards/d1 failed with 401: Invalid API key.');
  });

  it('does not retry an API-key 401', async () => {
    const { client, fetchMock } = setup(
      API_KEY,
      jsonResponse({ detail: 'Invalid API key.' }, 401),
      jsonResponse({ id: 'd1' }),
    );
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('auth_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps 403 to forbidden with a permissions hint', async () => {
    const { client } = setup(API_KEY, jsonResponse({ detail: 'Nope.' }, 403));
    const error = await rejection(client.updateDashlet('d1', 'dl1', { config: {} }));

    expect(error.kind).toBe('forbidden');
    expect(error.status).toBe(403);
    expect(error.hint).toContain('Standard API Keys permission');
    expect(error.hint).toContain('Customize Homepages permission');
    expect(error.message).toContain('PATCH /dashboards/d1/dashlet/dl1 failed with 403');
  });

  it('maps 404 to not_found', async () => {
    const { client } = setup(API_KEY, jsonResponse({ detail: 'Not found.' }, 404));
    const error = await rejection(client.getDashboard('missing'));

    expect(error.kind).toBe('not_found');
    expect(error.status).toBe(404);
    expect(error.hint).toBeUndefined();
  });

  it('maps other statuses to api_error with the DRF field detail', async () => {
    const { client } = setup(API_KEY, jsonResponse({ config: { content: ['bad'] } }, 400));
    const error = await rejection(
      client.createDashlet('d1', {
        name: 'B',
        layout: { i: 'x', x: 0, y: 0, w: 1, h: 1 },
        config: {},
      }),
    );

    expect(error.kind).toBe('api_error');
    expect(error.status).toBe(400);
    expect(error.message).toBe('POST /dashboards/d1/dashlet failed with 400: config.content: bad');
  });

  it('does not throw a SyntaxError on a non-JSON error body', async () => {
    const { client } = setup(API_KEY, new Response('<html>Bad Gateway</html>', { status: 502 }));
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('api_error');
    expect(error.status).toBe(502);
    expect(error.message).toBe('GET /dashboards/d1 failed with 502');
  });

  it('maps a thrown fetch to network_error naming the base url and cause', async () => {
    const error = await rejection(failingFetch(fetchFailed('ECONNREFUSED')).getDashboard('d1'));

    expect(error.kind).toBe('network_error');
    expect(error.status).toBeUndefined();
    expect(error.message).toBe(`Couldn't reach Kizen at ${BASE}: ECONNREFUSED`);
  });

  it('appends the proxy hint to network_error when a proxy is set but unsupported', async () => {
    proxyState.status = 'unavailable';

    const error = await rejection(failingFetch(fetchFailed('ENOTFOUND')).getDashboard('d1'));

    expect(error.kind).toBe('network_error');
    expect(error.message).toBe(
      `Couldn't reach Kizen at ${BASE}: ENOTFOUND ${PROXY_UNAVAILABLE_HINT}`,
    );
  });

  it.each([['applied'], ['not-configured'], ['already-set']] as const)(
    'leaves the proxy hint off network_error when the proxy status is %s',
    async (status) => {
      proxyState.status = status;

      const error = await rejection(failingFetch(fetchFailed('ENOTFOUND')).getDashboard('d1'));

      expect(error.kind).toBe('network_error');
      expect(error.message).toBe(`Couldn't reach Kizen at ${BASE}: ENOTFOUND`);
    },
  );

  it('leaves the proxy hint off non-network errors even when the proxy is unsupported', async () => {
    proxyState.status = 'unavailable';

    const { client } = setup(API_KEY, jsonResponse({ detail: 'nope' }, 401));
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('auth_failed');
    expect(error.message).not.toContain(PROXY_UNAVAILABLE_HINT);
  });

  it('maps a GET body read failure to network_error with the status', async () => {
    const response = new Response('{}', { status: 201 });

    vi.spyOn(response, 'text').mockRejectedValueOnce(
      Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }),
    );

    const { client } = setup(API_KEY, response);
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('network_error');
    expect(error.status).toBe(201);
    expect(error.message).toBe(
      `GET /dashboards/d1: couldn't read the response: ECONNRESET. The request may have been applied; check Kizen before retrying.`,
    );
  });

  it('uses the error message when the fetch failure has no code', async () => {
    const error = await rejection(failingFetch(new Error('socket hang up')).getDashboard('d1'));

    expect(error.message).toBe(`Couldn't reach Kizen at ${BASE}: socket hang up`);
  });
});

describe('formatDrfError', () => {
  it.each([
    [{ detail: 'x' }, 'x'],
    [{ field: ['a', 'b'], other: 'c' }, 'field: a b; other: c'],
    [{ config: { content: ['bad'] } }, 'config.content: bad'],
    [['a', 'b'], 'a b'],
    [{ non_field_errors: ['Name taken.'] }, 'Name taken.'],
  ] as const)('formats %j', (body, expected) => {
    expect(formatDrfError(body)).toBe(expected);
  });

  it.each([[{}], [[]], [null], [undefined], ['text'], [42]] as const)(
    'returns undefined for %j',
    (body) => {
      expect(formatDrfError(body)).toBeUndefined();
    },
  );
});

describe('bearer auth', () => {
  const STAGING = 'https://staging.kizen.com/api';

  interface FakeTokens extends BearerTokenProvider {
    refreshes: string[];
  }

  /** Hands out tok-1, then tok-2, tok-3… on each refresh. */
  const fakeTokens = (): FakeTokens => {
    let current = 1;
    const refreshes: string[] = [];

    return {
      environment: 'staging',
      refreshes,
      getAccessToken: () => Promise.resolve(`tok-${String(current)}`),
      refreshAccessToken: (rejected) => {
        refreshes.push(rejected);
        current += 1;

        return Promise.resolve(`tok-${String(current)}`);
      },
    };
  };

  it('bearer client sends Authorization and no X-API-KEY/X-USER-ID/X-BUSINESS-ID', async () => {
    const tokens = fakeTokens();
    const { client, call } = setup(
      { bearer: tokens },
      jsonResponse({ id: 'd1' }),
      jsonResponse({ id: 'x1' }),
    );

    await client.getDashboard('d1');
    await client.createDashlet('d1', { name: 'n' } as never);

    // The base URL comes from the provider's environment.
    expect(call(0).url).toBe(`${STAGING}/dashboards/d1`);
    expect(call(0).init.headers).toStrictEqual({
      Authorization: 'Bearer tok-1',
      Accept: 'application/json',
    });
    expect(call(1).init.headers).toStrictEqual({
      Authorization: 'Bearer tok-1',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(tokens.refreshes).toStrictEqual([]);
  });

  it('401 with bearer triggers one refresh and retry; second 401 surfaces the auth error', async () => {
    const recovering = fakeTokens();
    const ok = setup(
      { bearer: recovering },
      jsonResponse({ detail: 'expired' }, 401),
      jsonResponse({ id: 'x1' }),
    );

    await expect(ok.client.createDashlet('d1', { name: 'n' } as never)).resolves.toStrictEqual({
      id: 'x1',
    });
    expect(recovering.refreshes).toStrictEqual(['tok-1']);
    expect(ok.fetchMock).toHaveBeenCalledTimes(2);
    expect(ok.call(1).init.headers).toMatchObject({ Authorization: 'Bearer tok-2' });
    // The retried write carries the same body.
    expect(ok.call(1).init.body).toBe(ok.call(0).init.body);

    const rejected = fakeTokens();
    const denied = setup(
      { bearer: rejected },
      jsonResponse({ detail: 'nope' }, 401),
      jsonResponse({ detail: 'still nope' }, 401),
    );
    const error = await rejection(denied.client.getDashboard('d1'));

    expect(rejected.refreshes).toStrictEqual(['tok-1']);
    expect(denied.fetchMock).toHaveBeenCalledTimes(2);
    expect(error.kind).toBe('auth_failed');
    expect(error.status).toBe(401);
    expect(error.message).toBe('GET /dashboards/d1 failed with 401: still nope');
    expect(error.hint).toContain('appbuilder login --env staging');
  });

  it('does not refresh on a non-401 failure', async () => {
    const tokens = fakeTokens();
    const { client } = setup({ bearer: tokens }, jsonResponse({ detail: 'no' }, 403));
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('forbidden');
    expect(error.hint).not.toContain('API key');
    expect(tokens.refreshes).toStrictEqual([]);
  });

  it('turns a login-required token failure into auth_failed without calling Kizen', async () => {
    const { client, fetchMock } = setup({
      bearer: {
        environment: 'staging',
        getAccessToken: () =>
          Promise.reject(new OAuthError('login_required', 'Run `appbuilder login --env staging`.')),
        refreshAccessToken: () => Promise.reject(new Error('unused')),
      },
    });
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('auth_failed');
    expect(error.message).toContain('appbuilder login --env staging');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the identity from /auth/bootstrap', async () => {
    const { client, call } = setup(
      { bearer: fakeTokens() },
      jsonResponse({
        team: { id: 't1', user: 'u1', full_name: 'Ada L', email: 'ada@example.com' },
        business: { id: 'b1', name: 'Acme' },
      }),
    );

    await expect(client.getIdentity()).resolves.toStrictEqual({
      userId: 'u1',
      businessId: 'b1',
      businessName: 'Acme',
      fullName: 'Ada L',
      email: 'ada@example.com',
    });
    expect(call(0).url).toBe(`${STAGING}/auth/bootstrap`);
  });
});

describe('generic primitives', () => {
  /** Hands out tok-1, then tok-2 after a refresh. */
  const tokens = (): BearerTokenProvider & { refreshes: string[] } => {
    let current = 1;
    const refreshes: string[] = [];

    return {
      environment: 'integration',
      refreshes,
      getAccessToken: () => Promise.resolve(`tok-${String(current)}`),
      refreshAccessToken: (rejected) => {
        refreshes.push(rejected);
        current += 1;

        return Promise.resolve(`tok-${String(current)}`);
      },
    };
  };

  // Not valid UTF-8, so a text/JSON round trip would corrupt it.
  const BINARY = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x7b]);

  it('requestJson sends method, path and JSON body with auth, and resolves 204 to undefined', async () => {
    const { client, call } = setup(
      API_KEY,
      jsonResponse({ ok: true }, 201),
      new Response(null, { status: 204 }),
    );

    await expect(client.requestJson('POST', '/things?x=1', { a: 1 })).resolves.toStrictEqual({
      ok: true,
    });
    expect(call(0).url).toBe(`${BASE}/things?x=1`);
    expect(call(0).init.method).toBe('POST');
    expect(call(0).init.headers).toStrictEqual({
      ...AUTH_HEADERS,
      'Content-Type': 'application/json',
    });
    expect(call(0).init.body).toBe('{"a":1}');

    await expect(client.requestJson('DELETE', '/things/1')).resolves.toBeUndefined();
    expect(call(1).init.method).toBe('DELETE');
    expect(call(1).init.body).toBeUndefined();
  });

  it.each(['https://evil.test/x', '//evil.test/x', 'relative/path'])(
    'refuses a target that is not an API path (%s) without sending credentials',
    async (target) => {
      const { client, fetchMock } = setup(API_KEY);

      await expect(rejection(client.requestJson('GET', target))).resolves.toMatchObject({
        kind: 'api_error',
      });
      await expect(rejection(client.postForm(target, {}))).resolves.toMatchObject({
        kind: 'api_error',
      });
      await expect(rejection(client.getBinary(target))).resolves.toMatchObject({
        kind: 'api_error',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('postForm sends a form-urlencoded body with auth', async () => {
    const { client, call } = setup(API_KEY, jsonResponse({ id: 'f1' }));

    await expect(
      client.postForm('/s3/success?source=public_image', { uuid: 'u 1', key: 'a/b&c' }),
    ).resolves.toStrictEqual({ id: 'f1' });
    expect(call(0).init.headers).toStrictEqual({
      ...AUTH_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(call(0).init.body).toBe('uuid=u+1&key=a%2Fb%26c');
  });

  it('getBinary returns raw bytes without JSON parsing', async () => {
    const { client, call } = setup(API_KEY, new Response(BINARY));
    const bytes = await client.getBinary('/files/f1/download');

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toStrictEqual([...BINARY]);
    expect(call(0).init.headers).toStrictEqual({ ...AUTH_HEADERS, Accept: '*/*' });
  });

  it('getBinary maps a failed response to KizenApiError with its body', async () => {
    const { client } = setup(API_KEY, jsonResponse({ detail: 'Not found.' }, 404));
    const error = await rejection(client.getBinary('/files/f1/download'));

    expect(error.kind).toBe('not_found');
    expect(error.details).toStrictEqual({ detail: 'Not found.' });
  });

  it('binary and form requests retry once after a 401 refresh like JSON requests', async () => {
    const binaryTokens = tokens();
    const binary = setup(
      { bearer: binaryTokens },
      jsonResponse({ detail: 'expired' }, 401),
      new Response(BINARY),
    );

    expect([...(await binary.client.getBinary('/files/f1/download'))]).toStrictEqual([...BINARY]);
    expect(binaryTokens.refreshes).toStrictEqual(['tok-1']);
    expect(binary.call(1).init.headers).toMatchObject({ Authorization: 'Bearer tok-2' });

    const formTokens = tokens();
    const form = setup(
      { bearer: formTokens },
      jsonResponse({ detail: 'expired' }, 401),
      jsonResponse({ id: 'f1' }),
    );

    await expect(form.client.postForm('/s3/success', { uuid: 'u1' })).resolves.toStrictEqual({
      id: 'f1',
    });
    expect(formTokens.refreshes).toStrictEqual(['tok-1']);
    expect(form.call(1).init.headers).toMatchObject({
      Authorization: 'Bearer tok-2',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(form.call(1).init.body).toBe('uuid=u1');

    const jsonTokens = tokens();
    const json = setup(
      { bearer: jsonTokens },
      jsonResponse({ detail: 'expired' }, 401),
      new Response(null, { status: 204 }),
    );

    await expect(json.client.requestJson('DELETE', '/x')).resolves.toBeUndefined();
    expect(jsonTokens.refreshes).toStrictEqual(['tok-1']);

    // A second 401 surfaces auth_failed, once.
    const deniedTokens = tokens();
    const denied = setup(
      { bearer: deniedTokens },
      jsonResponse({ detail: 'no' }, 401),
      jsonResponse({ detail: 'still no' }, 401),
    );

    await expect(rejection(denied.client.getBinary('/files/f1/download'))).resolves.toMatchObject({
      kind: 'auth_failed',
      status: 401,
    });
    expect(denied.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('KizenApiError carries the 400 body', async () => {
    const body = {
      base_config: {
        setup_assistant: { actions: [{}, ['[structure/setup-assistant-action-ref] x']] },
      },
    };
    const { client } = setup(API_KEY, jsonResponse(body, 400));
    const error = await rejection(client.requestJson('POST', '/publish', {}));

    expect(error.kind).toBe('api_error');
    expect(error.status).toBe(400);
    expect(error.details).toStrictEqual(body);
  });
});

describe('redirects', () => {
  interface Recorded {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
  }

  interface TestServer {
    origin: string;
    requests: Recorded[];
    close: () => Promise<void>;
  }

  const servers: TestServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  /** A real HTTP server on 127.0.0.1 that records every request; `respond` answers each. */
  const startServer = async (
    respond: (req: Recorded, res: ServerResponse) => void,
  ): Promise<TestServer> => {
    const requests: Recorded[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        };

        requests.push(recorded);
        respond(recorded, res);
      });
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

    const { port } = server.address() as AddressInfo;
    const handle: TestServer = {
      origin: `http://127.0.0.1:${String(port)}`,
      requests,
      close: () =>
        new Promise<void>((resolveClose) => {
          server.closeAllConnections();
          server.close(() => {
            resolveClose();
          });
        }),
    };

    servers.push(handle);

    return handle;
  };

  const redirectTo =
    (location: () => string, status = 302) =>
    (_req: Recorded, res: ServerResponse): void => {
      res.writeHead(status, { Location: location() });
      res.end();
    };

  const json =
    (body: unknown) =>
    (_req: Recorded, res: ServerResponse): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

  const BEARER_PROVIDER: BearerTokenProvider = {
    environment: 'integration',
    getAccessToken: () => Promise.resolve('tok-1'),
    refreshAccessToken: () => Promise.resolve('tok-2'),
  };

  const AUTH_MODES: [string, KizenClientAuth][] = [
    ['api key', { credentials: CREDENTIALS }],
    ['bearer', { bearer: BEARER_PROVIDER }],
  ];

  it.each(AUTH_MODES)(
    'authenticated requests never follow a cross-origin redirect (%s)',
    async (_mode, auth) => {
      const elsewhere = await startServer(json({ stolen: true }));
      const kizen = await startServer(redirectTo(() => `${elsewhere.origin}/collect`));
      const client = createKizenClient({ ...auth, baseUrl: `${kizen.origin}/api`, fetch });

      for (const invoke of [
        () => client.requestJson('POST', '/publish', { a: 1 }),
        () => client.postForm('/s3/success', { uuid: 'u1' }),
        () => client.getBinary('/files/f1/download'),
        () => client.getDashboard('d1'),
      ]) {
        const error = await rejection(invoke());

        expect(error.kind).toBe('api_error');
        expect(error.message).toContain('outside the Kizen API');
      }

      expect(kizen.requests).toHaveLength(4);
      expect(elsewhere.requests).toStrictEqual([]);
    },
  );

  it.each(AUTH_MODES)('same-origin redirects are followed with auth (%s)', async (_mode, auth) => {
    const kizen = await startServer((req, res) => {
      if (req.url === '/api/old') {
        redirectTo(() => '/api/new', 307)(req, res);
      } else {
        json({ ok: true })(req, res);
      }
    });
    const client = createKizenClient({ ...auth, baseUrl: `${kizen.origin}/api`, fetch });

    await expect(client.requestJson('POST', '/old', { a: 1 })).resolves.toStrictEqual({ ok: true });

    const [first, second] = kizen.requests;

    expect(second?.url).toBe('/api/new');
    // 307 keeps the method and body.
    expect(second?.method).toBe('POST');
    expect(second?.body).toBe('{"a":1}');

    for (const request of [first, second]) {
      if (auth.bearer) {
        expect(request?.headers.authorization).toBe('Bearer tok-1');
      } else {
        expect(request?.headers['x-api-key']).toBe('key-123');
        expect(request?.headers['x-business-id']).toBe('biz-123');
      }
    }
  });

  it('a malformed redirect location fails as api_error', async () => {
    const kizen = await startServer((_req, res) => {
      res.writeHead(302, { Location: 'http://[::1' });
      res.end();
    });
    const client = createKizenClient({ ...API_KEY, baseUrl: `${kizen.origin}/api`, fetch });
    const error = await rejection(client.requestJson('GET', '/x'));

    expect(error.kind).toBe('api_error');
    expect(error.message).toBe(`GET ${kizen.origin}/api/x was redirected to an invalid location`);
    expect(error.status).toBe(302);
  });

  it('a redirect then a 401 refreshes and retries from the original URL and method', async () => {
    const refreshes: string[] = [];
    const bearer: BearerTokenProvider = {
      environment: 'integration',
      getAccessToken: () => Promise.resolve('tok-1'),
      refreshAccessToken: (rejected) => {
        refreshes.push(rejected);

        return Promise.resolve('tok-2');
      },
    };
    const kizen = await startServer((req, res) => {
      if (req.url === '/api/old') {
        redirectTo(() => '/api/new', 307)(req, res);
      } else if (req.headers.authorization === 'Bearer tok-1') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'expired' }));
      } else {
        json({ ok: true })(req, res);
      }
    });
    const client = createKizenClient({ bearer, baseUrl: `${kizen.origin}/api`, fetch });

    await expect(client.requestJson('POST', '/old', { a: 1 })).resolves.toStrictEqual({ ok: true });
    expect(refreshes).toStrictEqual(['tok-1']);
    expect(
      kizen.requests.map((r) => [r.method, r.url, r.headers.authorization, r.body]),
    ).toStrictEqual([
      ['POST', '/api/old', 'Bearer tok-1', '{"a":1}'],
      ['POST', '/api/new', 'Bearer tok-1', '{"a":1}'],
      ['POST', '/api/old', 'Bearer tok-2', '{"a":1}'],
      ['POST', '/api/new', 'Bearer tok-2', '{"a":1}'],
    ]);
  });

  it('a 303 continues as a bodiless GET and a redirect loop stops', async () => {
    const kizen = await startServer((req, res) => {
      if (req.url === '/api/submit') {
        redirectTo(() => '/api/result', 303)(req, res);
      } else if (req.url === '/api/loop') {
        redirectTo(() => '/api/loop')(req, res);
      } else {
        json({ done: true })(req, res);
      }
    });
    const client = createKizenClient({ ...API_KEY, baseUrl: `${kizen.origin}/api`, fetch });

    await expect(client.requestJson('POST', '/submit', { a: 1 })).resolves.toStrictEqual({
      done: true,
    });
    expect(kizen.requests[1]).toMatchObject({ method: 'GET', url: '/api/result', body: '' });

    await expect(rejection(client.requestJson('GET', '/loop'))).resolves.toMatchObject({
      kind: 'api_error',
    });
    // The first request plus five followed redirects.
    expect(kizen.requests.filter((r) => r.url === '/api/loop')).toHaveLength(6);
  });
});
