import { describe, expect, it, vi } from 'vitest';
import type { Credentials } from '../../shared/lib/credentials.js';
import {
  BusinessAppError,
  createBusinessAppsApi,
  type BusinessAppPublishBody,
} from './businessApps.js';
import { apiFailure } from './commandCore.js';
import { createKizenClient, KizenApiError, type KizenClientAuth } from './kizenClient.js';
import type { BearerTokenProvider } from './oauthSession.js';
import { jsonResponse, rejectionOf } from '../test/oauth.js';

const BUSINESS_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BASE = 'https://integration.kizen.dev/api';
const APPS = `${BASE}/external-integrations/plugin-apps/${BUSINESS_ID}`;
const S3_URL = 'https://kizen-uploads.s3.amazonaws.com/';

const CREDENTIALS: Credentials = {
  apiKey: 'key-123',
  userId: 'user-123',
  businessId: BUSINESS_ID,
  environment: 'integration',
};

const BEARER: BearerTokenProvider = {
  environment: 'integration',
  getAccessToken: () => Promise.resolve('tok-1'),
  refreshAccessToken: () => Promise.resolve('tok-2'),
};

const AUTH_MODES: [string, KizenClientAuth][] = [
  ['api key', { credentials: CREDENTIALS }],
  ['bearer', { bearer: BEARER }],
];

const KIZEN_AUTH_HEADERS = ['authorization', 'x-api-key', 'x-user-id', 'x-business-id'];

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

interface Harness {
  api: ReturnType<typeof createBusinessAppsApi>;
  kizenFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  s3Fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  kizenCalls: () => { url: string; init: RequestInit }[];
}

const harness = (
  kizen: Responder,
  s3: Responder = () => new Response(null, { status: 204, headers: { ETag: '"etag-1"' } }),
  auth: KizenClientAuth = { credentials: CREDENTIALS },
): Harness => {
  const kizenFetch = vi.fn<typeof fetch>((input, init) =>
    Promise.resolve(kizen(input as string, init ?? {})),
  );
  const s3Fetch = vi.fn<typeof fetch>((input, init) =>
    Promise.resolve(s3(input as string, init ?? {})),
  );
  const client = createKizenClient({ ...auth, fetch: kizenFetch });
  const api = createBusinessAppsApi(client, BUSINESS_ID, { fetch: s3Fetch });

  return {
    api,
    kizenFetch,
    s3Fetch,
    kizenCalls: () =>
      kizenFetch.mock.calls.map(([url, init]) => ({ url: url as string, init: init ?? {} })),
  };
};

const PRESIGNED = {
  url: S3_URL,
  fields: {
    key: `${BUSINESS_ID}/plugin_app_source_filesystem/obj-1.zip`,
    'Content-Type': 'application/zip',
    acl: 'private',
    policy: 'cG9saWN5',
    'x-amz-signature': 'sig',
  },
  s3object_id: 'obj-1',
  max_file_size: 1024,
  expires_at: '2026-10-27T00:05:00Z',
};

const uploadKizen =
  (presigned: Record<string, unknown> = PRESIGNED): Responder =>
  (url) => {
    if (url.startsWith(`${BASE}/s3/presigned-post`)) {
      return jsonResponse(presigned);
    }

    if (url.startsWith(`${BASE}/s3/success`)) {
      return jsonResponse({ id: 'obj-1', key: PRESIGNED.fields.key });
    }

    throw new Error(`unexpected Kizen request ${url}`);
  };

const ZIP_OPTS = {
  filename: 'source.zip',
  contentType: 'application/zip',
  source: 'plugin_app_source_filesystem' as const,
};

const headerNames = (init: RequestInit): string[] =>
  Object.keys((init.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());

describe('uploadFile', () => {
  it.each(AUTH_MODES)('s3 upload never sends Kizen auth headers (%s)', async (_mode, auth) => {
    const { api, s3Fetch, kizenCalls } = harness(uploadKizen(), undefined, auth);

    await expect(api.uploadFile(new Uint8Array([1, 2, 3]), ZIP_OPTS)).resolves.toBe('obj-1');

    expect(s3Fetch).toHaveBeenCalledTimes(1);

    const [url, init] = s3Fetch.mock.calls[0] ?? [];

    expect(url).toBe(S3_URL);
    expect(init?.method).toBe('POST');

    const names = headerNames(init ?? {});

    for (const name of KIZEN_AUTH_HEADERS) {
      expect(names).not.toContain(name);
    }

    expect(
      headerNames(kizenCalls()[0]?.init ?? {}).some((n) => KIZEN_AUTH_HEADERS.includes(n)),
    ).toBe(true);
  });

  it('posts every presigned field and the file last, then confirms with the s3 etag', async () => {
    const { api, s3Fetch, kizenCalls } = harness(uploadKizen());
    const bytes = new Uint8Array([0, 255, 128, 7]);

    await api.uploadFile(bytes, ZIP_OPTS);

    const form = s3Fetch.mock.calls[0]?.[1]?.body as FormData;
    const keys = [...form.keys()];

    expect(keys).toStrictEqual([...Object.keys(PRESIGNED.fields), 'file']);

    for (const [key, value] of Object.entries(PRESIGNED.fields)) {
      expect(form.get(key)).toBe(value);
    }

    const file = form.get('file') as File;

    expect(file.name).toBe('source.zip');
    expect(file.type).toBe('application/zip');
    expect([...new Uint8Array(await file.arrayBuffer())]).toStrictEqual([...bytes]);

    const [presign, success] = kizenCalls();

    expect(presign?.url).toBe(
      `${BASE}/s3/presigned-post?filename=source.zip&contenttype=application%2Fzip&source=plugin_app_source_filesystem`,
    );
    expect(success?.url).toBe(`${BASE}/s3/success?source=plugin_app_source_filesystem`);
    expect(Object.fromEntries(new URLSearchParams(success?.init.body as string))).toStrictEqual({
      uuid: 'obj-1',
      key: PRESIGNED.fields.key,
      name: 'source.zip',
      etag: '"etag-1"',
    });
  });

  it('uploadFile sends is_public only for thumbnails and uses the same source in presigned + success', async () => {
    const zip = harness(uploadKizen());

    await zip.api.uploadFile(new Uint8Array([1]), ZIP_OPTS);

    const zipSuccess = new URLSearchParams(zip.kizenCalls()[1]?.init.body as string);

    expect(zipSuccess.has('is_public')).toBe(false);

    const image = harness(uploadKizen());

    await image.api.uploadFile(new Uint8Array([1]), {
      filename: 'thumbnail.png',
      contentType: 'image/png',
      source: 'public_image',
      isPublic: true,
    });

    const [presign, success] = image.kizenCalls();

    expect(new URL(presign?.url ?? '').searchParams.get('source')).toBe('public_image');
    expect(new URL(success?.url ?? '').searchParams.get('source')).toBe('public_image');
    expect(new URLSearchParams(success?.init.body as string).get('is_public')).toBe('true');
  });

  it('uploadFile does not call s3/success when the S3 POST fails', async () => {
    const rejected = harness(
      uploadKizen(),
      () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    );
    const error = await rejectionOf(
      rejected.api.uploadFile(new Uint8Array([1]), ZIP_OPTS),
      KizenApiError,
    );

    expect(error.kind).toBe('api_error');
    expect(error.status).toBe(403);
    expect(error.message).toContain('AccessDenied');
    expect(rejected.kizenCalls().map((c) => new URL(c.url).pathname)).toStrictEqual([
      '/api/s3/presigned-post',
    ]);

    const unreachable = harness(uploadKizen(), () => {
      throw new TypeError('fetch failed');
    });
    const networkError = await rejectionOf(
      unreachable.api.uploadFile(new Uint8Array([1]), ZIP_OPTS),
      KizenApiError,
    );

    expect(networkError.kind).toBe('network_error');
    expect(unreachable.kizenCalls()).toHaveLength(1);
  });

  it('uploadFile rejects a file larger than max_file_size before uploading', async () => {
    const { api, s3Fetch, kizenCalls } = harness(uploadKizen({ ...PRESIGNED, max_file_size: 3 }));
    const error = await rejectionOf(api.uploadFile(new Uint8Array(4), ZIP_OPTS), BusinessAppError);

    expect(error.code).toBe('file_too_large');
    expect(s3Fetch).not.toHaveBeenCalled();
    expect(kizenCalls()).toHaveLength(1);

    const atLimit = harness(uploadKizen({ ...PRESIGNED, max_file_size: 3 }));

    await expect(atLimit.api.uploadFile(new Uint8Array(3), ZIP_OPTS)).resolves.toBe('obj-1');
  });

  it('rejects a presign response without a key field before uploading', async () => {
    const { api, s3Fetch } = harness(uploadKizen({ ...PRESIGNED, fields: { acl: 'private' } }));

    await expect(
      rejectionOf(api.uploadFile(new Uint8Array(1), ZIP_OPTS), KizenApiError),
    ).resolves.toMatchObject({ kind: 'api_error' });
    expect(s3Fetch).not.toHaveBeenCalled();
  });
});

describe('downloadFile', () => {
  it('downloadFile returns raw bytes without JSON parsing', async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0x00, 0xc3, 0x28, 0x22, 0x80]);
    const { api, kizenCalls, s3Fetch } = harness(() => new Response(bytes));

    expect([...(await api.downloadFile('file/1'))]).toStrictEqual([...bytes]);
    expect(kizenCalls()[0]?.url).toBe(`${BASE}/files/file%2F1/download`);
    expect(s3Fetch).not.toHaveBeenCalled();
  });
});

describe('business app endpoints', () => {
  const ROW = {
    api_name: 'my_app_bbbbbb',
    base_api_name: 'my_app',
    name: 'My App',
    status: 'live',
    live_version: '2',
    has_releases: true,
    updated: null,
    current_version: '2',
    published_by: null,
    versions: [],
  };

  it('builds each path under the business and parses the responses', async () => {
    const answers: Record<string, () => Response> = {
      [`GET ${APPS}/apps`]: () => jsonResponse([ROW]),
      [`GET ${APPS}/apps?search=my+app`]: () => jsonResponse([ROW]),
      [`GET ${APPS}/my_app_bbbbbb`]: () => jsonResponse({ ...ROW, version: '2' }),
      [`GET ${APPS}/my_app_bbbbbb?preview_owner=${OWNER_ID}`]: () =>
        jsonResponse({ ...ROW, version: '0' }),
      [`GET ${APPS}/my_app_bbbbbb/versions/3`]: () => jsonResponse({ api_name: 'my_app' }),
      [`GET ${APPS}/my_app_bbbbbb/previews/${OWNER_ID}`]: () =>
        jsonResponse({ api_name: 'my_app', source_filesystem_package: 'f1' }),
      [`POST ${APPS}/my_app_bbbbbb/previews/${OWNER_ID}/promote`]: () =>
        jsonResponse({ api_name: 'my_app_bbbbbb', version: '4' }),
      [`DELETE ${APPS}/my_app_bbbbbb/previews/${OWNER_ID}`]: () =>
        new Response(null, { status: 204 }),
      [`POST ${APPS}/publish`]: () =>
        jsonResponse({ api_name: 'my_app_bbbbbb', base_api_name: 'my_app', version: '0' }, 201),
    };
    const { api, kizenCalls } = harness((url, init) => {
      const answer = answers[`${init.method ?? 'GET'} ${url}`];

      if (!answer) {
        throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
      }

      return answer();
    });

    await expect(api.listApps()).resolves.toStrictEqual([ROW]);
    await expect(api.listApps('my app')).resolves.toStrictEqual([ROW]);
    await expect(api.getApp('my_app_bbbbbb')).resolves.toMatchObject({ version: '2' });
    await expect(api.getApp('my_app_bbbbbb', { previewOwner: OWNER_ID })).resolves.toMatchObject({
      version: '0',
    });
    await expect(api.getVersion('my_app_bbbbbb', 3)).resolves.toStrictEqual({ api_name: 'my_app' });
    await expect(api.getPreview('my_app_bbbbbb', OWNER_ID)).resolves.toMatchObject({
      source_filesystem_package: 'f1',
    });
    await expect(api.promotePreview('my_app_bbbbbb', OWNER_ID)).resolves.toStrictEqual({
      api_name: 'my_app_bbbbbb',
      version: '4',
    });
    await expect(api.deletePreview('my_app_bbbbbb', OWNER_ID)).resolves.toBeUndefined();

    const body = { api_name: 'my_app', release: false, thumbnail: null } as BusinessAppPublishBody;

    await expect(api.publish(body)).resolves.toStrictEqual({
      api_name: 'my_app_bbbbbb',
      base_api_name: 'my_app',
      version: '0',
    });

    const publishCall = kizenCalls().at(-1);

    expect(JSON.parse(publishCall?.init.body as string)).toStrictEqual(body);
    expect(kizenCalls()[6]?.init.body).toBeUndefined();
  });

  it('encodes app names and versions into their path segments', async () => {
    const { api, kizenCalls } = harness(() => jsonResponse({}));

    await api.getVersion('a/b', '1?x');

    expect(kizenCalls()[0]?.url).toBe(`${APPS}/a%2Fb/versions/1%3Fx`);
  });

  it('surfaces a 404 as not_found', async () => {
    const { api } = harness(() => jsonResponse({ detail: 'Version not found for this app' }, 404));
    const error = await rejectionOf(api.getVersion('my_app_bbbbbb', 0), KizenApiError);

    expect(error.kind).toBe('not_found');
  });

  it("a 404 from the app list itself says Business Apps aren't on this environment", async () => {
    const { api } = harness(() => jsonResponse({ detail: 'Not found.' }, 404));
    const error = await rejectionOf(api.listApps('my_app'), KizenApiError);

    expect(error).toMatchObject({
      kind: 'not_found',
      status: 404,
      message: "Business Apps aren't available on this Kizen environment yet.",
      hint: 'Kizen has no Business Apps list on this environment (it answered 404). Use an environment where Business Apps are available, with --env.',
    });
    expect((error.cause as KizenApiError).message).toBe(
      `GET /external-integrations/plugin-apps/${BUSINESS_ID}/apps?search=my_app failed with 404: Not found.`,
    );
    expect(apiFailure(error)).toStrictEqual({
      ok: false,
      code: 'not_found',
      message: "Business Apps aren't available on this Kizen environment yet.",
      hint: 'Kizen has no Business Apps list on this environment (it answered 404). Use an environment where Business Apps are available, with --env.',
    });

    const failing = harness(() => jsonResponse({ detail: 'boom' }, 500));

    await expect(rejectionOf(failing.api.listApps(), KizenApiError)).resolves.toMatchObject({
      kind: 'api_error',
      message: `GET /external-integrations/plugin-apps/${BUSINESS_ID}/apps failed with 500: boom`,
    });

    const missing = harness(() => jsonResponse({ detail: 'Version not found for this app' }, 404));
    const versionError = await rejectionOf(
      missing.api.getVersion('my_app_bbbbbb', 2),
      KizenApiError,
    );

    expect(versionError.message).toContain('Version not found for this app');
    expect(versionError.hint).toBeUndefined();
  });

  it('rejects an unexpected list shape', async () => {
    const { api } = harness(() => jsonResponse({ results: [] }));

    await expect(rejectionOf(api.listApps(), KizenApiError)).resolves.toMatchObject({
      kind: 'api_error',
    });
  });

  it('release without a thumbnail is rejected before any request', async () => {
    const { api, kizenFetch, s3Fetch } = harness(() => jsonResponse({}));
    const body = { api_name: 'my_app', release: true, thumbnail: null } as BusinessAppPublishBody;
    const error = await rejectionOf(api.publish(body), BusinessAppError);

    expect(error.code).toBe('thumbnail_required');
    expect(kizenFetch).not.toHaveBeenCalled();
    expect(s3Fetch).not.toHaveBeenCalled();
  });
});

describe('JS action association endpoints', () => {
  const ASSOCIATIONS = `${BASE}/external-integrations/business-plugin-apps/my_app_bbbbbb/browser-js-action-template-associations`;
  const FLAT = `${BASE}/external-integrations/browser-js-action-template-association`;
  const ROW = {
    id: 'assoc-1',
    include_perform_action: null,
    browser_js_action_template: {
      id: 'tpl-1',
      api_name: 'hello_action',
      name: 'Hello',
      hint_object_name: 'client_client',
    },
    custom_object: {
      id: 'obj-1',
      name: 'client_client',
      object_name: 'Contacts',
      entity_name: 'Contact',
    },
  };

  it('lists, creates (flat), patches (nested) and deletes (flat) on the paths the UI uses', async () => {
    const answers: Record<string, () => Response> = {
      [`GET ${ASSOCIATIONS}`]: () => jsonResponse({ associations: [ROW] }),
      [`POST ${FLAT}`]: () => jsonResponse({ ok: true }, 201),
      [`PATCH ${ASSOCIATIONS}/assoc-1`]: () => jsonResponse({ id: 'assoc-1' }),
      [`DELETE ${FLAT}/assoc-1`]: () => new Response(null, { status: 204 }),
    };
    const { api, kizenCalls } = harness((url, init) => {
      const answer = answers[`${init.method ?? 'GET'} ${url}`];

      if (!answer) {
        throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
      }

      return answer();
    });

    await expect(api.listActionAssociations('my_app_bbbbbb')).resolves.toStrictEqual([ROW]);
    await expect(
      api.createActionAssociation({
        appApiName: 'my_app_bbbbbb',
        actionApiName: 'hello_action',
        objectId: 'obj-1',
        includePerformAction: false,
      }),
    ).resolves.toBeUndefined();
    await api.updateActionAssociation('my_app_bbbbbb', 'assoc-1', true);
    await api.deleteActionAssociation('assoc-1');

    const bodies = kizenCalls().map((call) =>
      call.init.body === undefined ? undefined : (JSON.parse(call.init.body as string) as unknown),
    );

    expect(bodies).toStrictEqual([
      undefined,
      {
        browser_js_action_template: {
          api_name: 'hello_action',
          plugin_app_api_name: 'my_app_bbbbbb',
        },
        custom_object: { id: 'obj-1' },
        include_perform_action: false,
      },
      { include_perform_action: true },
      undefined,
    ]);
  });

  it.each([
    [{ associations: 'no' }],
    [[ROW]],
    [{ associations: [{ ...ROW, custom_object: null }] }],
    [{ associations: [{ ...ROW, include_perform_action: 'yes' }] }],
  ])('rejects an association list shaped %j', async (body) => {
    const { api } = harness(() => jsonResponse(body));

    await expect(
      rejectionOf(api.listActionAssociations('my_app_bbbbbb'), KizenApiError),
    ).resolves.toMatchObject({ kind: 'api_error' });
  });

  it('a duplicate create surfaces as a 400 carrying the server message', async () => {
    const { api } = harness(() =>
      jsonResponse(
        [
          'Browser JS Template Association for this custom object/js action template already exists.',
        ],
        400,
      ),
    );
    const error = await rejectionOf(
      api.createActionAssociation({
        appApiName: 'my_app_bbbbbb',
        actionApiName: 'hello_action',
        objectId: 'obj-1',
        includePerformAction: false,
      }),
      KizenApiError,
    );

    expect(error.status).toBe(400);
    expect(error.message).toContain('already exists');
  });

  it('listObjects asks for custom_only=false, so Contacts is included', async () => {
    const { api, kizenCalls } = harness(() =>
      jsonResponse({
        next: null,
        results: [
          {
            id: 'obj-1',
            name: 'client_client',
            object_name: 'Contacts',
            entity_name: 'Contact',
            fetch_url: 'client',
          },
        ],
      }),
    );

    await expect(api.listObjects()).resolves.toStrictEqual([
      { id: 'obj-1', name: 'client_client', objectName: 'Contacts', entityName: 'Contact' },
    ]);
    expect(kizenCalls()[0]?.url).toBe(`${BASE}/custom-objects?page_size=200&custom_only=false`);
  });
});
