import { BASE_URLS } from '../../shared/lib/kizenUrls.js';
import type { Credentials } from './credentials.js';
import type {
  CreateDashletBody,
  DashboardType,
  KizenApiErrorKind,
  KizenClient,
  UpdateDashletBody,
  WireCustomObject,
  WireDashboard,
  WireDashboardSummary,
  WireDashlet,
} from './kizenTypes.js';
import { getProxyEnvStatus, PROXY_UNAVAILABLE_HINT } from './proxyEnv.js';

export interface KizenClientOptions {
  credentials: Credentials;
  fetch?: typeof fetch;
  baseUrl?: string;
}

const AUTH_FAILED_HINT =
  "The API key is invalid for this business, or the user id doesn't match. Check the credentials file's apiKey, userId and businessId.";

const FORBIDDEN_HINT =
  "The API key's user needs the Standard API Keys permission and edit access to this dashboard. Homepages also need the Customize Homepages permission.";

interface ListPage {
  results: unknown[];
  next: unknown;
}

const MAX_PAGES = 100;

const UNPREFIXED_KEYS = new Set(['detail', 'non_field_errors']);

export class KizenApiError extends Error {
  readonly kind: KizenApiErrorKind;
  readonly status: number | undefined;
  readonly hint: string | undefined;

  constructor(
    kind: KizenApiErrorKind,
    message: string,
    options: { status?: number; hint?: string } = {},
  ) {
    super(message);
    this.name = 'KizenApiError';
    this.kind = kind;
    this.status = options.status;
    this.hint = options.hint;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function collectMessages(value: unknown, prefix: string, out: string[]): void {
  const push = (text: string): void => {
    out.push(prefix === '' ? text : `${prefix}: ${text}`);
  };

  if (typeof value === 'string') {
    if (value.trim() !== '') {
      push(value);
    }

    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    push(String(value));

    return;
  }

  if (Array.isArray(value)) {
    const texts = value.filter(
      (item): item is string | number | boolean =>
        (typeof item === 'string' && item.trim() !== '') ||
        typeof item === 'number' ||
        typeof item === 'boolean',
    );

    if (texts.length > 0) {
      push(texts.map(String).join(' '));
    }

    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        collectMessages(item, prefix, out);
      }
    }

    return;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPrefix =
        prefix === '' && UNPREFIXED_KEYS.has(key) ? '' : prefix === '' ? key : `${prefix}.${key}`;

      collectMessages(child, childPrefix, out);
    }
  }
}

export function formatDrfError(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const messages: string[] = [];

  collectMessages(body, '', messages);

  return messages.length > 0 ? messages.join('; ') : undefined;
}

function errorCause(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };

  return e.cause?.code ?? e.code ?? e.cause?.message ?? e.message ?? String(err);
}

async function readBody(res: Response): Promise<{ text: string; json: unknown }> {
  const text = await res.text();

  if (text === '') {
    return { text, json: undefined };
  }

  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text, json: undefined };
  }
}

function statusError(method: string, path: string, status: number, body: unknown): KizenApiError {
  const detail = formatDrfError(body);
  const message = `${method} ${path} failed with ${String(status)}${detail === undefined ? '' : `: ${detail}`}`;

  if (status === 401) {
    return new KizenApiError('auth_failed', message, { status, hint: AUTH_FAILED_HINT });
  }

  if (status === 403) {
    return new KizenApiError('forbidden', message, { status, hint: FORBIDDEN_HINT });
  }

  if (status === 404) {
    return new KizenApiError('not_found', message, { status });
  }

  return new KizenApiError('api_error', message, { status });
}

function listResults(method: string, path: string, data: unknown): ListPage {
  if (Array.isArray(data)) {
    return { results: data, next: null };
  }

  if (isRecord(data) && Array.isArray(data.results)) {
    return { results: data.results, next: data.next };
  }

  throw new KizenApiError('api_error', `${method} ${path} returned an unexpected response shape`);
}

export function createKizenClient(options: KizenClientOptions): KizenClient {
  const { credentials } = options;
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? BASE_URLS[credentials.environment];

  const request = async (method: string, target: string, body?: unknown): Promise<unknown> => {
    const url = /^https?:\/\//.test(target) ? target : `${baseUrl}${target}`;
    const path = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
    const headers: Record<string, string> = {
      'X-API-KEY': credentials.apiKey,
      'X-USER-ID': credentials.userId,
      'X-BUSINESS-ID': credentials.businessId,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;

    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      throw new KizenApiError(
        'network_error',
        `Couldn't reach Kizen at ${baseUrl}: ${errorCause(err)}${getProxyEnvStatus() === 'unavailable' ? ` ${PROXY_UNAVAILABLE_HINT}` : ''}`,
      );
    }

    let text: string;
    let json: unknown;

    try {
      ({ text, json } = await readBody(res));
    } catch (err) {
      throw new KizenApiError(
        'network_error',
        `${method} ${path}: couldn't read the response: ${errorCause(err)}. The request may have been applied; check Kizen before retrying.`,
        { status: res.status },
      );
    }

    if (!res.ok) {
      throw statusError(method, path, res.status, json);
    }

    if (json === undefined && text !== '') {
      throw new KizenApiError(
        'api_error',
        `${method} ${path} returned a response that is not JSON`,
        { status: res.status },
      );
    }

    return json;
  };

  const segment = encodeURIComponent;

  const resolveNext = (next: string): string => {
    const base = new URL(baseUrl);
    const resolved = new URL(next, base.origin);

    if (resolved.hostname !== base.hostname) {
      throw new KizenApiError(
        'api_error',
        `GET /custom-objects pagination pointed at an unexpected host ${resolved.hostname}`,
      );
    }

    return new URL(`${resolved.pathname}${resolved.search}`, base.origin).toString();
  };

  return {
    async listDashboards(type: DashboardType, customObjectId?: string) {
      const params = new URLSearchParams({
        size: '10000',
        include_sharing: 'true',
        dashboard_type: type,
      });

      if (customObjectId !== undefined) {
        params.set('custom_object_id', customObjectId);
      }

      const path = `/dashboards/mine?${params.toString()}`;

      return listResults('GET', path, await request('GET', path)).results as WireDashboardSummary[];
    },

    async listCustomObjects() {
      const all: WireCustomObject[] = [];
      const seen = new Set<string>();
      let target: string | undefined = '/custom-objects?page_size=200';

      while (target !== undefined && !seen.has(target) && seen.size < MAX_PAGES) {
        seen.add(target);

        const page: ListPage = listResults('GET', target, await request('GET', target));

        all.push(...(page.results as WireCustomObject[]));
        target =
          typeof page.next === 'string' && page.next !== '' ? resolveNext(page.next) : undefined;
      }

      return all;
    },

    async getCustomObject(id: string) {
      const path = `/custom-objects/${segment(id)}`;
      const data = await request('GET', path);

      if (!isRecord(data) || typeof data.id !== 'string' || typeof data.fetch_url !== 'string') {
        throw new KizenApiError('api_error', `GET ${path} returned an unexpected response shape`);
      }

      return data as unknown as WireCustomObject;
    },

    async getClientObjectId() {
      const data = await request('GET', '/auth/bootstrap');
      const business = isRecord(data) ? data.business : undefined;
      const clientObject = isRecord(business) ? business.client_object : undefined;
      const id = isRecord(clientObject) ? clientObject.id : undefined;

      return typeof id === 'string' && id !== '' ? id : null;
    },

    async getDashboard(id: string) {
      return (await request('GET', `/dashboards/${segment(id)}`)) as WireDashboard;
    },

    async createDashlet(dashboardId: string, body: CreateDashletBody) {
      return (await request(
        'POST',
        `/dashboards/${segment(dashboardId)}/dashlet`,
        body,
      )) as WireDashlet;
    },

    async updateDashlet(dashboardId: string, dashletId: string, body: UpdateDashletBody) {
      return (await request(
        'PATCH',
        `/dashboards/${segment(dashboardId)}/dashlet/${segment(dashletId)}`,
        body,
      )) as WireDashlet;
    },
  };
}
