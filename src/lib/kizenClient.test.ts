import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '../../shared/lib/credentials.js';
import { createKizenClient, dashletPath, formatDrfError, KizenApiError } from './kizenClient.js';
import type { KizenClient } from './kizenTypes.js';
import type * as ProxyEnvModule from './proxyEnv.js';
import type { ProxyEnvStatus } from './proxyEnv.js';
import { PROXY_UNAVAILABLE_HINT } from './proxyEnv.js';

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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

interface Setup {
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  client: KizenClient;
  call: (index: number) => { url: string; init: RequestInit };
}

const setup = (...responses: Response[]): Setup => {
  const fetchMock = vi.fn<typeof fetch>();

  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }

  const client = createKizenClient({ credentials: CREDENTIALS, fetch: fetchMock });

  const call = (index: number): { url: string; init: RequestInit } => {
    const args = fetchMock.mock.calls[index];

    if (!args) {
      throw new Error(`fetch was not called ${String(index + 1)} times`);
    }

    return { url: args[0] as string, init: args[1] ?? {} };
  };

  return { fetchMock, client, call };
};

const rejection = async (promise: Promise<unknown>): Promise<KizenApiError> => {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );

  expect(error).toBeInstanceOf(KizenApiError);

  return error as KizenApiError;
};

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
      const { client, call } = setup(jsonResponse(body));

      await expect(invoke(client)).resolves.toEqual(expected);

      const { url: calledUrl, init } = call(0);

      expect(calledUrl).toBe(url);
      expect(init.method).toBe('GET');
      expect(init.headers).toEqual(AUTH_HEADERS);
      expect(init.body).toBeUndefined();
    },
  );

  it('adds an encoded custom_object_id when given and tolerates a bare array', async () => {
    const { client, call } = setup(jsonResponse([{ id: 'd2', name: 'Group' }]));

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
      jsonResponse({ count: 2, next, results: [first] }),
      jsonResponse({ count: 2, next: null, results: [second] }),
    );

    await expect(client.listCustomObjects()).resolves.toEqual([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(0).url).toBe(`${BASE}/custom-objects?page_size=200`);
    expect(call(1).url).toBe(next);
    expect(call(1).init.headers).toEqual(AUTH_HEADERS);
  });

  it.each([
    [
      'a same-host http next over the base scheme',
      'http://integration.kizen.dev/api/custom-objects?page=2',
    ],
    ['a relative next against the base origin', '/api/custom-objects?page=2'],
  ])('resolves %s', async (_name, next) => {
    const { client, call, fetchMock } = setup(
      jsonResponse({ next, results: [{ id: 'o1' }] }),
      jsonResponse({ next: null, results: [{ id: 'o2' }] }),
    );

    await expect(client.listCustomObjects()).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).url).toBe(`${BASE}/custom-objects?page=2`);
  });

  it('refuses to follow a next on a foreign host', async () => {
    const { client, fetchMock } = setup(
      jsonResponse({ next: 'https://evil.example.com/steal?page=2', results: [{ id: 'o1' }] }),
      jsonResponse({ next: null, results: [] }),
    );
    const error = await rejection(client.listCustomObjects());

    expect(error.kind).toBe('api_error');
    expect(error.message).toContain('pagination pointed at an unexpected host evil.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => (url as string).includes('evil.example.com'))).toBe(
      false,
    );
  });

  it('stops paginating when next repeats', async () => {
    const next = `${BASE}/custom-objects?page=2&page_size=200`;
    const { client, fetchMock } = setup(
      jsonResponse({ next, results: [{ id: 'o1' }] }),
      jsonResponse({ next, results: [{ id: 'o2' }] }),
    );

    await expect(client.listCustomObjects()).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([[{ id: 'o1' }], [{ fetch_url: 'client' }], [{ id: 1, fetch_url: 'client' }], [[]]])(
    'rejects a custom object body shaped %j',
    async (body) => {
      const { client } = setup(jsonResponse(body));
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
    const { client } = setup(jsonResponse(body));

    await expect(client.getClientObjectId()).resolves.toBeNull();
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
    const { client, call } = setup(jsonResponse(returned, method === 'POST' ? 201 : 200));

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

    const { client, call } = setup(jsonResponse({}), jsonResponse({}));

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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ results: [] }));
    const client = createKizenClient({
      credentials: CREDENTIALS,
      fetch: fetchMock,
      baseUrl: 'http://localhost:9000/api',
    });

    await client.listCustomObjects();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:9000/api/custom-objects?page_size=200',
    );
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
    const { client } = setup(jsonResponse({ detail: 'Invalid API key.' }, 401));
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('auth_failed');
    expect(error.status).toBe(401);
    expect(error.hint).toContain("Check the credentials file's apiKey, userId and businessId.");
    expect(error.message).toBe('GET /dashboards/d1 failed with 401: Invalid API key.');
  });

  it('maps 403 to forbidden with a permissions hint', async () => {
    const { client } = setup(jsonResponse({ detail: 'Nope.' }, 403));
    const error = await rejection(client.updateDashlet('d1', 'dl1', { config: {} }));

    expect(error.kind).toBe('forbidden');
    expect(error.status).toBe(403);
    expect(error.hint).toContain('Standard API Keys permission');
    expect(error.hint).toContain('Customize Homepages permission');
    expect(error.message).toContain('PATCH /dashboards/d1/dashlet/dl1 failed with 403');
  });

  it('maps 404 to not_found', async () => {
    const { client } = setup(jsonResponse({ detail: 'Not found.' }, 404));
    const error = await rejection(client.getDashboard('missing'));

    expect(error.kind).toBe('not_found');
    expect(error.status).toBe(404);
    expect(error.hint).toBeUndefined();
  });

  it('maps other statuses to api_error with the DRF field detail', async () => {
    const { client } = setup(jsonResponse({ config: { content: ['bad'] } }, 400));
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
    const { client } = setup(new Response('<html>Bad Gateway</html>', { status: 502 }));
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

    const { client } = setup(jsonResponse({ detail: 'nope' }, 401));
    const error = await rejection(client.getDashboard('d1'));

    expect(error.kind).toBe('auth_failed');
    expect(error.message).not.toContain(PROXY_UNAVAILABLE_HINT);
  });

  it('maps a GET body read failure to network_error with the status', async () => {
    const response = new Response('{}', { status: 201 });

    vi.spyOn(response, 'text').mockRejectedValueOnce(
      Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }),
    );

    const { client } = setup(response);
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
