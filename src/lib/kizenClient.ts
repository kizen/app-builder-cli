import { BASE_URLS } from '../../shared/lib/kizenUrls.js';
import type { Credentials, Environment } from './credentials.js';
import { errorCause, errorMessage, isRecord, nonEmptyString } from './guards.js';
import type {
  CreateDashletBody,
  DashboardType,
  KizenApiErrorKind,
  KizenClient,
  KizenJsonMethod,
  ListCustomObjectsOptions,
  UpdateDashletBody,
  WireCustomObject,
  WireDashboard,
  WireDashboardSummary,
  WireDashlet,
} from './kizenTypes.js';
import {
  loginRequired,
  OAuthError,
  SessionStoreUnwritableError,
  type OAuthLocalErrorCode,
} from './oauth.js';
import type { BearerTokenProvider } from './oauthSession.js';
import { getProxyEnvStatus, PROXY_UNAVAILABLE_HINT } from './proxyEnv.js';

/** Bearer auth sends only `Authorization`; the token is bound to one user and business. */
export type KizenClientAuth =
  | { credentials: Credentials; bearer?: undefined }
  | { bearer: BearerTokenProvider; credentials?: undefined };

export type KizenClientOptions = KizenClientAuth & {
  fetch?: typeof fetch;
  baseUrl?: string;
};

/** Who a session belongs to, from `/auth/bootstrap`. */
export interface KizenIdentity {
  userId: string;
  businessId: string;
  businessName: string | undefined;
  fullName: string | undefined;
  email: string | undefined;
}

export type KizenSessionClient = KizenClient & { getIdentity: () => Promise<KizenIdentity> };

const AUTH_FAILED_HINT =
  "The API key is invalid for this business, or the user id doesn't match. Check the credentials file's apiKey, userId and businessId.";

const FORBIDDEN_HINT =
  "The API key's user needs the Standard API Keys permission and edit access to this dashboard. Homepages also need the Customize Homepages permission.";

const bearerAuthFailedHint = (environment: Environment): string =>
  loginRequired(environment, 'Kizen rejected the signed-in session.', { again: true }).message;

const BEARER_FORBIDDEN_HINT =
  'The signed-in user needs edit access to this dashboard. Homepages also need the Customize Homepages permission.';

interface StatusHints {
  authFailed: string;
  forbidden: string;
}

const API_KEY_HINTS: StatusHints = { authFailed: AUTH_FAILED_HINT, forbidden: FORBIDDEN_HINT };

interface ListPage {
  results: unknown[];
  next: unknown;
}

const MAX_PAGES = 100;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const MAX_REDIRECTS = 5;

const UNPREFIXED_KEYS = new Set(['detail', 'non_field_errors']);

export class KizenApiError extends Error {
  readonly kind: KizenApiErrorKind;
  readonly status: number | undefined;
  readonly hint: string | undefined;
  /** The parsed body of a failed response (a DRF error dict, say), or undefined when it had none. */
  readonly details: unknown;

  constructor(
    kind: KizenApiErrorKind,
    message: string,
    options: { status?: number; hint?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KizenApiError';
    this.kind = kind;
    this.status = options.status;
    this.hint = options.hint;
    this.details = options.details;
  }
}

const segment = encodeURIComponent;

/** The API path of a dashboard's dashlet collection, or of one dashlet in it. */
export const dashletPath = (dashboardId: string, dashletId?: string): string =>
  dashletId === undefined
    ? `/dashboards/${segment(dashboardId)}/dashlet`
    : `/dashboards/${segment(dashboardId)}/dashlet/${segment(dashletId)}`;

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

function statusError(
  method: string,
  path: string,
  status: number,
  body: unknown,
  hints: StatusHints,
): KizenApiError {
  const detail = formatDrfError(body);
  const message = `${method} ${path} failed with ${String(status)}${detail === undefined ? '' : `: ${detail}`}`;
  const details = body;

  if (status === 401) {
    return new KizenApiError('auth_failed', message, { status, hint: hints.authFailed, details });
  }

  if (status === 403) {
    return new KizenApiError('forbidden', message, { status, hint: hints.forbidden, details });
  }

  if (status === 404) {
    return new KizenApiError('not_found', message, { status, details });
  }

  return new KizenApiError('api_error', message, { status, details });
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

const recordOrEmpty = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** The `business` and `team` objects of an `/auth/bootstrap` response, each {} when absent. */
function bootstrapParts(data: unknown): {
  business: Record<string, unknown>;
  team: Record<string, unknown>;
} {
  const root = recordOrEmpty(data);

  return { business: recordOrEmpty(root.business), team: recordOrEmpty(root.team) };
}

/** A Map, so a code like "toString" can't match. Anything else is api_error. */
const TOKEN_ERROR_KINDS = new Map<OAuthLocalErrorCode, KizenApiErrorKind>([
  ['login_required', 'auth_failed'],
  ['network_error', 'network_error'],
  ['session_store_unwritable', 'session_store_unwritable'],
]);

/** `cause` keeps the token provider's error, so a caller can tell a missing sign-in apart. */
function tokenError(err: unknown, environment: Environment): KizenApiError {
  const message = errorMessage(err);
  const kind =
    err instanceof OAuthError ? TOKEN_ERROR_KINDS.get(err.code as OAuthLocalErrorCode) : undefined;

  return kind === undefined
    ? new KizenApiError('api_error', `Couldn't refresh the ${environment} session: ${message}`, {
        cause: err,
      })
    : new KizenApiError(kind, message, {
        cause: err,
        ...(err instanceof SessionStoreUnwritableError && { hint: err.hint }),
      });
}

export function createKizenClient(options: KizenClientOptions): KizenSessionClient {
  const fetchImpl = options.fetch ?? fetch;
  const environment = options.bearer ? options.bearer.environment : options.credentials.environment;
  const baseUrl = options.baseUrl ?? BASE_URLS[environment];
  const apiOrigin = new URL(baseUrl).origin;

  const hints: StatusHints = options.bearer
    ? { authFailed: bearerAuthFailedHint(environment), forbidden: BEARER_FORBIDDEN_HINT }
    : API_KEY_HINTS;

  const rethrow = (err: unknown): never => {
    throw tokenError(err, environment);
  };

  // `retry` (Bearer only) gives the headers for one retry after a 401.
  const authorize = async (): Promise<{
    headers: Record<string, string>;
    retry?: () => Promise<Record<string, string>>;
  }> => {
    if (!options.bearer) {
      const { apiKey, userId, businessId } = options.credentials;

      return { headers: { 'X-API-KEY': apiKey, 'X-USER-ID': userId, 'X-BUSINESS-ID': businessId } };
    }

    const { bearer } = options;
    const token = await bearer.getAccessToken().catch(rethrow);

    return {
      headers: { Authorization: `Bearer ${token}` },
      // The refresh names the token Kizen rejected.
      retry: async () => ({
        Authorization: `Bearer ${await bearer.refreshAccessToken(token).catch(rethrow)}`,
      }),
    };
  };

  // Sends one authenticated request, refreshing and retrying once after a Bearer 401.
  // Redirects are followed by hand, and only within the API origin: fetch's own following would
  // forward the X-API-KEY / X-USER-ID / X-BUSINESS-ID headers to whatever host a 3xx names.
  const send = async (
    method: string,
    url: string,
    accept: string,
    body?: { contentType: string; payload: string },
  ): Promise<Response> => {
    const fetchOnce = async (
      target: string,
      hopMethod: string,
      hopBody: { contentType: string; payload: string } | undefined,
      authHeaders: Record<string, string>,
    ): Promise<Response> => {
      const headers: Record<string, string> = { ...authHeaders, Accept: accept };
      const init: RequestInit = { method: hopMethod, headers, redirect: 'manual' };

      if (hopBody !== undefined) {
        headers['Content-Type'] = hopBody.contentType;
        init.body = hopBody.payload;
      }

      try {
        return await fetchImpl(target, init);
      } catch (err) {
        throw new KizenApiError(
          'network_error',
          `Couldn't reach Kizen at ${baseUrl}: ${errorCause(err)}${getProxyEnvStatus() === 'unavailable' ? ` ${PROXY_UNAVAILABLE_HINT}` : ''}`,
        );
      }
    };

    const attempt = async (authHeaders: Record<string, string>): Promise<Response> => {
      let target = url;
      let hopMethod = method;
      let hopBody = body;

      for (let hops = 0; ; hops += 1) {
        const res = await fetchOnce(target, hopMethod, hopBody, authHeaders);

        // A runtime that hides manual redirects can't be followed safely.
        if (res.type === 'opaqueredirect') {
          throw new KizenApiError(
            'api_error',
            `${method} ${url} was redirected to an unknown location`,
          );
        }

        const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;

        if (location === null) {
          return res;
        }

        await res.body?.cancel().catch(() => undefined);

        let next: URL;

        try {
          next = new URL(location, target);
        } catch {
          throw new KizenApiError(
            'api_error',
            `${method} ${url} was redirected to an invalid location`,
            { status: res.status },
          );
        }

        if (next.origin !== apiOrigin) {
          throw new KizenApiError(
            'api_error',
            `${method} ${url} was redirected to ${next.origin}, outside the Kizen API; the request was not sent there.`,
            { status: res.status },
          );
        }

        if (hops >= MAX_REDIRECTS) {
          throw new KizenApiError('api_error', `${method} ${url} redirected too many times`, {
            status: res.status,
          });
        }

        // As fetch does: 303, and 301/302 after a POST, continue as a bodiless GET.
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && hopMethod === 'POST')
        ) {
          hopMethod = 'GET';
          hopBody = undefined;
        }

        target = next.toString();
      }
    };

    const { headers: authHeaders, retry } = await authorize();
    let res = await attempt(authHeaders);

    // One refresh and retry; a second 401 falls through to the auth error.
    if (res.status === 401 && retry) {
      await res.body?.cancel().catch(() => undefined);
      res = await attempt(await retry());
    }

    return res;
  };

  const unreadable = (method: string, path: string, status: number, err: unknown): KizenApiError =>
    new KizenApiError(
      'network_error',
      `${method} ${path}: couldn't read the response: ${errorCause(err)}. The request may have been applied; check Kizen before retrying.`,
      { status },
    );

  const resolveTarget = (target: string): { url: string; path: string } => {
    const url = /^https?:\/\//.test(target) ? target : `${baseUrl}${target}`;

    return { url, path: url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url };
  };

  const request = async (
    method: string,
    target: string,
    body?: { contentType: string; payload: string },
  ): Promise<unknown> => {
    const { url, path } = resolveTarget(target);
    const res = await send(method, url, 'application/json', body);

    let text: string;
    let json: unknown;

    try {
      ({ text, json } = await readBody(res));
    } catch (err) {
      throw unreadable(method, path, res.status, err);
    }

    if (!res.ok) {
      throw statusError(method, path, res.status, json, hints);
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

  const jsonBody = (body: unknown): { contentType: string; payload: string } | undefined =>
    body === undefined
      ? undefined
      : { contentType: 'application/json', payload: JSON.stringify(body) };

  // The public primitives take an API path only, so Kizen credentials never go to another host.
  const apiPath = (method: string, path: string): string => {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new KizenApiError(
        'api_error',
        `${method} ${path}: expected a path under the Kizen API`,
      );
    }

    return path;
  };

  // Only the API origin is followed, on the base scheme and port (a proxy may emit http).
  const resolveNext = (next: string): string => {
    const base = new URL(baseUrl);
    const resolved = new URL(next, base.origin);

    resolved.protocol = base.protocol;
    resolved.port = base.port;
    resolved.username = '';
    resolved.password = '';
    resolved.hash = '';

    if (resolved.origin !== base.origin) {
      throw new KizenApiError(
        'api_error',
        `GET /custom-objects pagination pointed at an unexpected location ${resolved.origin}${resolved.pathname}`,
      );
    }

    return resolved.toString();
  };

  // Set by getIdentity, so getClientObjectId doesn't fetch /auth/bootstrap again.
  let identityBootstrap: unknown;

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

    async listCustomObjects(options: ListCustomObjectsOptions = {}) {
      const all: WireCustomObject[] = [];
      const seen = new Set<string>();
      let target: string | undefined =
        `/custom-objects?page_size=200${options.customOnly === false ? '&custom_only=false' : ''}`;

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

    async getIdentity() {
      const data = await request('GET', '/auth/bootstrap');
      const { business, team } = bootstrapParts(data);
      const businessId = nonEmptyString(business.id);
      const userId = nonEmptyString(team.user);

      if (businessId === undefined || userId === undefined) {
        throw new KizenApiError(
          'api_error',
          'GET /auth/bootstrap returned an unexpected response shape',
        );
      }

      identityBootstrap = data;

      return {
        userId,
        businessId,
        businessName: nonEmptyString(business.name),
        fullName: nonEmptyString(team.full_name),
        email: nonEmptyString(team.email),
      };
    },

    async getClientObjectId() {
      const data = identityBootstrap ?? (await request('GET', '/auth/bootstrap'));
      const { business } = bootstrapParts(data);

      return nonEmptyString(recordOrEmpty(business.client_object).id) ?? null;
    },

    async getDashboard(id: string) {
      return (await request('GET', `/dashboards/${segment(id)}`)) as WireDashboard;
    },

    async createDashlet(dashboardId: string, body: CreateDashletBody) {
      return (await request('POST', dashletPath(dashboardId), jsonBody(body))) as WireDashlet;
    },

    async updateDashlet(dashboardId: string, dashletId: string, body: UpdateDashletBody) {
      return (await request(
        'PATCH',
        dashletPath(dashboardId, dashletId),
        jsonBody(body),
      )) as WireDashlet;
    },

    async requestJson(method: KizenJsonMethod, path: string, body?: unknown) {
      return request(method, apiPath(method, path), jsonBody(body));
    },

    async postForm(path: string, fields: Readonly<Record<string, string>>) {
      return request('POST', apiPath('POST', path), {
        contentType: 'application/x-www-form-urlencoded',
        payload: new URLSearchParams(fields).toString(),
      });
    },

    async getBinary(path: string) {
      const { url, path: shown } = resolveTarget(apiPath('GET', path));
      const res = await send('GET', url, '*/*');

      if (!res.ok) {
        let json: unknown;

        try {
          ({ json } = await readBody(res));
        } catch (err) {
          throw unreadable('GET', shown, res.status, err);
        }

        throw statusError('GET', shown, res.status, json, hints);
      }

      try {
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        throw unreadable('GET', shown, res.status, err);
      }
    },
  };
}
