import { Outlet, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FC, lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faLock,
  faTerminal,
  faRotateRight,
  faBug,
  faPuzzlePiece,
} from '@fortawesome/free-solid-svg-icons';
import { bundleQueryOptions } from './bundleQuery.js';
import { APP_URLS, BASE_URLS } from './api.js';
import { bootstrapQueryOptions } from './bootstrapQuery.js';
import { businessPluginAppsQueryOptions } from './businessPluginAppsQuery.js';
import type { BusinessPluginApp } from './businessPluginAppsQuery.js';
import { useDevReload } from './useDevReload.js';
import { SidebarContext } from './SidebarContext.js';
import { VenvInstallDialog } from './components/VenvInstallDialog.js';
import { AppSelector } from './components/AppSelector.js';
import { NavTabs } from './components/NavTabs.js';
import { Dialog, DialogHeader } from './components/Dialog.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

const DevSidebar = lazy(() =>
  import('./components/DevSidebar.js').then((m) => ({ default: m.DevSidebar })),
);

import { CredentialsContext, type Credentials } from './CredentialsContext.js';
import { BootstrapContext } from './BootstrapContext.js';
import type { BootstrapData } from './BootstrapContext.js';
import { STORAGE_KEYS, setCredentialPrefix } from './lib/storageKeys.js';
import { pushConsole, type ConsoleEntry } from './consoleCapture.js';

// Capture before SandboxPage can override window.open for plugin intercepts
const nativeOpen = window.open.bind(window);

const DEFAULT_SIDEBAR_WIDTH = 416;
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 800;

const EMPTY_CREDENTIALS: Credentials = {
  apiKey: '',
  userId: '',
  businessId: '',
  environment: 'go',
};

class PluginNotPublishedError extends Error {
  constructor() {
    super('Plugin app with this API name does not exist.');
    this.name = 'PluginNotPublishedError';
  }
}

const isPluginNotPublishedBody = (body: unknown): boolean => {
  if (body === null || typeof body !== 'object') {
    return false;
  }

  const field = (body as { plugin_app_api_name?: unknown }).plugin_app_api_name;

  if (!Array.isArray(field)) {
    return false;
  }

  return field.some((msg) => typeof msg === 'string' && msg.includes('does not exist'));
};

const CAPTURE_LEVELS: ReadonlySet<string> = new Set(['log', 'warn', 'error', 'info']);

window.console = new Proxy(window.console, {
  get(target, prop) {
    const orig: unknown = Reflect.get(target, prop);

    if (typeof orig === 'function') {
      const fn = orig as (...a: unknown[]) => unknown;

      return function (...args: unknown[]) {
        if (typeof prop === 'string' && CAPTURE_LEVELS.has(prop)) {
          pushConsole({ level: prop as ConsoleEntry['level'], args });
        }

        return fn.apply(target, args);
      };
    }

    return orig;
  },
});

export const App: FC = () => {
  const {
    buildLogs,
    proxyLogs,
    consoleLogs,
    clearConsoleLogs,
    serverCredentials,
    serverActiveProfile,
    venvInstall,
    dismissVenvInstall,
  } = useDevReload();

  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.sidebarOpen) === 'true',
  );

  const [scriptRunnerDebug, setScriptRunnerDebug] = useState(
    () => localStorage.getItem(STORAGE_KEYS.scriptRunnerLogging) === 'true',
  );

  const [showPublishRequiredDialog, setShowPublishRequiredDialog] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem(STORAGE_KEYS.sidebarWidth) ?? '', 10);

    return isNaN(saved)
      ? DEFAULT_SIDEBAR_WIDTH
      : Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, saved));
  });

  const toggleSidebar = (): void => {
    setSidebarOpen((prev) => {
      const next = !prev;

      localStorage.setItem(STORAGE_KEYS.sidebarOpen, String(next));

      return next;
    });
  };

  const toggleScriptRunnerDebug = (): void => {
    setScriptRunnerDebug((prev) => {
      const next = !prev;

      localStorage.setItem(STORAGE_KEYS.scriptRunnerLogging, String(next));

      return next;
    });
  };

  const handleSidebarWidthChange = useCallback((w: number): void => {
    setSidebarWidth(w);

    localStorage.setItem(STORAGE_KEYS.sidebarWidth, String(w));
  }, []);

  const [credentials, setCredentials] = useState<Credentials>(() => {
    try {
      return {
        ...EMPTY_CREDENTIALS,
        ...JSON.parse(localStorage.getItem(STORAGE_KEYS.credentials) ?? '{}'),
      } as Credentials;
    } catch {
      return EMPTY_CREDENTIALS;
    }
  });

  useEffect(() => {
    void fetch('/api/credentials')
      .then((res) => res.json())
      .then((data: { credentials: Partial<Credentials> | null; activeProfile: string | null }) => {
        if (data.credentials?.apiKey) {
          const merged = { ...EMPTY_CREDENTIALS, ...data.credentials } as Credentials;

          setCredentialPrefix(data.activeProfile);
          setCredentials(merged);

          localStorage.setItem(STORAGE_KEYS.credentials, JSON.stringify(merged));
        }
      })
      .catch(() => {
        // ignore — fall back to localStorage state already set above
      });
  }, []);

  useEffect(() => {
    if (!serverCredentials) {
      return;
    }

    const merged = { ...EMPTY_CREDENTIALS, ...serverCredentials } as Credentials;

    setCredentialPrefix(serverActiveProfile);
    setCredentials(merged);

    localStorage.setItem(STORAGE_KEYS.credentials, JSON.stringify(merged));
  }, [serverCredentials, serverActiveProfile]);

  const handleCredentialsChange = (next: Credentials): void => {
    setCredentials(next);

    localStorage.setItem(STORAGE_KEYS.credentials, JSON.stringify(next));
  };

  const {
    data: bundle,
    isLoading: isLoadingBundle,
    isError: isErrorBundle,
  } = useQuery(bundleQueryOptions);

  const {
    data: bootstrapData,
    isError,
    isLoading,
  } = useQuery<BootstrapData>(bootstrapQueryOptions(credentials));

  const { data: businessPluginApps } = useQuery<BusinessPluginApp[]>(
    businessPluginAppsQueryOptions(credentials),
  );

  const queryClient = useQueryClient();

  const pluginMutation = useMutation({
    mutationFn: async ({
      apiName,
      hasExistingEntry,
      nextDisabled,
    }: {
      apiName: string;
      hasExistingEntry: boolean;
      nextDisabled: boolean;
    }): Promise<void> => {
      const baseHeaders = {
        'x-proxy-target': BASE_URLS[credentials.environment],
        'X-API-KEY': credentials.apiKey,
        'X-USER-ID': credentials.userId,
        'X-BUSINESS-ID': credentials.businessId,
        'Content-Type': 'application/json',
      };

      // If the plugin has ever been installed, a BusinessPluginApp row exists
      // (even when disabled). POST will 400 on re-create, so PATCH to toggle.
      const res = hasExistingEntry
        ? await fetch(`/api/proxy/external-integrations/business-plugin-apps/${apiName}`, {
            method: 'PATCH',
            headers: baseHeaders,
            body: JSON.stringify({ disabled: nextDisabled }),
          })
        : await fetch('/api/proxy/external-integrations/business-plugin-apps', {
            method: 'POST',
            headers: baseHeaders,
            body: JSON.stringify({
              plugin_app_api_name: apiName,
              disabled: false,
              config: {},
            }),
          });

      if (!res.ok) {
        const action = nextDisabled ? 'uninstall' : 'install';

        if (res.status === 400 && action === 'install') {
          const body = (await res.json().catch(() => null)) as unknown;

          if (isPluginNotPublishedBody(body)) {
            throw new PluginNotPublishedError();
          }

          throw new Error(
            `${action} failed: ${String(res.status)} ${res.statusText} ${JSON.stringify(body)}`,
          );
        }

        const text = await res.text().catch(() => '');

        throw new Error(`${action} failed: ${String(res.status)} ${res.statusText} ${text}`);
      }
    },
    onError: (err) => {
      if (err instanceof PluginNotPublishedError) {
        setShowPublishRequiredDialog(true);
      }
    },
    onSuccess: async () => {
      // The dev server proxy caches GET responses by URL. Clear it so the
      // refetched bootstrap/business-plugin-apps queries don't see stale data.
      await fetch('/api/proxy-cache/clear').catch(() => {
        // non-fatal — refetch will still happen, may just be stale
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['businessPluginApps'] }),
      ]);
    },
  });

  const { location } = useRouterState();
  const currentApiName = /^\/([^/]+)\/.+/.exec(location.pathname)?.[1];
  const currentSubPage = /^\/[^/]+\/([^/]+)/.exec(location.pathname)?.[1];

  useEffect(() => {
    if (location.pathname !== '/') {
      void fetch('/api/last-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: location.pathname }),
      });
    }
  }, [location.pathname]);

  const currentApp = currentApiName
    ? bundle?.find((a) => a.api_name === currentApiName)
    : undefined;
  const hasCodeSteps = (currentApp?.artifacts.automation_action_configs.length ?? 0) > 0;

  const currentPluginInBundle =
    !!currentApiName && !!bundle?.some((app) => app.api_name === currentApiName);
  const existingPluginEntry = currentApiName
    ? businessPluginApps?.find((p) => p.plugin_app.api_name === currentApiName)
    : undefined;
  const isInstalled = !!existingPluginEntry && !existingPluginEntry.disabled;
  const showInstallBadge = !!bootstrapData && !!businessPluginApps && currentPluginInBundle;
  const installBadgeLabel = pluginMutation.isPending
    ? isInstalled
      ? 'uninstalling…'
      : 'installing…'
    : isInstalled
      ? 'Uninstall Plugin'
      : 'Install Plugin';
  const installBadgeClass = pluginMutation.isPending ? 'cursor-wait opacity-50' : '';

  const badgeLabel = isLoadingBundle
    ? 'loading'
    : isErrorBundle
      ? 'error'
      : !bundle
        ? 'empty'
        : 'loaded';

  const bootstrapBadgeLabel = isLoading
    ? 'authenticating'
    : isError
      ? 'auth error'
      : !bootstrapData
        ? 'no auth'
        : 'authenticated';

  const badgeClass = isLoadingBundle
    ? 'bg-neutral-100 text-neutral-400'
    : isErrorBundle
      ? 'bg-red-100 text-red-700'
      : !bundle
        ? 'bg-yellow-100 text-yellow-700'
        : 'bg-green-100 text-green-700';

  const bootstrapBadgeClass = isLoading
    ? 'bg-neutral-100 text-neutral-400'
    : isError
      ? 'bg-red-100 text-red-700'
      : !bootstrapData
        ? 'bg-yellow-100 text-yellow-700'
        : 'bg-green-100 text-green-700';

  return (
    <CredentialsContext.Provider value={credentials}>
      <SidebarContext.Provider value={sidebarOpen ? sidebarWidth : 0}>
        <BootstrapContext.Provider value={bootstrapData}>
          <div className="flex h-screen flex-col overflow-hidden font-mono">
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 sm:gap-3 border-b border-black/10 bg-white/85 px-3 py-2 sm:px-5 sm:py-3 backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <img src="/mark.svg" alt="Kizen" className="h-5 w-5" />
              </div>
              {bundle && bundle.length > 0 && (
                <AppSelector bundle={bundle} currentApiName={currentApiName} />
              )}
              <div className="flex-1" />
              <button
                onClick={() => {
                  window.location.reload();
                }}
                className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-medium text-neutral-500 hover:border-black/20 hover:text-neutral-800"
                aria-label="Refresh page"
              >
                <FontAwesomeIcon icon={faRotateRight} />
                <span className="hidden lg:inline">Refresh</span>
              </button>
              <button
                onClick={() => {
                  nativeOpen(APP_URLS[credentials.environment], '_blank', 'noopener,height=900');
                }}
                className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-medium text-neutral-500 hover:border-black/20 hover:text-neutral-800"
                aria-label="Open Kizen"
              >
                <FontAwesomeIcon icon={faLock} />
                <span className="hidden lg:inline">Open Kizen</span>
              </button>
              <button
                onClick={toggleScriptRunnerDebug}
                className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-medium text-neutral-500 hover:border-black/20 hover:text-neutral-800"
                aria-label="Toggle script runner debug logging"
              >
                <FontAwesomeIcon icon={faBug} />
                <span className="hidden lg:inline">Script Runner Logging</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${scriptRunnerDebug ? 'bg-green-500' : 'bg-neutral-300'}`}
                />
              </button>
              <button
                onClick={toggleSidebar}
                className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-medium text-neutral-500 hover:border-black/20 hover:text-neutral-800"
                aria-label="Toggle dev tools"
              >
                <FontAwesomeIcon icon={faTerminal} />
                <span className="hidden lg:inline">DevTools</span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${sidebarOpen ? 'bg-green-500' : 'bg-neutral-300'}`}
                />
              </button>
              {showInstallBadge && currentApiName && (
                <button
                  type="button"
                  disabled={pluginMutation.isPending}
                  onClick={() => {
                    pluginMutation.mutate({
                      apiName: currentApiName,
                      hasExistingEntry: !!existingPluginEntry,
                      nextDisabled: isInstalled,
                    });
                  }}
                  className={`flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-medium text-neutral-500 transition-colors hover:border-black/20 hover:text-neutral-800 ${installBadgeClass}`}
                  aria-label={installBadgeLabel}
                >
                  <FontAwesomeIcon icon={faPuzzlePiece} />
                  <span className="hidden lg:inline">{installBadgeLabel}</span>
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${isInstalled ? 'bg-green-500' : 'bg-neutral-300'}`}
                  />
                </button>
              )}
              <span
                className={`hidden sm:inline rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide ${badgeClass}`}
              >
                {badgeLabel}
              </span>
              <span
                className={`hidden sm:inline rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide ${bootstrapBadgeClass}`}
              >
                {bootstrapBadgeLabel}
              </span>
            </div>

            {currentApiName && (
              <NavTabs
                currentApiName={currentApiName}
                currentSubPage={currentSubPage}
                hasCodeSteps={hasCodeSteps}
              />
            )}

            <div className="flex min-h-0 flex-1">
              <div
                className="flex-1 overflow-y-auto p-6"
                style={{
                  backgroundImage: `
              linear-gradient(rgba(0,0,0,0.025) 1px, transparent 1px),
              linear-gradient(90deg, rgba(0,0,0,0.025) 1px, transparent 1px)
            `,
                  backgroundSize: '24px 24px',
                }}
              >
                <ErrorBoundary
                  fallback={(err) => (
                    <div className="mx-auto max-w-md rounded border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">
                      <p className="m-0 font-semibold">Failed to render this view.</p>
                      <p className="m-0 mt-1 text-red-700">{err.message}</p>
                      <p className="m-0 mt-2 text-red-600">Reload the page to recover.</p>
                    </div>
                  )}
                >
                  <Suspense fallback={null}>
                    <Outlet />
                  </Suspense>
                </ErrorBoundary>
              </div>
              {sidebarOpen && (
                <ErrorBoundary
                  fallback={
                    <aside className="flex w-[280px] shrink-0 flex-col border-l border-black/10 bg-white p-4 text-[12px] text-red-800">
                      <p className="m-0 font-semibold">DevTools failed to load.</p>
                      <p className="m-0 mt-1 text-red-700">Reload the page to try again.</p>
                    </aside>
                  }
                >
                  <Suspense fallback={null}>
                    <DevSidebar
                      onClose={toggleSidebar}
                      buildLogs={buildLogs}
                      proxyLogs={proxyLogs}
                      consoleLogs={consoleLogs}
                      onClearConsole={() => {
                        clearConsoleLogs();
                      }}
                      credentials={credentials}
                      onCredentialsChange={handleCredentialsChange}
                      width={sidebarWidth}
                      onWidthChange={handleSidebarWidthChange}
                    />
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
            <VenvInstallDialog state={venvInstall} onDismiss={dismissVenvInstall} />
            <Dialog
              open={showPublishRequiredDialog}
              size="md"
              onBackdropClick={() => {
                setShowPublishRequiredDialog(false);
                pluginMutation.reset();
              }}
              header={<DialogHeader title="App not published" />}
              footer={
                <button
                  onClick={() => {
                    setShowPublishRequiredDialog(false);
                    pluginMutation.reset();
                  }}
                  className="rounded bg-neutral-900 px-3 py-1.5 text-[12px] text-white transition-colors hover:bg-neutral-700"
                >
                  OK
                </button>
              }
            >
              <div className="px-5 py-4">
                <p className="m-0 text-[13px] text-neutral-700">
                  This app must have been published at least once in order to install in your
                  business.
                </p>
                <p className="m-0 text-[13px] text-neutral-700">
                  After the initial publish, you can enable the app in your business and try again.
                </p>
              </div>
            </Dialog>
          </div>
        </BootstrapContext.Provider>
      </SidebarContext.Provider>
    </CredentialsContext.Provider>
  );
};
