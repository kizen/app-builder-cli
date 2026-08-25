import { createReadStream, realpathSync } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProxyCache,
  MAX_PROXY_BYTES,
  ProxyResponseTooLargeError,
  readBodyWithLimit,
  sanitizeUpstreamHeaders,
} from '../lib/proxyCache.js';
import { MIME_TYPES } from '../lib/constants.js';
import type { Credentials } from '../lib/credentials.js';
import {
  listCredentialProfiles,
  loadCredentialProfile,
  loadGlobalCredentials,
} from '../lib/credentials.js';
import { loadConfig, saveConfig } from '../lib/config.js';
import { resolveWizardBase } from '../lib/wizardUrl.js';
import { executePythonStep } from './pythonExecutor.js';
import { SKIP_DIRS } from '../lib/readFiles.js';
import { TEXT_EXTENSIONS } from '../../shared/lib/fileExtensions.js';
import {
  CRYPTO_ALG,
  CRYPTO_VERSION,
  deserializeEnvelope,
  encrypt,
  serializeEnvelope,
} from '@kizenapps/packager';

const SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024;

const SKIP_FILES = new Set(['.DS_Store', '.gitignore']);

function isLocalHost(host: string | undefined): boolean {
  if (host === undefined || host === '') {
    return false;
  }

  // Strip the port. This is a host header, so IPv6 would arrive as "[::1]:port"
  // — we don't serve ::1 (Node binds to 127.0.0.1), but the guard is permissive
  // enough to survive that even if the bind address changes later.
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : (host.split(':')[0] ?? '');

  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

const PROXY_ALLOWED_DOMAINS = ['kizen.com', 'kizen.dev'];

/**
 * Guards the resolved encryption-API host. The wizard proxy forwards the
 * caller's Kizen credential headers, so a fat-fingered PLUGIN_WIZARD_URL* env
 * var must not be able to leak them to an arbitrary origin. Allows a
 * locally-running wizard (any localhost/loopback) plus https on a Kizen domain.
 */
function isAllowedWizardTarget(target: string): boolean {
  let url: URL;

  try {
    url = new URL(target);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  // URL.hostname returns IPv6 literals bracketed, e.g. '[::1]'.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return true;
  }

  if (url.protocol !== 'https:') {
    return false;
  }

  return PROXY_ALLOWED_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith('.' + domain),
  );
}

function isAllowedProxyTarget(target: string): boolean {
  let url: URL;

  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  return PROXY_ALLOWED_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith('.' + domain),
  );
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') {
    return false;
  }

  try {
    const { hostname } = new URL(origin);

    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

async function resolveSafePath(realPluginDir: string, relParam: string): Promise<string | null> {
  if (relParam.includes('\0')) {
    return null;
  }

  const rel = relParam.replace(/^\/+/, '');
  const abs = resolve(realPluginDir, rel);

  // Syntactic .. traversal check — fails fast before touching the filesystem.
  if (abs !== realPluginDir && !abs.startsWith(realPluginDir + sep)) {
    return null;
  }

  // Symlink-aware check: a symlink inside the plugin dir can still escape it
  // (e.g. a link to ~/.ssh/id_rsa resolves to a path that passes the string
  // check above but reads arbitrary files). Realpath the target and re-verify.
  // If the target doesn't exist realpath throws — reject rather than guess.
  try {
    const realAbs = await realpath(abs);

    if (realAbs !== realPluginDir && !realAbs.startsWith(realPluginDir + sep)) {
      return null;
    }

    return realAbs;
  } catch {
    return null;
  }
}

function isInsideSkippedDir(pluginDir: string, abs: string): boolean {
  const rel = abs === pluginDir ? '' : abs.slice(pluginDir.length + 1);

  if (rel === '') {
    return false;
  }

  const segments = rel.split(sep);

  return segments.some((segment) => SKIP_DIRS.has(segment));
}

export type { ProxyLogEntry } from '../../shared/lib/proxy.js';
export { proxyLogEntryToString } from '../../shared/lib/proxy.js';
import { type ProxyLogEntry } from '../../shared/lib/proxy.js';

export function getViewerPath(): string {
  const filename = fileURLToPath(import.meta.url);

  return join(dirname(filename), 'viewer');
}

/**
 * Calls to Kizen's `/external-integrations/proxy` endpoint wrap the third-party
 * API's status in the response body (`status_code`) and return HTTP 200 even
 * when the upstream call failed. Pull that real status out so the network log
 * can surface it instead of the misleading proxy status.
 */
function extractUpstreamStatus(
  upstreamPath: string,
  headers: Record<string, string>,
  body: Buffer,
): number | undefined {
  if (!upstreamPath.includes('/external-integrations/proxy')) {
    return undefined;
  }

  if (!headers['content-type']?.includes('application/json')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body.toString('utf8')) as { status_code?: unknown };

    return typeof parsed.status_code === 'number' ? parsed.status_code : undefined;
  } catch {
    return undefined;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}

export function createRequestHandler(
  viewerPath: string,
  createServerLog: (message: string) => void,
  createProxyLog: (entry: ProxyLogEntry) => void,
  credentialsRef: { current: Credentials | null },
  activeProfileRef: { current: string | undefined },
  outputDir: string,
  broadcast: (msg: object) => void,
  onProxyCacheChange: (size: number) => void,
  lastPathRef: { current: string | undefined },
  pluginDir: string,
  cacheEnabled: boolean,
): (req: IncomingMessage, res: ServerResponse) => void {
  const proxyCache = createProxyCache({ onChange: onProxyCacheChange, enabled: cacheEnabled });
  // Resolve the plugin dir once so every source-path check compares against
  // the canonical path (handles macOS /var → /private/var, pnpm workspace
  // symlinks, etc.). Done synchronously at handler creation since pluginDir
  // is process.cwd() and must already exist.
  const realPluginDir = realpathSync(pluginDir);

  return (req, res) => {
    void (async () => {
      const url = req.url ?? '/';

      try {
        // Even though we bind to 127.0.0.1, a browser tab on
        // a malicious origin can point its DNS at our loopback address. The
        // Host header still carries the original hostname, so rejecting
        // anything that isn't localhost/127.0.0.1 closes the hole.
        if (!isLocalHost(req.headers.host)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Forbidden' }));

          return;
        }

        const isWrite = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';

        if (isWrite && !isLocalOrigin(req.headers.origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Forbidden' }));

          return;
        }

        createServerLog(`Received request: ${url}`);

        if (url === '/api/credentials') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

          res.end(
            JSON.stringify({
              credentials: credentialsRef.current ?? null,
              activeProfile: activeProfileRef.current ?? null,
            }),
          );

          return;
        }

        if (url === '/api/credential-profiles' && req.method === 'GET') {
          const profiles = await listCredentialProfiles();

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

          res.end(JSON.stringify({ profiles, active: activeProfileRef.current }));

          return;
        }

        if (url === '/api/credentials/switch' && req.method === 'POST') {
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }

          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            profile?: string;
          };
          const profileName = body.profile;
          const creds =
            profileName === undefined || profileName === ''
              ? await loadGlobalCredentials()
              : await loadCredentialProfile(profileName);

          if (creds !== null) {
            credentialsRef.current = creds;

            activeProfileRef.current = profileName ?? undefined;

            const active = activeProfileRef.current;
            const currentConfig = await loadConfig(outputDir);

            await saveConfig(outputDir, {
              ...currentConfig,
              credentialMode: 'global',
              ...(active !== undefined && { activeCredentialProfile: active }),
            });

            broadcast({
              type: 'credentials-updated',
              credentials: creds,
              activeProfile: activeProfileRef.current ?? null,
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

          res.end(JSON.stringify({ ok: creds !== null }));

          return;
        }

        if (url === '/api/bundle') {
          const bundlePath = join(process.cwd(), '.kizenapp', 'bundle.json');

          try {
            const content = await readFile(bundlePath, 'utf-8');

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

            res.end(content);
          } catch {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

            res.end('{}');
          }

          return;
        }

        if (url === '/api/last-path' && req.method === 'POST') {
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }

          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            path?: string;
          };

          if (typeof body.path === 'string') {
            lastPathRef.current = body.path;

            const currentConfig = await loadConfig(outputDir);

            await saveConfig(outputDir, { ...currentConfig, lastPath: body.path });
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

          res.end('{"ok":true}');

          return;
        }

        if (url === '/api/encryption-target' && req.method === 'GET') {
          const config = await loadConfig(outputDir);
          // Default to 'prod' when unset. Anything that isn't an explicit 'dev'
          // (incl. a legacy 'auto' from before the heuristic was dropped) maps to
          // 'prod', so the API only ever returns a concrete target.
          const target = config.encryptionTarget === 'dev' ? 'dev' : 'prod';

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ target }));

          return;
        }

        if (url === '/api/encryption-target' && req.method === 'POST') {
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }

          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          const body: { target?: string } =
            parsed !== null && typeof parsed === 'object' ? (parsed as { target?: string }) : {};

          if (body.target !== 'dev' && body.target !== 'prod') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: "target must be one of: 'dev', 'prod'" }));

            return;
          }

          const currentConfig = await loadConfig(outputDir);

          // body.target is narrowed to 'dev' | 'prod' by the guard above.
          await saveConfig(outputDir, { ...currentConfig, encryptionTarget: body.target });

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"ok":true}');

          return;
        }

        if (url === '/api/execute-step' && req.method === 'POST') {
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }

          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            script?: string;
            scriptRuntime?: string;
            inputs?: Record<string, string>;
            secrets?: Record<string, string>;
            timeout?: number;
          };

          if (typeof body.script !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });

            res.end(JSON.stringify({ error: 'Missing required field: script' }));

            return;
          }

          const stepParams: Parameters<typeof executePythonStep>[0] = {
            script: body.script,
            // Matches the production Kizen code-runner service's default runtime
            // ("python-3-13"). Only used when a caller omits a runtime; real
            // plugin steps send their own "python-3-NN" value.
            scriptRuntime: body.scriptRuntime ?? 'python-3-13',
            inputs: body.inputs ?? {},
            secrets: body.secrets ?? {},
            onInstallProgress: (event) => {
              if (event.kind === 'start') {
                broadcast({ type: 'venv-install-start' });
              } else if (event.kind === 'log') {
                broadcast({
                  type: 'venv-install-log',
                  line: event.line,
                  stream: event.stream,
                });
              } else if (event.kind === 'complete') {
                broadcast({ type: 'venv-install-complete' });
              } else {
                broadcast({ type: 'venv-install-error', message: event.message });
              }
            },
          };

          if (typeof body.timeout === 'number' && body.timeout > 0) {
            // Cap at 5 minutes so a runaway request can't hang the Python
            // runner indefinitely. Default (30s) still applies if omitted.
            stepParams.timeout = Math.min(body.timeout, 5 * 60 * 1000);
          }

          const result = await executePythonStep(stepParams);

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

          res.end(JSON.stringify(result));

          return;
        }

        if (url === '/api/proxy-cache/clear') {
          proxyCache.clear();

          createProxyLog({ kind: 'info', message: 'Proxy cache cleared' });

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

          res.end('{"ok":true}');

          return;
        }

        if (url === '/api/local/encrypt' && req.method === 'POST') {
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }

          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            publicKeyPem?: string;
            value?: string;
          };

          if (typeof body.publicKeyPem !== 'string' || typeof body.value !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Missing required fields: publicKeyPem, value' }));

            return;
          }

          try {
            const envelope = encrypt(body.value, body.publicKeyPem);
            const serialized = serializeEnvelope(envelope);

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(serialized));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }

          return;
        }

        if (url === '/api/local/validate' && req.method === 'POST') {
          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }

          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            value?: string;
          };

          if (typeof body.value !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Missing required field: value' }));

            return;
          }

          interface CheckResult {
            label: string;
            expected: string;
            actual: string;
            pass: boolean;
          }

          let envelope: ReturnType<typeof deserializeEnvelope> | undefined;
          let parseError: string | undefined;

          try {
            envelope = deserializeEnvelope(body.value);
          } catch (err) {
            parseError = (err as Error).message;
          }

          if (parseError !== undefined || envelope === undefined) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ valid: false, checks: [], error: parseError }));

            return;
          }

          const bufLen = (b64: string): number => Buffer.from(b64, 'base64').length;

          const checks: CheckResult[] = [
            {
              label: 'Version',
              expected: String(CRYPTO_VERSION),
              actual: String(envelope.v),
              pass: (envelope.v as number) === CRYPTO_VERSION,
            },
            {
              label: 'Algorithm',
              expected: CRYPTO_ALG,
              actual: envelope.alg,
              pass: (envelope.alg as string) === CRYPTO_ALG,
            },
            {
              label: 'Wrapped key',
              expected: '384 bytes (RSA-3072)',
              actual: `${String(bufLen(envelope.k))} bytes`,
              pass: bufLen(envelope.k) === 384,
            },
            {
              label: 'IV',
              expected: '12 bytes',
              actual: `${String(bufLen(envelope.iv))} bytes`,
              pass: bufLen(envelope.iv) === 12,
            },
            {
              label: 'Auth tag',
              expected: '16 bytes',
              actual: `${String(bufLen(envelope.tag))} bytes`,
              pass: bufLen(envelope.tag) === 16,
            },
            {
              label: 'Ciphertext',
              expected: '≥ 1 byte',
              actual: `${String(bufLen(envelope.ct))} bytes`,
              pass: bufLen(envelope.ct) >= 1,
            },
          ];

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ valid: checks.every((c) => c.pass), checks }));

          return;
        }

        if (url.startsWith('/api/wizard')) {
          // The viewer sends the saved dev/prod target here; we map it to a known
          // host. A duplicated header arrives as an array — take the first value.
          // Default to 'prod' when absent/invalid: prod is the product-wide
          // default (almost every plugin ships to production), and only an
          // explicit 'dev' routes to the dev keys.
          const rawTarget = req.headers['x-encryption-target'];
          const targetHeader = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;
          const target: 'dev' | 'prod' = targetHeader === 'dev' ? 'dev' : 'prod';
          const wizardBase = resolveWizardBase(target);

          // The credential headers below are forwarded to wizardBase — refuse to
          // forward them anywhere but a known host.
          if (!isAllowedWizardTarget(wizardBase)) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                error: `Encryption API host is not allowed: ${wizardBase}`,
              }),
            );

            return;
          }

          const upstreamPath = url.slice('/api/wizard'.length) || '/';
          const upstreamUrl = `${wizardBase}${upstreamPath}`;
          const method = req.method ?? 'GET';

          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }

          const {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            host: _wizardHost,
            // Internal control header — don't forward it upstream.
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            'x-encryption-target': _encTarget,
            ...wizardForwardHeaders
          } = req.headers;

          const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
          const resolvedBody = body && body.length > 0 ? body : undefined;

          let upstream: Response;

          try {
            upstream = await fetch(upstreamUrl, {
              method,
              headers: wizardForwardHeaders as Record<string, string>,
              ...(resolvedBody !== undefined && { body: resolvedBody }),
            });
          } catch (err) {
            const message =
              (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
                ? `plugin-wizard is not running at ${wizardBase}`
                : `Failed to reach plugin-wizard: ${(err as Error).message}`;

            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: message }));

            return;
          }

          const wizardResponseHeaders = sanitizeUpstreamHeaders(
            Object.fromEntries(upstream.headers),
          );
          const wizardBody = await upstream.arrayBuffer();

          res.writeHead(upstream.status, wizardResponseHeaders);
          res.end(Buffer.from(wizardBody));

          return;
        }

        if (url.startsWith('/api/proxy')) {
          const proxyTarget = req.headers['x-proxy-target'];

          if (typeof proxyTarget !== 'string') {
            res.writeHead(400);

            res.end('Missing x-proxy-target header');

            return;
          }

          if (!isAllowedProxyTarget(proxyTarget)) {
            res.writeHead(400);

            res.end('Invalid proxy target');

            return;
          }

          const upstreamPath = url.slice('/api/proxy'.length) || '/';
          const upstreamUrl = `${proxyTarget}${upstreamPath}`;
          const method = req.method ?? 'GET';

          const chunks: Buffer[] = [];

          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }

          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { host, 'x-proxy-target': _drop, ...forwardHeaders } = req.headers;

          if (method === 'GET') {
            const cacheKey = `GET::${upstreamUrl}`;
            const { response: cached, fromCache } = await proxyCache.get(cacheKey, () =>
              fetch(upstreamUrl, {
                method: 'GET',
                headers: forwardHeaders as Record<string, string>,
              }),
            );

            createProxyLog({
              kind: 'request',
              method: 'GET',
              status: cached.status,
              upstreamStatus: extractUpstreamStatus(upstreamPath, cached.headers, cached.body),
              fromCache,
              url: upstreamPath,
            });

            res.writeHead(cached.status, cached.headers);

            res.end(cached.body);

            return;
          }

          const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
          const resolvedBody = body && body.length > 0 ? body : undefined;
          const upstream = await fetch(upstreamUrl, {
            method,
            headers: forwardHeaders as Record<string, string>,
            ...(resolvedBody !== undefined && { body: resolvedBody }),
          });
          const responseHeaders = sanitizeUpstreamHeaders(Object.fromEntries(upstream.headers));
          const responseBody = await readBodyWithLimit(upstream, MAX_PROXY_BYTES);

          createProxyLog({
            kind: 'request',
            method,
            status: upstream.status,
            upstreamStatus: extractUpstreamStatus(upstreamPath, responseHeaders, responseBody),
            fromCache: false,
            url: upstreamPath,
          });

          res.writeHead(upstream.status, responseHeaders);

          res.end(responseBody);

          return;
        }

        if (url.startsWith('/api/source/tree') && req.method === 'GET') {
          const query = new URL(url, 'http://localhost').searchParams;
          const relParam = query.get('path') ?? '';
          const abs = await resolveSafePath(realPluginDir, relParam);

          if (abs === null) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid path' }));

            return;
          }

          if (isInsideSkippedDir(realPluginDir, abs)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Path is excluded' }));

            return;
          }

          try {
            const dirEntries = await readdir(abs, { withFileTypes: true });
            const entries = await Promise.all(
              dirEntries
                .filter((entry) => {
                  if (entry.isDirectory()) {
                    return !SKIP_DIRS.has(entry.name);
                  }

                  if (entry.isFile()) {
                    return !SKIP_FILES.has(entry.name);
                  }

                  return false;
                })
                .map(async (entry) => {
                  const kind = entry.isDirectory() ? ('dir' as const) : ('file' as const);
                  const result: { name: string; kind: 'dir' | 'file'; size?: number } = {
                    name: entry.name,
                    kind,
                  };

                  if (kind === 'file') {
                    try {
                      const stats = await stat(join(abs, entry.name));

                      result.size = stats.size;
                    } catch {
                      // Ignore stat failures — file may have been deleted mid-scan.
                    }
                  }

                  return result;
                }),
            );

            entries.sort((a, b) => {
              if (a.kind !== b.kind) {
                return a.kind === 'dir' ? -1 : 1;
              }

              return a.name.localeCompare(b.name);
            });

            const normalizedPath = abs === realPluginDir ? '' : abs.slice(realPluginDir.length + 1);

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ path: normalizedPath, entries }));
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);

            createServerLog(`source/tree failed (${relParam}): ${detail}`);

            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }

          return;
        }

        if (url.startsWith('/api/source/file') && req.method === 'GET') {
          const query = new URL(url, 'http://localhost').searchParams;
          const relParam = query.get('path') ?? '';

          if (relParam === '') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Missing path' }));

            return;
          }

          const abs = await resolveSafePath(realPluginDir, relParam);

          if (abs === null) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid path' }));

            return;
          }

          if (isInsideSkippedDir(realPluginDir, abs)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Path is excluded' }));

            return;
          }

          try {
            const stats = await stat(abs);

            if (!stats.isFile()) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'Not a file' }));

              return;
            }

            if (stats.size > SOURCE_FILE_MAX_BYTES) {
              res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'File too large', size: stats.size }));

              return;
            }

            const ext = extname(abs).toLowerCase();
            const explicitMime = MIME_TYPES[ext];
            const isKnownText = TEXT_EXTENSIONS.has(ext);
            const contentType =
              explicitMime ??
              (isKnownText ? 'text/plain; charset=utf-8' : 'application/octet-stream');

            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': String(stats.size),
            });
            createReadStream(abs).pipe(res);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);

            createServerLog(`source/file failed (${relParam}): ${detail}`);

            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }

          return;
        }

        const rawPath = url === '/' ? '/index.html' : url;
        const filePath = join(viewerPath, rawPath);
        const resolvedPath = (await fileExists(filePath))
          ? filePath
          : join(viewerPath, 'index.html');
        const ext = extname(resolvedPath);
        const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': mimeType });

        createReadStream(resolvedPath).pipe(res);
      } catch (err) {
        if (url.startsWith('/api/proxy')) {
          const upstreamPath = url.slice('/api/proxy'.length) || '/';
          const method = req.method ?? 'GET';

          if (err instanceof ProxyResponseTooLargeError) {
            createProxyLog({
              kind: 'info',
              message: `${method} ${upstreamPath} → 502 (response exceeded ${String(err.limit)} bytes)`,
            });
          } else {
            createProxyLog({
              kind: 'request',
              method,
              status: 502,
              fromCache: false,
              url: upstreamPath,
            });
          }
        } else {
          createProxyLog({
            kind: 'info',
            message: `Error handling ${url}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        if (!res.headersSent) {
          res.writeHead(502);

          res.end('Bad Gateway');
        }
      }
    })();
  };
}
