/**
 * OAuth 2.0 protocol pieces for `appbuilder login`: RFC 8414 discovery, RFC 7591
 * dynamic client registration, PKCE (S256), the RFC 8252 loopback redirect and
 * the token endpoint. Nothing here persists anything or prints a token; the
 * session store and the login flow live in oauthStore.ts and oauthSession.ts.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { platform } from 'node:process';
import type { Environment } from './credentials.js';
import { errorCause, isRecord } from './guards.js';

/** The registered redirect URI. The server ignores the port for loopback hosts. */
export const REGISTERED_REDIRECT_URI = 'http://127.0.0.1/callback';
export const LOOPBACK_HOST = '127.0.0.1';
export const CALLBACK_PATH = '/callback';
export const OAUTH_SCOPE = 'read write offline_access';
export const CLIENT_NAME = 'Kizen App Builder CLI';
/** `appbuilder login` (and `setup-claude --mcp`) use this environment when no --env is given. */
export const DEFAULT_LOGIN_ENVIRONMENT: Environment = 'go';
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Bound on each request to the authorization server, body included. It must stay
 * well under the refresh lock's 30s stale window so a refresh never outlives
 * the lock it holds.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * An OAuth failure. `code` is the RFC 6749 error code when the server sent one
 * (`invalid_grant`, `invalid_client`, `access_denied`, …), or one of the local
 * codes below.
 */
export type OAuthLocalErrorCode =
  | 'network_error'
  | 'server_error'
  | 'invalid_callback'
  | 'timeout'
  | 'login_required';

export class OAuthError extends Error {
  readonly code: string;

  /** `code` is an OAuthLocalErrorCode or the server's RFC 6749 error code. */
  // `string & {}` keeps any server code while still suggesting the local ones.
  constructor(code: OAuthLocalErrorCode | (string & {}), message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | undefined;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | undefined;
  expiresIn: number;
  scope: string | undefined;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** The OAuth issuer for a Kizen API base URL: its origin, without `/api`. */
export const issuerFor = (apiBaseUrl: string): string => new URL(apiBaseUrl).origin;

export const loginCommandFor = (environment: Environment): string =>
  `appbuilder login --env ${environment}`;

const parseJson = (text: string): unknown => {
  try {
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

/**
 * Sends one request and reads its body, both under one `timeoutMs` deadline. A
 * failure or the deadline becomes `network_error`.
 */
async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; body: unknown }> {
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const res = await fetchImpl(url, { ...init, signal });

    return { res, body: parseJson(await res.text()) };
  } catch (err) {
    const reason = signal.aborted
      ? `timed out after ${String(Math.round(timeoutMs / 1000))}s`
      : errorCause(err);

    throw new OAuthError('network_error', `Couldn't reach ${new URL(url).origin}: ${reason}`);
  }
}

/** Turns a non-2xx OAuth endpoint response into an OAuthError carrying the server's code. */
function endpointError(what: string, status: number, body: unknown): OAuthError {
  if (isRecord(body) && typeof body.error === 'string' && body.error !== '') {
    const description =
      typeof body.error_description === 'string' && body.error_description !== ''
        ? `: ${body.error_description}`
        : '';

    return new OAuthError(body.error, `${what} failed (${body.error}${description})`);
  }

  return new OAuthError('server_error', `${what} failed with HTTP ${String(status)}`);
}

const httpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * RFC 8414 discovery. Requires the metadata's `issuer` to be exactly the one
 * asked for (§3.3), https endpoints and S256 PKCE support.
 */
export async function discover(
  issuer: string,
  fetchImpl: typeof fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<AuthServerMetadata> {
  const url = `${issuer}/.well-known/oauth-authorization-server`;
  const { res, body } = await send(
    fetchImpl,
    url,
    { headers: { Accept: 'application/json' } },
    timeoutMs,
  );

  if (!res.ok) {
    throw new OAuthError(
      'server_error',
      `OAuth discovery at ${url} failed with HTTP ${String(res.status)}`,
    );
  }

  if (!isRecord(body)) {
    throw new OAuthError('server_error', `OAuth discovery at ${url} didn't return valid JSON`);
  }

  if (body.issuer !== issuer) {
    throw new OAuthError(
      'server_error',
      `OAuth discovery at ${url} returned issuer ${typeof body.issuer === 'string' ? JSON.stringify(body.issuer) : 'none'}, expected ${issuer}`,
    );
  }

  const authorizationEndpoint = httpsUrl(body.authorization_endpoint);
  const tokenEndpoint = httpsUrl(body.token_endpoint);

  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    throw new OAuthError(
      'server_error',
      `OAuth discovery at ${url} has no https authorization or token endpoint`,
    );
  }

  const methods = body.code_challenge_methods_supported;

  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new OAuthError('server_error', `The server at ${issuer} doesn't support PKCE S256`);
  }

  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: httpsUrl(body.registration_endpoint),
  };
}

/** RFC 7591 registration of a public (no secret) loopback client. Returns its client_id. */
export async function registerClient(
  metadata: AuthServerMetadata,
  fetchImpl: typeof fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<string> {
  if (metadata.registrationEndpoint === undefined) {
    throw new OAuthError(
      'server_error',
      `The server at ${metadata.issuer} doesn't offer app registration`,
    );
  }

  const { res, body } = await send(
    fetchImpl,
    metadata.registrationEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [REGISTERED_REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    },
    timeoutMs,
  );

  if (!res.ok) {
    throw endpointError('App registration', res.status, body);
  }

  if (!isRecord(body) || typeof body.client_id !== 'string' || body.client_id === '') {
    throw new OAuthError('server_error', 'App registration returned no client_id');
  }

  return body.client_id;
}

/** The S256 code challenge of a verifier (RFC 7636 §4.2). */
export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** A fresh PKCE pair. 32 random bytes give a 43-character base64url verifier. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');

  return { verifier, challenge: pkceChallenge(verifier) };
}

export const randomState = (): string => randomBytes(32).toString('base64url');

export function buildAuthorizeUrl(
  metadata: AuthServerMetadata,
  args: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(metadata.authorizationEndpoint);

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('state', args.state);
  url.searchParams.set('code_challenge', args.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return url.toString();
}

/** POSTs a form to the token endpoint and validates the token response. */
export async function requestToken(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<TokenResponse> {
  const { res, body } = await send(
    fetchImpl,
    tokenEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    },
    timeoutMs,
  );

  if (!res.ok) {
    throw endpointError('The token request', res.status, body);
  }

  if (
    !isRecord(body) ||
    typeof body.access_token !== 'string' ||
    body.access_token === '' ||
    typeof body.token_type !== 'string' ||
    body.token_type.toLowerCase() !== 'bearer'
  ) {
    throw new OAuthError('server_error', 'The token endpoint returned an unexpected response');
  }

  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token !== ''
        ? body.refresh_token
        : undefined,
    expiresIn: typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
  };
}

export interface LoopbackServer {
  /** The address the server is bound to (always 127.0.0.1). */
  host: string;
  port: number;
  /** `http://127.0.0.1:<port>/callback`, used verbatim in the authorize and token requests. */
  redirectUri: string;
  /**
   * Settles on the first callback carrying the right `state` (or the timeout).
   * The server closes either way.
   */
  result: Promise<{ code: string }>;
  close: () => Promise<void>;
}

const page = (text: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Kizen App Builder</title></head><body><p>${text}</p></body></html>`;

export const CALLBACK_SUCCESS_TEXT = 'Login complete. You can close this window.';
export const CALLBACK_FAILURE_TEXT =
  'Login failed. Return to the terminal for details. You can close this window.';
export const CALLBACK_WRONG_STATE_TEXT =
  'This login link is not for the current login. Use the latest link from the terminal.';

/**
 * Starts the RFC 8252 loopback receiver on 127.0.0.1, port 0. A /callback with
 * a wrong or missing `state` gets a 400 and is otherwise ignored, so another
 * local process can't end a pending login with one request. The first callback
 * with the right `state` settles it: an `error` or a missing `code` rejects,
 * otherwise it resolves with the code. Then, or on timeout, the server closes.
 * Other paths get a 404 and are otherwise ignored.
 */
export async function startLoopbackServer(options: {
  state: string;
  timeoutMs?: number;
}): Promise<LoopbackServer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  let settle: { resolve: (v: { code: string }) => void; reject: (e: OAuthError) => void };
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settle = { resolve, reject };
  });

  // The caller awaits `result`; this only stops an early timeout from being reported
  // as an unhandled rejection before it does.
  result.catch(() => undefined);

  let settled = false;
  let closing: Promise<void> | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);

    if (settled || req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' }).end('Not found');

      return;
    }

    const params = url.searchParams;

    if (params.get('state') !== options.state) {
      res
        .writeHead(400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'close',
        })
        .end(page(CALLBACK_WRONG_STATE_TEXT));

      return;
    }

    let outcome: { code: string } | OAuthError;

    if (params.get('error') !== null) {
      const error = params.get('error') ?? '';
      const description = params.get('error_description');

      outcome = new OAuthError(
        error,
        `Kizen denied the sign-in (${error}${description ? `: ${description}` : ''})`,
      );
    } else if (!params.get('code')) {
      outcome = new OAuthError(
        'invalid_callback',
        'The sign-in callback had no authorization code',
      );
    } else {
      outcome = { code: params.get('code') ?? '' };
    }

    const ok = !(outcome instanceof OAuthError);

    res
      .writeHead(ok ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'close',
      })
      .end(page(ok ? CALLBACK_SUCCESS_TEXT : CALLBACK_FAILURE_TEXT));

    finish(outcome);
  });

  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      clearTimeout(timer);
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });

    return closing;
  };

  function finish(outcome: { code: string } | OAuthError): void {
    if (settled) {
      return;
    }

    settled = true;

    if (outcome instanceof OAuthError) {
      settle.reject(outcome);
    } else {
      settle.resolve(outcome);
    }

    void close();
  }

  const timer = setTimeout(() => {
    finish(
      new OAuthError(
        'timeout',
        `Timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for the browser sign-in`,
      ),
    );
  }, timeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  const address = server.address() as AddressInfo;

  return {
    host: address.address,
    port: address.port,
    redirectUri: `http://${LOOPBACK_HOST}:${String(address.port)}${CALLBACK_PATH}`,
    result,
    close,
  };
}

/**
 * Best-effort: asks the OS to open `url` in the default browser. Never throws;
 * the caller always prints the URL too, for when this does nothing.
 */
export function openBrowser(url: string): void {
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? // rundll32 takes the URL as one argv entry, so `&` in the query isn't
          // interpreted the way `cmd /c start` would interpret it.
          ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });

    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is printed regardless.
  }
}
