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
import { type CallbackPageKind, renderCallbackPage } from './callbackPage.js';
import type { Environment } from './credentials.js';
import { errorCause, isRecord, nonEmptyString } from './guards.js';

const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
/** The server ignores the port for loopback hosts, so this one URI covers every port. */
const REGISTERED_REDIRECT_URI = `http://${LOOPBACK_HOST}${CALLBACK_PATH}`;
const OAUTH_SCOPE = 'read write offline_access';
const CLIENT_NAME = 'Kizen App Builder CLI';
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Used by `login` and `setup-claude --mcp` when no --env is given. */
export const DEFAULT_LOGIN_ENVIRONMENT: Environment = 'go';
/** Per request, body included, so a hung server fails the command instead of stalling it. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** `code` is the server's RFC 6749 error code when it sent one, else a local code. */
export type OAuthLocalErrorCode =
  | 'network_error'
  | 'server_error'
  | 'invalid_callback'
  | 'timeout'
  | 'login_required'
  | 'session_store_unwritable';

export class OAuthError extends Error {
  // `string & {}` keeps any server code while still suggesting the local ones.
  constructor(
    readonly code: OAuthLocalErrorCode | (string & {}),
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

const DISK_FULL_ERRNO_CODES: readonly string[] = ['ENOSPC', 'EDQUOT'];

export const UNWRITABLE_ERRNO_CODES: readonly string[] = [
  'EPERM',
  'EACCES',
  'EROFS',
  ...DISK_FULL_ERRNO_CODES,
];

export class SessionStoreUnwritableError extends OAuthError {
  readonly hint: string;

  constructor(storeDir: string, credentialsDir: string, errno: string) {
    const full = DISK_FULL_ERRNO_CODES.includes(errno);

    super(
      'session_store_unwritable',
      full
        ? `Can't write to ${storeDir} (${errno}): the disk is full or over quota. appbuilder keeps its sign-in sessions there.`
        : `Can't write to ${storeDir} (${errno}), where appbuilder keeps its sign-in sessions.`,
    );
    this.name = 'SessionStoreUnwritableError';
    this.hint = full
      ? `Free some disk space (or quota) for ${credentialsDir}, then run the command again.`
      : `appbuilder needs write access to ${credentialsDir} to keep you signed in. Under Codex, re-run the command with sandbox_permissions: "require_escalated" (prefix_rule: ["appbuilder"]). Under the Claude Code sandbox, add "appbuilder *" to sandbox.excludedCommands in your user settings (~/.claude/settings.json); allowing writes to ${credentialsDir} alone isn't enough, since appbuilder also needs network access the sandbox blocks.`;
  }
}

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** `--env` only when it isn't `login`'s default, so hints for go read `appbuilder login`. */
export const loginCommandFor = (environment: Environment): string =>
  environment === DEFAULT_LOGIN_ENVIRONMENT
    ? 'appbuilder login'
    : `appbuilder login --env ${environment}`;

/** A `login_required` error: `reason`, then how to sign in (again). */
export const loginRequired = (
  environment: Environment,
  reason: string,
  options: { again?: boolean } = {},
): OAuthError =>
  new OAuthError(
    'login_required',
    `${reason} Run \`${loginCommandFor(environment)}\` to sign in${options.again === true ? ' again' : ''}.`,
  );

const parseJson = (text: string): unknown => {
  try {
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

/** One JSON request, body read included, under one deadline. Any failure is `network_error`. */
async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ res: Response; body: unknown }> {
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const res = await fetchImpl(url, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
      signal,
    });

    return { res, body: parseJson(await res.text()) };
  } catch (err) {
    const reason = signal.aborted
      ? `timed out after ${String(Math.round(timeoutMs / 1000))}s`
      : errorCause(err);

    throw new OAuthError('network_error', `Couldn't reach ${new URL(url).origin}: ${reason}`);
  }
}

function endpointError(what: string, status: number, body: unknown): OAuthError {
  const fields: Record<string, unknown> = isRecord(body) ? body : {};
  const code = nonEmptyString(fields.error);

  if (code !== undefined) {
    const description = nonEmptyString(fields.error_description);

    return new OAuthError(
      code,
      `${what} failed (${code}${description === undefined ? '' : `: ${description}`})`,
    );
  }

  return new OAuthError('server_error', `${what} failed with HTTP ${String(status)}`);
}

/** RFC 8414 discovery. Requires an exact `issuer` match (§3.3). */
export async function discover(
  issuer: string,
  fetchImpl: typeof fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<AuthServerMetadata> {
  const url = `${issuer}/.well-known/oauth-authorization-server`;
  const fail = (detail: string): OAuthError =>
    new OAuthError('server_error', `OAuth discovery at ${url} ${detail}`);
  const { res, body } = await send(fetchImpl, url, {}, timeoutMs);

  if (!res.ok) {
    throw fail(`failed with HTTP ${String(res.status)}`);
  }

  if (!isRecord(body)) {
    throw fail("didn't return valid JSON");
  }

  if (body.issuer !== issuer) {
    throw fail(
      `returned issuer ${typeof body.issuer === 'string' ? JSON.stringify(body.issuer) : 'none'}, expected ${issuer}`,
    );
  }

  return {
    issuer,
    authorizationEndpoint: body.authorization_endpoint as string,
    tokenEndpoint: body.token_endpoint as string,
    registrationEndpoint: body.registration_endpoint as string,
  };
}

/** RFC 7591 registration of a public (no secret) loopback client. Returns its client_id. */
export async function registerClient(
  metadata: AuthServerMetadata,
  fetchImpl: typeof fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<string> {
  const { res, body } = await send(
    fetchImpl,
    metadata.registrationEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  const clientId = isRecord(body) ? nonEmptyString(body.client_id) : undefined;

  if (clientId === undefined) {
    throw new OAuthError('server_error', 'App registration returned no client_id');
  }

  return clientId;
}

/** The S256 code challenge of a verifier (RFC 7636 §4.2). */
export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** 32 random bytes as base64url (43 characters): a login's `state`, or a PKCE verifier. */
export const random256 = (): string => randomBytes(32).toString('base64url');

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = random256();

  return { verifier, challenge: pkceChallenge(verifier) };
}

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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    timeoutMs,
  );

  if (!res.ok) {
    throw endpointError('The token request', res.status, body);
  }

  const accessToken = isRecord(body) ? nonEmptyString(body.access_token) : undefined;
  const refreshToken = isRecord(body) ? nonEmptyString(body.refresh_token) : undefined;

  if (!isRecord(body) || accessToken === undefined || refreshToken === undefined) {
    throw new OAuthError('server_error', 'The token endpoint returned an unexpected response');
  }

  return {
    accessToken,
    refreshToken,
    expiresIn: body.expires_in as number,
  };
}

export interface LoopbackServer {
  port: number;
  /** `http://127.0.0.1:<port>/callback`, used verbatim in the authorize and token requests. */
  redirectUri: string;
  /** Settles on the first callback with the right `state`, or the timeout; then the server closes. */
  result: Promise<{ code: string }>;
  close: () => Promise<void>;
}

interface CallbackPage {
  kind: CallbackPageKind;
  heading: string;
  text: string;
}

const respond = (res: ServerResponse, status: number, page: CallbackPage): void => {
  res
    .writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close',
    })
    .end(renderCallbackPage(page.kind, page.heading, page.text));
};

// Constants only: nothing from the request reaches the page.
export const CALLBACK_SUCCESS: CallbackPage = {
  kind: 'success',
  heading: 'You’re signed in',
  text: 'Sign-in complete. You can close this window.',
};
export const CALLBACK_FAILURE: CallbackPage = {
  kind: 'error',
  heading: 'Sign-in failed',
  text: 'Sign-in failed. Return to the terminal for details. You can close this window.',
};
export const CALLBACK_WRONG_STATE: CallbackPage = {
  kind: 'error',
  heading: 'Outdated link',
  text: 'This sign-in link is out of date. Use the latest link from the terminal.',
};

/** The request target as a URL, or undefined when it doesn't parse. */
const parseRequestTarget = (target: string | undefined): URL | undefined => {
  try {
    return new URL(target ?? '/', `http://${LOOPBACK_HOST}`);
  } catch {
    return undefined;
  }
};

/**
 * The RFC 8252 loopback receiver on 127.0.0.1, port 0. A wrong or missing `state` gets a 400
 * and is otherwise ignored, so another local process can't end a pending login with one request.
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

  // Keeps an early timeout from surfacing as an unhandled rejection before the caller awaits.
  result.catch(() => undefined);

  let settled = false;
  let closing: Promise<void> | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A target like `//[` doesn't parse; it can't be the callback, so it gets the same 404.
    const url = parseRequestTarget(req.url);

    if (settled || req.method !== 'GET' || url?.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' }).end('Not found');

      return;
    }

    const params = url.searchParams;

    if (params.get('state') !== options.state) {
      respond(res, 400, CALLBACK_WRONG_STATE);

      return;
    }

    const error = params.get('error');
    const description = params.get('error_description');
    // Read once as a string: TypeScript can't narrow it through `failure` below.
    const code = params.get('code') ?? '';
    const failure =
      error !== null
        ? new OAuthError(
            error,
            `Kizen denied the sign-in (${error}${description ? `: ${description}` : ''})`,
          )
        : !code
          ? new OAuthError('invalid_callback', 'The sign-in callback had no authorization code')
          : undefined;

    respond(res, failure ? 400 : 200, failure ? CALLBACK_FAILURE : CALLBACK_SUCCESS);
    finish(failure, code);
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

  function finish(failure: OAuthError | undefined, code = ''): void {
    if (settled) {
      return;
    }

    settled = true;

    if (failure) {
      settle.reject(failure);
    } else {
      settle.resolve({ code });
    }

    void close();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const timer = setTimeout(() => {
    finish(
      new OAuthError(
        'timeout',
        `Timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for the browser sign-in`,
      ),
    );
  }, timeoutMs);

  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    redirectUri: `http://${LOOPBACK_HOST}:${String(address.port)}${CALLBACK_PATH}`,
    result,
    close,
  };
}

/** Best-effort and never throws; the caller always prints the URL too. */
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
