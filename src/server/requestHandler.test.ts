import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import type { Credentials } from '../lib/credentials.js';
import { createRequestHandler, type ProxyLogEntry } from './requestHandler.js';

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Talks to the handler over a real socket with node:http rather than fetch —
 * the tests stub the global fetch to observe the handler's own outbound calls,
 * so the client side has to stay off it.
 */
function requestLocal(
  port: number,
  path: string,
  options: RequestOptions = {},
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        // agent:false keeps every request on its own non-keep-alive socket so
        // server.close() in afterEach isn't held open by an idle connection.
        agent: false,
        headers: { host: `127.0.0.1:${String(port)}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);

    if (options.body !== undefined) {
      req.write(options.body);
    }

    req.end();
  });
}

function jsonBody(response: HttpResponse): unknown {
  return JSON.parse(response.body);
}

/** Symlink creation needs privileges on some platforms; report failure so the
 * caller can skip the symlink-defence assertion instead of failing. */
async function trySymlink(target: string, path: string, type?: 'dir'): Promise<boolean> {
  try {
    await symlink(target, path, type);

    return true;
  } catch {
    return false;
  }
}

describe('createRequestHandler routes', () => {
  let root: string;
  let pluginDir: string;
  let outputDir: string;
  let viewerPath: string;
  let outsideDir: string;
  let server: Server;
  let port: number;
  let origin: string;

  // Collaborator fakes — createRequestHandler takes every dependency it needs
  // through its parameter list, so no module mocking is required.
  const createServerLog = vi.fn<(message: string) => void>();
  const createProxyLog = vi.fn<(entry: ProxyLogEntry) => void>();
  const broadcast = vi.fn<(msg: object) => void>();
  const onProxyCacheChange = vi.fn<(size: number) => void>();
  const fetchMock = vi.fn<typeof globalThis.fetch>();
  let credentialsRef: { current: Credentials | null };
  let activeProfileRef: { current: string | undefined };
  let lastPathRef: { current: string | undefined };

  async function startServer(): Promise<void> {
    const handler = createRequestHandler(
      viewerPath,
      createServerLog,
      createProxyLog,
      credentialsRef,
      activeProfileRef,
      outputDir,
      broadcast,
      onProxyCacheChange,
      lastPathRef,
      pluginDir,
      false,
    );

    server = createServer(handler);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    port = (server.address() as AddressInfo).port;
    origin = `http://localhost:${String(port)}`;
  }

  async function readSavedConfig(): Promise<Record<string, unknown>> {
    const content = await readFile(join(outputDir, 'config.json'), 'utf-8');

    return JSON.parse(content) as Record<string, unknown>;
  }

  beforeEach(async () => {
    // mkdtemp hands back /var/... on macOS, which realpaths to /private/var.
    // The handler canonicalises pluginDir itself, so canonicalise here too or
    // every path assertion compares against the wrong prefix.
    root = await realpath(await mkdtemp(join(tmpdir(), 'kizenapp-request-handler-')));
    pluginDir = join(root, 'plugin');
    outputDir = join(pluginDir, '.kizenapp');
    viewerPath = join(root, 'viewer');
    outsideDir = join(root, 'outside');

    await mkdir(join(pluginDir, 'src'), { recursive: true });
    await mkdir(join(pluginDir, 'node_modules'), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await mkdir(viewerPath, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    await writeFile(join(viewerPath, 'index.html'), '<!doctype html><title>viewer</title>');
    await writeFile(join(pluginDir, 'kizen.json'), '{"name":"demo"}');
    await writeFile(join(pluginDir, 'src', 'index.ts'), 'export const answer = 42;\n');
    await writeFile(join(pluginDir, 'node_modules', 'dep.js'), '// dependency\n');
    await writeFile(join(outsideDir, 'secret.txt'), 'top secret\n');

    credentialsRef = { current: null };
    activeProfileRef = { current: undefined };
    lastPathRef = { current: undefined };

    // Only the handler's outbound upstream calls go through global fetch.
    vi.stubGlobal('fetch', fetchMock);

    await startServer();
  });

  afterEach(async () => {
    server.closeAllConnections();

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    vi.unstubAllGlobals();

    await rm(root, { recursive: true, force: true });
  });

  describe('GET /api/bundle', () => {
    it('serves .kizenapp/bundle.json from the working directory', async () => {
      const bundle = { name: 'demo', version: '1.2.3', steps: [{ id: 'a' }] };

      await writeFile(join(outputDir, 'bundle.json'), JSON.stringify(bundle));
      vi.spyOn(process, 'cwd').mockReturnValue(pluginDir);

      const response = await requestLocal(port, '/api/bundle');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(jsonBody(response)).toEqual(bundle);
    });

    it('returns an empty object when no bundle has been built yet', async () => {
      vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'outside'));

      const response = await requestLocal(port, '/api/bundle');

      expect(response.status).toBe(200);
      expect(response.body).toBe('{}');
    });
  });

  describe('POST /api/last-path', () => {
    it('stores the path in the ref and merges it into the saved config', async () => {
      await writeFile(
        join(outputDir, 'config.json'),
        JSON.stringify({ encryptionTarget: 'dev', credentialMode: 'global' }),
      );

      const response = await requestLocal(port, '/api/last-path', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/objects/leads' }),
      });

      expect(response.status).toBe(200);
      expect(jsonBody(response)).toEqual({ ok: true });
      expect(lastPathRef.current).toBe('/objects/leads');
      expect(await readSavedConfig()).toEqual({
        credentialMode: 'global',
        encryptionTarget: 'dev',
        lastPath: '/objects/leads',
      });
    });

    it('ignores a non-string path without failing the request', async () => {
      const response = await requestLocal(port, '/api/last-path', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ path: 42 }),
      });

      expect(response.status).toBe(200);
      expect(lastPathRef.current).toBeUndefined();
    });
  });

  describe('/api/encryption-target', () => {
    it('GET defaults to prod when the config has no target', async () => {
      const response = await requestLocal(port, '/api/encryption-target');

      expect(response.status).toBe(200);
      expect(jsonBody(response)).toEqual({ target: 'prod' });
    });

    it('GET returns dev when dev is stored', async () => {
      await writeFile(join(outputDir, 'config.json'), JSON.stringify({ encryptionTarget: 'dev' }));

      const response = await requestLocal(port, '/api/encryption-target');

      expect(jsonBody(response)).toEqual({ target: 'dev' });
    });

    it('GET maps a legacy auto value to prod', async () => {
      await writeFile(join(outputDir, 'config.json'), JSON.stringify({ encryptionTarget: 'auto' }));

      const response = await requestLocal(port, '/api/encryption-target');

      expect(jsonBody(response)).toEqual({ target: 'prod' });
    });

    it('POST persists dev while preserving unrelated config keys', async () => {
      await writeFile(join(outputDir, 'config.json'), JSON.stringify({ lastPath: '/home' }));

      const response = await requestLocal(port, '/api/encryption-target', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'dev' }),
      });

      expect(response.status).toBe(200);
      expect(jsonBody(response)).toEqual({ ok: true });
      expect(await readSavedConfig()).toEqual({ lastPath: '/home', encryptionTarget: 'dev' });
    });

    it('POST persists prod', async () => {
      const response = await requestLocal(port, '/api/encryption-target', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'prod' }),
      });

      expect(response.status).toBe(200);
      expect(await readSavedConfig()).toEqual({ encryptionTarget: 'prod' });
    });

    it.each(['auto', 'staging', ''])('POST rejects %o with 400', async (target) => {
      const response = await requestLocal(port, '/api/encryption-target', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      });

      expect(response.status).toBe(400);
      expect((jsonBody(response) as { error: string }).error).toContain("'dev', 'prod'");
      await expect(readSavedConfig()).rejects.toThrow();
    });
  });

  describe('write guard (local origin)', () => {
    it('rejects a POST with no Origin header', async () => {
      const response = await requestLocal(port, '/api/last-path', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/objects/leads' }),
      });

      expect(response.status).toBe(403);
      expect(jsonBody(response)).toEqual({ error: 'Forbidden' });
      expect(lastPathRef.current).toBeUndefined();
    });

    it('rejects a POST from a remote Origin', async () => {
      const response = await requestLocal(port, '/api/encryption-target', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'dev' }),
      });

      expect(response.status).toBe(403);
      await expect(readSavedConfig()).rejects.toThrow();
    });
  });

  describe('Host header guard (DNS rebinding)', () => {
    it('rejects a request whose Host is not loopback', async () => {
      const response = await requestLocal(port, '/api/encryption-target', {
        headers: { host: 'attacker.example' },
      });

      expect(response.status).toBe(403);
      expect(jsonBody(response)).toEqual({ error: 'Forbidden' });
    });

    it('rejects a Host that only suffixes localhost', async () => {
      const response = await requestLocal(port, '/api/encryption-target', {
        headers: { host: 'notlocalhost.example' },
      });

      expect(response.status).toBe(403);
    });

    it.each(['localhost', '127.0.0.1'])('accepts %s as the Host', async (host) => {
      const response = await requestLocal(port, '/api/encryption-target', {
        headers: { host: `${host}:${String(port)}` },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('/api/proxy allow-list', () => {
    it.each([
      ['a non-Kizen https origin', 'https://evil.example'],
      ['a look-alike suffix domain', 'https://kizen.com.evil.example'],
      ['plain http on a Kizen domain', 'http://api.kizen.com'],
      ['a non-URL value', 'not-a-url'],
    ])('denies %s without calling upstream', async (_label, target) => {
      const response = await requestLocal(port, '/api/proxy/api/objects', {
        headers: { 'x-proxy-target': target },
      });

      expect(response.status).toBe(400);
      expect(response.body).toBe('Invalid proxy target');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a missing x-proxy-target header without calling upstream', async () => {
      const response = await requestLocal(port, '/api/proxy/api/objects');

      expect(response.status).toBe(400);
      expect(response.body).toBe('Missing x-proxy-target header');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['https://api.kizen.com', 'https://app.kizen.dev'])(
      'forwards a GET to the allowed origin %s',
      async (target) => {
        fetchMock.mockResolvedValue(
          new Response('{"results":[]}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );

        const response = await requestLocal(port, '/api/proxy/api/objects?page=2', {
          headers: { 'x-proxy-target': target, 'x-api-key': 'secret' },
        });

        expect(response.status).toBe(200);
        expect(response.body).toBe('{"results":[]}');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          `${target}/api/objects?page=2`,
          expect.objectContaining({ method: 'GET' }),
        );
      },
    );
  });

  describe('/api/source/tree', () => {
    it('lists the plugin root with directories first and skipped dirs removed', async () => {
      const response = await requestLocal(port, '/api/source/tree?path=');

      expect(response.status).toBe(200);

      const payload = jsonBody(response) as {
        path: string;
        entries: { name: string; kind: string; size?: number }[];
      };

      expect(payload.path).toBe('');
      expect(payload.entries.map((entry) => entry.name)).toEqual(['src', 'kizen.json']);
      expect(payload.entries[0]?.kind).toBe('dir');
      expect(payload.entries[1]).toMatchObject({ kind: 'file', size: 15 });
    });

    it('lists a subdirectory', async () => {
      const response = await requestLocal(port, '/api/source/tree?path=src');

      expect(response.status).toBe(200);
      expect(jsonBody(response)).toMatchObject({
        path: 'src',
        entries: [{ name: 'index.ts' }],
      });
    });

    it.each(['../', '../..', '../outside', '/../outside', 'src/../../outside'])(
      'rejects the traversal path %o',
      async (path) => {
        const response = await requestLocal(
          port,
          `/api/source/tree?path=${encodeURIComponent(path)}`,
        );

        expect(response.status).toBe(403);
        expect(jsonBody(response)).toEqual({ error: 'Invalid path' });
      },
    );

    it('rejects an absolute path outside the plugin dir', async () => {
      const response = await requestLocal(
        port,
        `/api/source/tree?path=${encodeURIComponent(outsideDir)}`,
      );

      expect(response.status).toBe(403);
    });

    it('rejects a skipped directory that exists on disk', async () => {
      const response = await requestLocal(port, '/api/source/tree?path=node_modules');

      expect(response.status).toBe(403);
      expect(jsonBody(response)).toEqual({ error: 'Path is excluded' });
    });

    it('rejects a symlinked directory that escapes the plugin dir', async (ctx: TestContext) => {
      if (!(await trySymlink(outsideDir, join(pluginDir, 'linked-dir'), 'dir'))) {
        ctx.skip();
      }

      const response = await requestLocal(port, '/api/source/tree?path=linked-dir');

      expect(response.status).toBe(403);
      expect(jsonBody(response)).toEqual({ error: 'Invalid path' });
    });
  });

  describe('/api/source/file', () => {
    it('serves a text file with its content and mime type', async () => {
      const response = await requestLocal(port, '/api/source/file?path=src/index.ts');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(response.body).toBe('export const answer = 42;\n');
    });

    it('serves a known mime type from the extension map', async () => {
      const response = await requestLocal(port, '/api/source/file?path=kizen.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    });

    it('rejects a request with no path', async () => {
      const response = await requestLocal(port, '/api/source/file?path=');

      expect(response.status).toBe(400);
      expect(jsonBody(response)).toEqual({ error: 'Missing path' });
    });

    it('rejects a directory', async () => {
      const response = await requestLocal(port, '/api/source/file?path=src');

      expect(response.status).toBe(400);
      expect(jsonBody(response)).toEqual({ error: 'Not a file' });
    });

    it.each([
      '../outside/secret.txt',
      '../../etc/passwd',
      'src/../../outside/secret.txt',
      '/../outside/secret.txt',
    ])('rejects the traversal path %o', async (path) => {
      const response = await requestLocal(
        port,
        `/api/source/file?path=${encodeURIComponent(path)}`,
      );

      expect(response.status).toBe(403);
      expect(jsonBody(response)).toEqual({ error: 'Invalid path' });
      expect(response.body).not.toContain('top secret');
    });

    it('rejects a percent-encoded traversal path', async () => {
      const response = await requestLocal(
        port,
        '/api/source/file?path=%2e%2e%2foutside%2fsecret.txt',
      );

      expect(response.status).toBe(403);
      expect(response.body).not.toContain('top secret');
    });

    it('rejects a path containing a NUL byte', async () => {
      const response = await requestLocal(port, '/api/source/file?path=kizen.json%00.png');

      expect(response.status).toBe(403);
    });

    it('rejects a file inside a skipped directory', async () => {
      const response = await requestLocal(port, '/api/source/file?path=node_modules/dep.js');

      expect(response.status).toBe(403);
      expect(jsonBody(response)).toEqual({ error: 'Path is excluded' });
    });

    it('rejects a symlink that escapes the plugin dir', async (ctx: TestContext) => {
      if (!(await trySymlink(join(outsideDir, 'secret.txt'), join(pluginDir, 'escape.txt')))) {
        ctx.skip();
      }

      const response = await requestLocal(port, '/api/source/file?path=escape.txt');

      expect(response.status).toBe(403);
      expect(jsonBody(response)).toEqual({ error: 'Invalid path' });
      expect(response.body).not.toContain('top secret');
    });

    it('serves a symlink that stays inside the plugin dir', async (ctx: TestContext) => {
      if (!(await trySymlink(join(pluginDir, 'src', 'index.ts'), join(pluginDir, 'alias.ts')))) {
        ctx.skip();
      }

      const response = await requestLocal(port, '/api/source/file?path=alias.ts');

      expect(response.status).toBe(200);
      expect(response.body).toBe('export const answer = 42;\n');
    });
  });
});
