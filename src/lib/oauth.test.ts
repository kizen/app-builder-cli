import { createHash } from 'node:crypto';
import { createConnection, Server } from 'node:net';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { apiOriginFor } from '../../shared/lib/kizenUrls.js';
import {
  buildAuthorizeUrl,
  DEFAULT_REQUEST_TIMEOUT_MS,
  CALLBACK_FAILURE,
  CALLBACK_SUCCESS,
  CALLBACK_WRONG_STATE,
  createPkcePair,
  discover,
  loginCommandFor,
  loginRequired,
  OAuthError,
  pkceChallenge,
  registerClient,
  requestToken,
  startLoopbackServer,
  type AuthServerMetadata,
  type LoopbackServer,
} from './oauth.js';
import { httpGet, jsonResponse, rejectionOf } from '../test/oauth.js';

const ISSUER = 'https://staging.kizen.com';

const METADATA: AuthServerMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/oauth2/authorize`,
  tokenEndpoint: `${ISSUER}/oauth2/token`,
  registrationEndpoint: `${ISSUER}/oauth2/register`,
};

const canConnect = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });

describe('pkce', () => {
  it('pkce challenge is base64url S256 of the verifier', () => {
    const verifiers = new Set<string>();

    for (let i = 0; i < 20; i += 1) {
      const { verifier, challenge } = createPkcePair();

      // RFC 7636 §4.1: 43–128 chars of [A-Z a-z 0-9 - . _ ~].
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
      expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
      verifiers.add(verifier);
    }

    expect(verifiers.size).toBe(20);
    // RFC 7636 Appendix B test vector.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('apiOriginFor', () => {
  it('strips the /api path to the origin', () => {
    expect(apiOriginFor('staging')).toBe('https://staging.kizen.com');
    expect(apiOriginFor('go')).toBe('https://app.go.kizen.com');
  });
});

describe('loginCommandFor', () => {
  it('omits --env for the default environment and keeps it for any other', () => {
    expect(loginCommandFor('go')).toBe('appbuilder login');
    expect(loginCommandFor('staging')).toBe('appbuilder login --env staging');
    expect(loginCommandFor('integration')).toBe('appbuilder login --env integration');
  });
});

describe('loginRequired', () => {
  it('appends the login command, with "again" only when asked', () => {
    const first = loginRequired('staging', 'Not signed in.');
    const again = loginRequired('fmo', 'Expired.', { again: true });

    expect(first).toBeInstanceOf(OAuthError);
    expect(first.code).toBe('login_required');
    expect(first.message).toBe('Not signed in. Run `appbuilder login --env staging` to sign in.');
    expect(again.message).toBe('Expired. Run `appbuilder login --env fmo` to sign in again.');
  });
});

describe('discover', () => {
  it('reads the RFC 8414 document at the issuer and uses the discovered endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/o/authz`,
        token_endpoint: `${ISSUER}/o/tok`,
        registration_endpoint: `${ISSUER}/o/reg`,
        code_challenge_methods_supported: ['S256'],
      }),
    );

    await expect(discover(ISSUER, fetchMock)).resolves.toStrictEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/o/authz`,
      tokenEndpoint: `${ISSUER}/o/tok`,
      registrationEndpoint: `${ISSUER}/o/reg`,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
  });

  const DISCOVERY = `${ISSUER}/.well-known/oauth-authorization-server`;
  const valid = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/a`,
    token_endpoint: `${ISSUER}/t`,
    code_challenge_methods_supported: ['S256'],
  };
  const notJson = `OAuth discovery at ${DISCOVERY} didn't return valid JSON`;

  it.each([
    [
      'refuses a server without S256 (plain-only PKCE)',
      () => jsonResponse({ ...valid, code_challenge_methods_supported: ['plain'] }),
      `The server at ${ISSUER} doesn't support PKCE S256`,
    ],
    [
      'refuses a non-https endpoint (an http token endpoint)',
      () => jsonResponse({ ...valid, token_endpoint: 'http://evil.test/t' }),
      `OAuth discovery at ${DISCOVERY} has no https authorization or token endpoint`,
    ],
    [
      'discovery with mismatched issuer is rejected (another host)',
      () => jsonResponse({ ...valid, issuer: 'https://evil.test' }),
      `OAuth discovery at ${DISCOVERY} returned issuer "https://evil.test", expected ${ISSUER}`,
    ],
    [
      // RFC 8414 §3.3: identical, so not even a trailing slash.
      'discovery with mismatched issuer is rejected (a trailing slash)',
      () => jsonResponse({ ...valid, issuer: `${ISSUER}/` }),
      `OAuth discovery at ${DISCOVERY} returned issuer "${ISSUER}/", expected ${ISSUER}`,
    ],
    [
      'discovery with mismatched issuer is rejected (no issuer)',
      () => jsonResponse({ ...valid, issuer: undefined }),
      `OAuth discovery at ${DISCOVERY} returned issuer none, expected ${ISSUER}`,
    ],
    [
      'discovery 200 with non-JSON body reports invalid JSON (HTML)',
      () => new Response('<!doctype html><html>Sign in</html>'),
      notJson,
    ],
    [
      'discovery 200 with non-JSON body reports invalid JSON (empty)',
      () => new Response(''),
      notJson,
    ],
    [
      'discovery 200 with non-JSON body reports invalid JSON (a string)',
      () => new Response('"just a string"'),
      notJson,
    ],
    [
      'a non-2xx discovery is still reported by status (404)',
      () => new Response('nope', { status: 404 }),
      `OAuth discovery at ${DISCOVERY} failed with HTTP 404`,
    ],
  ])('%s', async (_name, response, message) => {
    const error = await rejectionOf(
      discover(
        ISSUER,
        vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(response())),
      ),
    );

    expect(error.code).toBe('server_error');
    // Exact, so it also proves a 200 isn't reported as an HTTP failure.
    expect(error.message).toBe(message);
  });
});

describe('registerClient', () => {
  it('registers a public loopback client and returns its client_id', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ client_id: 'abc' }, 201));

    await expect(registerClient(METADATA, fetchMock)).resolves.toBe('abc');

    const [url, init] = fetchMock.mock.calls[0] ?? [];

    expect(url).toBe(`${ISSUER}/oauth2/register`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toStrictEqual({
      client_name: 'Kizen App Builder CLI',
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });
});

describe('buildAuthorizeUrl', () => {
  it('asks for a code with S256 and the CLI scopes, without openid', () => {
    const url = new URL(
      buildAuthorizeUrl(METADATA, {
        clientId: 'c1',
        redirectUri: 'http://127.0.0.1:5555/callback',
        state: 's1',
        codeChallenge: 'ch',
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      response_type: 'code',
      client_id: 'c1',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      scope: 'read write offline_access',
      state: 's1',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });
});

describe('requestToken', () => {
  it("names a thrown fetch error's own code in the network_error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    const error = await rejectionOf(requestToken(METADATA.tokenEndpoint, {}, fetchMock));

    expect(error.code).toBe('network_error');
    expect(error.message).toBe(`Couldn't reach ${ISSUER}: ECONNRESET`);
  });

  it("carries the server's RFC 6749 error code", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: 'invalid_grant', error_description: 'expired' }, 400),
      );
    const error = await rejectionOf(requestToken(METADATA.tokenEndpoint, {}, fetchMock));

    expect(error.code).toBe('invalid_grant');
    expect(error.message).toContain('expired');
  });

  it('sends a form body and parses a bearer response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );

    await expect(
      requestToken(METADATA.tokenEndpoint, { grant_type: 'refresh_token' }, fetchMock),
    ).resolves.toStrictEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 3600,
      scope: undefined,
    });

    const init = fetchMock.mock.calls[0]?.[1];

    expect((init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init?.body).toBe('grant_type=refresh_token');
  });

  it('bounds token requests by default to at most 20s', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  });
});

/**
 * Polls until nothing accepts connections on `port`, without closing anything
 * itself, so it proves the server closed on its own. Resolves false at the bound.
 */
const closesWithin = async (port: number, boundMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + boundMs;

  while (Date.now() < deadline) {
    if (!(await canConnect(port))) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return false;
};

/**
 * Sends `GET <target>` over a raw socket, so a target fetch and node:http would refuse
 * (like `//[`) reaches the server as-is. Resolves with the response's status code.
 */
const rawGetStatus = (port: number, target: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';

    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const status = /^HTTP\/1\.1 (\d{3}) /.exec(response)?.[1];

      if (status === undefined) {
        reject(new Error(`No HTTP status line in: ${JSON.stringify(response)}`));
      } else {
        resolve(Number(status));
      }
    });
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });

/** Starts a loopback server and closes it after the test, for cleanup only. */
const start = async (
  options: Parameters<typeof startLoopbackServer>[0],
): Promise<LoopbackServer> => {
  const server = await startLoopbackServer(options);

  onTestFinished(() => server.close());

  return server;
};

describe('startLoopbackServer', () => {
  // The close() registered by start() is only cleanup: the tests poll with
  // closesWithin, which never closes anything, to prove the server closed itself.
  it('loopback server binds 127.0.0.1 and closes itself after the callback', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen');

    onTestFinished(() => {
      listen.mockRestore();
    });

    const server = await start({ state: 'good' });

    expect(listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
    expect(server.port).toBeGreaterThan(0);
    expect(server.redirectUri).toBe(`http://127.0.0.1:${String(server.port)}/callback`);
    expect(await canConnect(server.port)).toBe(true);

    // A stray request elsewhere doesn't settle or close anything.
    expect((await httpGet(`http://127.0.0.1:${String(server.port)}/favicon.ico`)).status).toBe(404);
    expect(await canConnect(server.port)).toBe(true);

    const response = await httpGet(`${server.redirectUri}?code=the-code&state=good`);

    expect(response.status).toBe(200);
    expect(response.body).toContain(CALLBACK_SUCCESS.text);
    expect(response.body).toContain(`<h1>${CALLBACK_SUCCESS.heading}</h1>`);
    expect(response.body).toContain('class="card success"');
    await expect(server.result).resolves.toStrictEqual({ code: 'the-code' });
    expect(await closesWithin(server.port)).toBe(true);
  });

  it('loopback server closes itself on timeout', async () => {
    const server = await start({ state: 'good', timeoutMs: 50 });

    expect(await canConnect(server.port)).toBe(true);
    expect((await rejectionOf(server.result)).code).toBe('timeout');
    expect(await closesWithin(server.port)).toBe(true);
  });

  it("callback with error param rejects with the server's error", async () => {
    const server = await start({ state: 'good' });
    const response = await httpGet(
      `${server.redirectUri}?error=access_denied&error_description=User+said+no&state=good`,
    );
    const error = await rejectionOf(server.result);

    expect(response.status).toBe(400);
    expect(error.code).toBe('access_denied');
    expect(error.message).toContain('User said no');
    // The server's text isn't echoed into the page.
    expect(response.body).not.toContain('User said no');
    expect(response.body).toContain(`<h1>${CALLBACK_FAILURE.heading}</h1>`);
    expect(response.body).toContain('class="card error"');
    expect(await closesWithin(server.port)).toBe(true);
  });

  it('callback with wrong state gets 400 and login still completes with the real callback', async () => {
    const server = await start({ state: 'good' });
    let settled = false;

    void server.result.then(
      () => (settled = true),
      () => (settled = true),
    );

    // A wrong state, a missing one, and a wrong state carrying an error: none
    // of them may end the login.
    for (const query of ['code=forged&state=bad', 'code=forged', 'error=access_denied&state=bad']) {
      const response = await httpGet(`${server.redirectUri}?${query}`);

      expect(response.status).toBe(400);
      expect(response.body).toContain(CALLBACK_WRONG_STATE.text);
      expect(response.body).toContain(`<h1>${CALLBACK_WRONG_STATE.heading}</h1>`);
      expect(response.body).toContain('class="card error"');
      expect(await canConnect(server.port)).toBe(true);
    }

    expect(settled).toBe(false);

    const response = await httpGet(`${server.redirectUri}?code=the-code&state=good`);

    expect(response.status).toBe(200);
    await expect(server.result).resolves.toStrictEqual({ code: 'the-code' });
    expect(await closesWithin(server.port)).toBe(true);
  });

  it('a callback request with an unparsable URL gets an error response and the login keeps waiting', async () => {
    const server = await start({ state: 'good' });
    let settled = false;

    void server.result.then(
      () => (settled = true),
      () => (settled = true),
    );

    expect(() => new URL('//[', 'http://127.0.0.1')).toThrow();
    expect(await rawGetStatus(server.port, '//[')).toBe(404);
    expect(await canConnect(server.port)).toBe(true);
    expect(settled).toBe(false);

    const response = await httpGet(`${server.redirectUri}?code=the-code&state=good`);

    expect(response.status).toBe(200);
    await expect(server.result).resolves.toStrictEqual({ code: 'the-code' });
    expect(await closesWithin(server.port)).toBe(true);
  });

  it('a wrong-state callback does not stop the timeout', async () => {
    const server = await start({ state: 'good', timeoutMs: 100 });

    expect((await httpGet(`${server.redirectUri}?code=c&state=bad`)).status).toBe(400);
    expect((await rejectionOf(server.result)).code).toBe('timeout');
    expect(await closesWithin(server.port)).toBe(true);
  });

  it('rejects a callback without a code', async () => {
    const server = await start({ state: 'good' });

    await httpGet(`${server.redirectUri}?state=good`);

    expect((await rejectionOf(server.result)).code).toBe('invalid_callback');
  });
});
