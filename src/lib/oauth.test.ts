import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  CALLBACK_WRONG_STATE_TEXT,
  createPkcePair,
  discover,
  issuerFor,
  OAuthError,
  pkceChallenge,
  registerClient,
  requestToken,
  startLoopbackServer,
  type AuthServerMetadata,
} from './oauth.js';

const ISSUER = 'https://staging.kizen.com';

const METADATA: AuthServerMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/oauth2/authorize`,
  tokenEndpoint: `${ISSUER}/oauth2/token`,
  registrationEndpoint: `${ISSUER}/oauth2/register`,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** GETs a loopback URL with node:http (no proxy), resolving with the status and body. */
const httpGet = (url: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    request(url, { agent: false }, (res) => {
      let body = '';

      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    })
      .on('error', reject)
      .end();
  });

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

const rejectionOf = async (promise: Promise<unknown>): Promise<OAuthError> => {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );

  expect(error).toBeInstanceOf(OAuthError);

  return error as OAuthError;
};

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

describe('issuerFor', () => {
  it('strips the /api path to the origin', () => {
    expect(issuerFor('https://staging.kizen.com/api')).toBe('https://staging.kizen.com');
    expect(issuerFor('https://app.go.kizen.com/api')).toBe('https://app.go.kizen.com');
  });
});

describe('discover', () => {
  it('reads the RFC 8414 document at the issuer and uses the discovered endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
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

  it('refuses a server without S256 or with a non-https endpoint', async () => {
    const plainOnly = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/a`,
        token_endpoint: `${ISSUER}/t`,
        code_challenge_methods_supported: ['plain'],
      }),
    );
    const httpToken = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/a`,
        token_endpoint: 'http://evil.test/t',
      }),
    );

    expect((await rejectionOf(discover(ISSUER, plainOnly))).message).toContain('S256');
    expect((await rejectionOf(discover(ISSUER, httpToken))).message).toContain('https');
  });

  it('discovery with mismatched issuer is rejected', async () => {
    const valid = {
      authorization_endpoint: `${ISSUER}/a`,
      token_endpoint: `${ISSUER}/t`,
      code_challenge_methods_supported: ['S256'],
    };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...valid, issuer: 'https://evil.test' }, 'returned issuer "https://evil.test"'],
      // RFC 8414 §3.3: identical, so not even a trailing slash.
      [{ ...valid, issuer: `${ISSUER}/` }, `returned issuer "${ISSUER}/"`],
      [valid, 'returned issuer none'],
    ];

    for (const [body, message] of cases) {
      const error = await rejectionOf(
        discover(ISSUER, vi.fn<typeof fetch>().mockResolvedValue(json(body))),
      );

      expect(error.code).toBe('server_error');
      expect(error.message).toContain(message);
      expect(error.message).toContain(`expected ${ISSUER}`);
    }
  });

  it('discovery 200 with non-JSON body reports invalid JSON', async () => {
    for (const body of ['<!doctype html><html>Sign in</html>', '', '"just a string"']) {
      const error = await rejectionOf(
        discover(ISSUER, vi.fn<typeof fetch>().mockResolvedValue(new Response(body))),
      );

      expect(error.message).toBe(
        `OAuth discovery at ${ISSUER}/.well-known/oauth-authorization-server didn't return valid JSON`,
      );
      expect(error.message).not.toContain('HTTP 200');
    }

    // A non-2xx is still reported by status.
    const notFound = await rejectionOf(
      discover(
        ISSUER,
        vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 404 })),
      ),
    );

    expect(notFound.message).toContain('failed with HTTP 404');
  });
});

describe('registerClient', () => {
  it('registers a public loopback client and returns its client_id', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ client_id: 'abc' }, 201));

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
      .mockResolvedValue(json({ error: 'invalid_grant', error_description: 'expired' }, 400));
    const error = await rejectionOf(requestToken(METADATA.tokenEndpoint, {}, fetchMock));

    expect(error.code).toBe('invalid_grant');
    expect(error.message).toContain('expired');
  });

  it('sends a form body and parses a bearer response', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600 }),
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

describe('startLoopbackServer', () => {
  // Every test calls close() only for cleanup, after asserting the server
  // already closed itself.
  it('loopback server binds 127.0.0.1 and closes itself after the callback', async () => {
    const server = await startLoopbackServer({ state: 'good' });

    try {
      expect(server.host).toBe('127.0.0.1');
      expect(server.port).toBeGreaterThan(0);
      expect(server.redirectUri).toBe(`http://127.0.0.1:${String(server.port)}/callback`);
      expect(await canConnect(server.port)).toBe(true);

      // A stray request elsewhere doesn't settle or close anything.
      expect((await httpGet(`http://127.0.0.1:${String(server.port)}/favicon.ico`)).status).toBe(
        404,
      );
      expect(await canConnect(server.port)).toBe(true);

      const response = await httpGet(`${server.redirectUri}?code=the-code&state=good`);

      expect(response.status).toBe(200);
      expect(response.body).toContain('You can close this window.');
      await expect(server.result).resolves.toStrictEqual({ code: 'the-code' });
      expect(await closesWithin(server.port)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('loopback server closes itself on timeout', async () => {
    const server = await startLoopbackServer({ state: 'good', timeoutMs: 50 });

    try {
      expect(await canConnect(server.port)).toBe(true);
      expect((await rejectionOf(server.result)).code).toBe('timeout');
      expect(await closesWithin(server.port)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("callback with error param rejects with the server's error", async () => {
    const server = await startLoopbackServer({ state: 'good' });

    try {
      const response = await httpGet(
        `${server.redirectUri}?error=access_denied&error_description=User+said+no&state=good`,
      );
      const error = await rejectionOf(server.result);

      expect(response.status).toBe(400);
      expect(error.code).toBe('access_denied');
      expect(error.message).toContain('User said no');
      // The server's text isn't echoed into the page.
      expect(response.body).not.toContain('User said no');
      expect(await closesWithin(server.port)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('callback with wrong state gets 400 and login still completes with the real callback', async () => {
    const server = await startLoopbackServer({ state: 'good' });
    let settled = false;

    void server.result.then(
      () => (settled = true),
      () => (settled = true),
    );

    try {
      // A wrong state, a missing one, and a wrong state carrying an error: none
      // of them may end the login.
      for (const query of [
        'code=forged&state=bad',
        'code=forged',
        'error=access_denied&state=bad',
      ]) {
        const response = await httpGet(`${server.redirectUri}?${query}`);

        expect(response.status).toBe(400);
        expect(response.body).toContain(CALLBACK_WRONG_STATE_TEXT);
        expect(await canConnect(server.port)).toBe(true);
      }

      expect(settled).toBe(false);

      const response = await httpGet(`${server.redirectUri}?code=the-code&state=good`);

      expect(response.status).toBe(200);
      await expect(server.result).resolves.toStrictEqual({ code: 'the-code' });
      expect(await closesWithin(server.port)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('a wrong-state callback does not stop the timeout', async () => {
    const server = await startLoopbackServer({ state: 'good', timeoutMs: 100 });

    try {
      expect((await httpGet(`${server.redirectUri}?code=c&state=bad`)).status).toBe(400);
      expect((await rejectionOf(server.result)).code).toBe('timeout');
      expect(await closesWithin(server.port)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('rejects a callback without a code', async () => {
    const server = await startLoopbackServer({ state: 'good' });

    try {
      await httpGet(`${server.redirectUri}?state=good`);

      expect((await rejectionOf(server.result)).code).toBe('invalid_callback');
    } finally {
      await server.close();
    }
  });
});
