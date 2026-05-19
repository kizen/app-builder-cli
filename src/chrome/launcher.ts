import { launch } from 'chrome-launcher';
import type { LaunchedChrome } from 'chrome-launcher';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = createRequire(import.meta.url)('chrome-remote-interface') as (opts: {
  port: number;
}) => Promise<CDPClient>;

interface CDPHeader {
  name: string;
  value: string;
}

interface CDPFetchPausedEvent {
  requestId: string;
  request: { url: string };
  responseHeaders?: CDPHeader[];
  responseStatusCode?: number;
}

interface CDPClient {
  Fetch: {
    enable: (opts: { patterns: { urlPattern: string; requestStage: string }[] }) => Promise<void>;
    getResponseBody: (opts: {
      requestId: string;
    }) => Promise<{ body: string; base64Encoded: boolean }>;
    fulfillRequest: (opts: {
      requestId: string;
      responseCode: number;
      responseHeaders: CDPHeader[];
      body?: string;
      base64Encoded?: boolean;
    }) => Promise<void>;
    continueRequest: (opts: { requestId: string }) => Promise<void>;
  };
  Network: {
    getAllCookies: () => Promise<{ cookies: CDPCookie[] }>;
    setCookie: (opts: CDPCookieSet) => Promise<void>;
  };
  Target: {
    setDiscoverTargets: (opts: { discover: boolean }) => Promise<void>;
    closeTarget: (opts: { targetId: string }) => Promise<void>;
    activateTarget: (opts: { targetId: string }) => Promise<void>;
  };
  Browser: {
    setDockTile: (opts: { image?: string; label?: string }) => Promise<void>;
  };
  send: (method: string, params?: object, sessionId?: string) => Promise<unknown>;
  on: (event: string, handler: (params: unknown, sessionId?: string) => void) => void;
  close: () => Promise<void>;
}

interface CDPTargetCreatedEvent {
  targetInfo: {
    targetId: string;
    type: string;
    url: string;
  };
}

interface CDPCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
}

interface CDPCookieSet {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}

const CSP_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
]);

const KIZEN_DOMAINS = ['kizen.dev', 'kizen.com'];

function isKizenUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);

    return KIZEN_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

async function installDockIcon(client: CDPClient): Promise<void> {
  try {
    const iconPath = join(dirname(fileURLToPath(import.meta.url)), 'viewer', 'icon.png');
    const icon = await readFile(iconPath);

    await client.Browser.setDockTile({ image: icon.toString('base64') });
  } catch {
    // Non-critical: silently skip if icon is missing or platform doesn't support it
  }
}

export interface ChromeViewerOptions {
  port: number;
  userDataDir: string;
  broadcast: (msg: object) => void;
  path?: string;
  debugLog?: (msg: string) => void;
  // Always-on channel for user-visible warnings (e.g. "CDP unavailable,
  // running without interception"). Unlike debugLog, not gated by --debug.
  onWarn?: (msg: string) => void;
  verbose?: boolean;
}

export interface ChromeViewerHandle {
  kill: () => void;
}

export async function launchChromeViewer(opts: ChromeViewerOptions): Promise<ChromeViewerHandle> {
  // chrome-launcher opens log files inside userDataDir before Chrome starts
  mkdirSync(opts.userDataDir, { recursive: true });

  const baseUrl = `http://localhost:${String(opts.port)}`;

  const chrome: LaunchedChrome = await launch({
    startingUrl: baseUrl,
    chromeFlags: [
      `--app=${baseUrl}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-features=DeviceBoundSessions',
    ],
    userDataDir: opts.userDataDir,
    handleSIGINT: false,
    logLevel: 'silent',
  });

  const cdpPort = chrome.port;

  let client: CDPClient | null = null;
  let cookieTimer: ReturnType<typeof setInterval> | null = null;
  let mainTargetId: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let killed = false;

  const dbg = (msg: string): void => {
    opts.debugLog?.(msg);
  };

  const vb = (msg: string): void => {
    if (opts.verbose) {
      opts.debugLog?.(msg);
    }
  };

  const clearCookieTimer = (): void => {
    if (cookieTimer !== null) {
      clearInterval(cookieTimer);
      cookieTimer = null;
    }
  };

  const isNewTabUrl = (url: string): boolean =>
    url === 'chrome://new-tab-page/' || url === 'chrome://newtab/';

  const setupClient = async (c: CDPClient): Promise<void> => {
    // Fresh CDP session: reset per-connection state.
    clearCookieTimer();
    mainTargetId = null;

    await installDockIcon(c);

    // ── 1. Response interception: strip CSP + fix SameSite cookies ──────────────
    await c.Fetch.enable({
      patterns: KIZEN_DOMAINS.flatMap((d) => [
        { urlPattern: `*://${d}/*`, requestStage: 'Response' },
        { urlPattern: `*://*.${d}/*`, requestStage: 'Response' },
      ]),
    });

    c.on('Fetch.requestPaused', (rawParams: unknown) => {
      void (async () => {
        const params = rawParams as CDPFetchPausedEvent;
        const { requestId, request, responseHeaders, responseStatusCode } = params;
        const url = request.url;

        vb(`Fetch ${String(responseStatusCode ?? '?')} ${url}`);

        const filtered: CDPHeader[] = [];
        let rewroteSetCookie = false;

        for (const h of responseHeaders ?? []) {
          if (CSP_HEADERS.has(h.name.toLowerCase())) {
            continue;
          }

          if (h.name.toLowerCase() === 'set-cookie' && isKizenUrl(url)) {
            const patched = h.value
              .split('\n')
              .map((cookie) => {
                if (!/SameSite=/i.test(cookie)) {
                  return cookie + '; SameSite=None; Secure';
                }

                return cookie.replace(/SameSite=\w+/i, 'SameSite=None');
              })
              .join('\n');

            filtered.push({ name: h.name, value: patched });
            rewroteSetCookie = true;
          } else {
            filtered.push(h);
          }
        }

        if (rewroteSetCookie) {
          vb(`  rewrote Set-Cookie SameSite on ${url}`);
        }

        try {
          const { body, base64Encoded } = await c.Fetch.getResponseBody({ requestId });

          await c.Fetch.fulfillRequest({
            requestId,
            responseCode: responseStatusCode ?? 200,
            responseHeaders: filtered,
            body,
            ...(base64Encoded && { base64Encoded: true }),
          });
        } catch (e) {
          vb(`  fulfillRequest failed (${(e as Error).message}), falling through`);

          try {
            await c.Fetch.continueRequest({ requestId });
          } catch (e2) {
            vb(`  continueRequest also failed (${(e2 as Error).message})`);
          }
        }
      })();
    });

    // ── 2. Periodic SameSite cookie patching ────────────────────────────────────
    cookieTimer = setInterval(() => {
      void (async () => {
        try {
          const { cookies } = await c.Network.getAllCookies();

          let patched = 0;

          for (const cookie of cookies) {
            if (!isKizenUrl(`https://${cookie.domain ?? ''}`)) {
              continue;
            }

            if (cookie.sameSite === 'None') {
              continue;
            }

            const raw = cookie.domain ?? '';
            const bare = raw.startsWith('.') ? raw.slice(1) : raw;

            await c.Network.setCookie({
              url: `https://${bare}`,
              name: cookie.name,
              value: cookie.value,
              domain: raw,
              path: cookie.path ?? '/',
              secure: true,
              ...(cookie.httpOnly !== undefined && { httpOnly: cookie.httpOnly }),
              ...(cookie.expirationDate !== undefined && {
                expires: cookie.expirationDate,
              }),
              sameSite: 'None',
            });

            patched++;
          }

          if (patched > 0) {
            vb(`cookie-patch cycle: updated ${String(patched)} cookie(s) to SameSite=None`);
          }
        } catch (e) {
          vb(`cookie-patch cycle failed: ${(e as Error).message}`);
        }
      })();
    }, 2000);

    // macOS dock clicks on --app= windows open a stray new-tab-page window
    // (Chromium excludes app windows from its "is a browser window open?" check).
    // activate the original app window, then close the intruder. setDiscoverTargets replays
    // existing targets so mainTargetId gets recaptured after a CDP reconnect.
    await c.Target.setDiscoverTargets({ discover: true });

    const handleTarget = (targetInfo: { targetId: string; type: string; url: string }): void => {
      if (targetInfo.type !== 'page') {
        return;
      }

      if (isNewTabUrl(targetInfo.url)) {
        dbg(`closed stray new-tab-page target ${targetInfo.targetId}`);

        if (mainTargetId !== null) {
          void c.Target.activateTarget({ targetId: mainTargetId }).catch(() => {
            /* ignore */
          });
        }

        void c.Target.closeTarget({ targetId: targetInfo.targetId }).catch(() => {
          /* ignore */
        });

        return;
      }

      if (mainTargetId === null) {
        mainTargetId = targetInfo.targetId;
        dbg(`captured main target ${targetInfo.targetId} (${targetInfo.url})`);
      }
    };

    c.on('Target.targetCreated', (rawParams: unknown) => {
      const { targetInfo } = rawParams as CDPTargetCreatedEvent;

      vb(`target +${targetInfo.type} ${targetInfo.targetId} ${targetInfo.url}`);
      handleTarget(targetInfo);
    });

    c.on('Target.targetInfoChanged', (rawParams: unknown) => {
      const { targetInfo } = rawParams as CDPTargetCreatedEvent;

      vb(`target ~${targetInfo.type} ${targetInfo.targetId} ${targetInfo.url}`);
      handleTarget(targetInfo);
    });

    // CDP's underlying WebSocket can drop (sleep/wake, transient failure) while
    // Chrome keeps running. Without reconnect, all interception silently stops.
    c.on('disconnect', () => {
      if (killed || client !== c) {
        return;
      }

      dbg('CDP disconnected');
      client = null;
      clearCookieTimer();
      scheduleReconnect();
    });
  };

  const scheduleReconnect = (): void => {
    if (killed || reconnectTimer !== null) {
      return;
    }

    const delay = Math.min(1000 * 2 ** reconnectAttempt, 10_000);
    const attemptNumber = reconnectAttempt + 1;

    reconnectAttempt++;

    dbg(`CDP reconnect scheduled in ${String(delay)}ms (attempt #${String(attemptNumber)})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;

      void (async () => {
        let c: CDPClient;

        try {
          c = await CDP({ port: cdpPort });
        } catch {
          dbg(`CDP reconnect attempt #${String(attemptNumber)} failed`);
          scheduleReconnect();

          return;
        }

        if (killed) {
          try {
            await c.close();
          } catch {
            /* ignore */
          }

          return;
        }

        client = c;

        try {
          await setupClient(c);
          dbg(`CDP reconnected after ${String(attemptNumber)} attempt(s)`);
          reconnectAttempt = 0;
        } catch {
          if (client === c) {
            client = null;
          }

          try {
            await c.close();
          } catch {
            /* ignore */
          }

          dbg(`CDP reconnect attempt #${String(attemptNumber)} failed during setup`);
          scheduleReconnect();
        }
      })();
    }, delay);
  };

  // Initial CDP connection — Chrome may not be ready immediately. 30 × 300ms
  // (9s total) gives cold starts, slow disks, and Rosetta-translated Chromium
  // a reasonable window before we give up and run without interception.
  const MAX_CDP_ATTEMPTS = 30;
  const CDP_ATTEMPT_DELAY_MS = 300;

  for (let attempt = 0; attempt < MAX_CDP_ATTEMPTS; attempt++) {
    await new Promise<void>((r) => setTimeout(r, CDP_ATTEMPT_DELAY_MS));

    dbg(`CDP connect attempt ${String(attempt + 1)}/${String(MAX_CDP_ATTEMPTS)}`);

    try {
      const c = await CDP({ port: cdpPort });

      client = c;

      if (opts.path) {
        void c.send('Page.navigate', { url: `${baseUrl}${opts.path}` });
      }

      try {
        await setupClient(c);
        dbg('CDP connected');
      } catch {
        if (client === c) {
          client = null;
        }

        try {
          await c.close();
        } catch {
          /* ignore */
        }

        dbg('CDP setup failed after connect');
      }

      break;
    } catch {
      if (attempt === MAX_CDP_ATTEMPTS - 1) {
        // CDP never came up; window still opens, just no CSP rewrite or
        // SameSite cookie patching. Surface this via onWarn so it appears in
        // the TUI even when the user didn't pass --debug.
        const warning = `CDP unavailable after ${String(MAX_CDP_ATTEMPTS)} attempts — viewer running without interception (CSP/cookie rewrites disabled)`;

        dbg(warning);
        opts.onWarn?.(warning);

        return {
          kill: () => {
            chrome.kill();
          },
        };
      }
    }
  }

  if (!client) {
    return {
      kill: () => {
        chrome.kill();
      },
    };
  }

  const kill = (): void => {
    dbg('CDP kill requested — tearing down');
    killed = true;

    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    clearCookieTimer();

    if (client !== null) {
      try {
        void client.close();
      } catch {
        /* ignore */
      }

      client = null;
    }

    chrome.kill();
  };

  return { kill };
}
