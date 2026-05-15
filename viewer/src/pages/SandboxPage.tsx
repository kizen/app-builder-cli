import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, useEffect, useRef, type FC, type RefObject } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage.js';
import { STORAGE_KEYS } from '../lib/storageKeys.js';
import { useSidebarWidth } from '../SidebarContext.js';
import { bundleQueryOptions } from '../bundleQuery.js';
import { Card } from '../components/Card.js';
import { Frame } from '../components/Frame.js';
import { JsActionSection } from '../components/JsActionSection.js';
import { DataAdornmentSection } from '../components/DataAdornmentSection.js';
import { RoutablePageBrowser, type BrowserHandle } from '../components/RoutablePageBrowser.js';
import { ToolbarItem } from '../components/ToolbarItem.js';
import { ObjectSettingsMenuItemSection } from '../components/ObjectSettingsMenuItemSection.js';
import { ServiceSection } from '../components/ServiceSection.js';
import { CalendarSourceSection } from '../components/CalendarSourceSection.js';
import { Modal } from '../components/Modal.js';
import { useCriticalExceptionDialog } from '../hooks/useCriticalExceptionDialog.js';
import { loadConfig, loadUserConfig, resolveEffectiveConfig } from '../lib/configStorage.js';
import { createKizenApiClient } from '../lib/kizenApiClient.js';
import type { PluginBaseConfig } from '../types.js';
import type {
  CalendarSourceConfig,
  FloatingFrameConfig,
  RoutablePageConfig,
  ToolbarItemConfig,
  UnknownJSON,
} from '@kizenapps/engine';
import { mergeConfig } from '@kizenapps/engine/util';
import { AppEngineProvider } from '@kizenapps/engine/react';
import { useBootstrap } from '../BootstrapContext.js';
import { useApi, BASE_URLS, kizenRequestHandler } from '../api.js';
import { useCredentials } from '../CredentialsContext.js';
import { ToastContext, type ShowToastFn } from '../ToastContext.js';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinner, faCircleInfo } from '@fortawesome/free-solid-svg-icons';

const GUTTER_WIDTH = 56;

const NotInstalledNotice: FC = () => (
  <div className="flex items-start gap-2 rounded border border-amber-200/60 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800">
    <FontAwesomeIcon icon={faCircleInfo} className="mt-0.5 text-[11px]" />
    <span>Please install the plugin in order to test.</span>
  </div>
);

const SandboxPageInner: FC<{
  showingToast: { message: string; variant?: string } | null;
  browserRef: RefObject<BrowserHandle | null>;
  routablePages: RoutablePageConfig[];
}> = ({ showingToast, browserRef, routablePages }) => {
  const { apiName } = useParams({ strict: false });

  const sidebarWidth = useSidebarWidth();

  const [framesEnabled, setFramesEnabled] = useLocalStorage(
    STORAGE_KEYS.sandboxFramesEnabled,
    false,
  );

  const toggleFrames = setFramesEnabled;

  const { data: bundle, isLoading, isError } = useQuery(bundleQueryOptions);

  const bootstrap = useBootstrap();

  const effectiveConfig = useMemo(() => {
    if (!apiName || !bundle) {
      return null;
    }

    const matched = bundle.find((a) => a.api_name === apiName);

    return resolveEffectiveConfig(apiName, matched?.config_template);
  }, [apiName, bundle]);

  const whenState = useMemo((): Record<string, UnknownJSON> => {
    if (!apiName || !bundle) {
      return {};
    }

    const app = bundle.find((a) => a.api_name === apiName);

    if (!app) {
      return {};
    }

    const baseConfig = app.base_config as PluginBaseConfig | undefined;
    const stored = loadConfig(apiName);
    const storedUser = loadUserConfig(apiName);

    const mergedConfig = mergeConfig(
      (stored?.__kizen_clean_config ?? {}) as Record<string, UnknownJSON>,
      [],
      (stored?.__kizen_setup_assistant_values ?? {}) as Record<string, UnknownJSON>,
      baseConfig?.setup_assistant?.fields,
    );
    const mergedUserConfig = mergeConfig(
      (storedUser?.__kizen_clean_config ?? {}) as Record<string, UnknownJSON>,
      [],
      (storedUser?.__kizen_setup_assistant_values ?? {}) as Record<string, UnknownJSON>,
      baseConfig?.user_setup_assistant?.fields,
    );

    const state: Record<string, UnknownJSON> = {};

    for (const [k, v] of Object.entries(mergedConfig)) {
      state[`config__${k}`] = v;
    }

    for (const [k, v] of Object.entries(mergedUserConfig)) {
      state[`userConfig__${k}`] = v;
    }

    return state;
  }, [apiName, bundle]);

  if (isLoading) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-400">Fetching bundle.json…</p>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-red-700">Could not load bundle.json.</p>
      </Card>
    );
  }

  const app = bundle?.find((a) => a.api_name === apiName);

  if (!app) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-500">
          No app found with api_name{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5">{apiName}</code>.
        </p>
      </Card>
    );
  }

  const baseConfig = app.base_config as PluginBaseConfig | undefined;
  const hasSetupAssistant =
    (baseConfig?.setup_assistant?.fields?.length ?? 0) > 0 ||
    (baseConfig?.user_setup_assistant?.fields?.length ?? 0) > 0;

  const configArgs: Record<string, unknown> = effectiveConfig
    ? hasSetupAssistant
      ? { __kizen_clean_config: effectiveConfig }
      : { ...effectiveConfig }
    : {};

  const floatingFrames = app.artifacts.floating_frames.map(
    (frame) =>
      ({ ...frame, plugin_api_name: app.api_name, args: configArgs }) as FloatingFrameConfig,
  );
  // Inject plugin_api_name — packager types omit it, but the engine needs it so that
  // this.communicate.runFrameScript (and other cross-plugin communication) can match
  // the recipient floating frame's plugin_api_name check.
  const toolbarItems = app.artifacts.toolbar_items.map(
    (item) => ({ ...item, plugin_api_name: app.api_name, args: configArgs }) as ToolbarItemConfig,
  );
  const jsActions = app.artifacts.js_action_templates.map((action) => ({
    ...action,
    plugin_api_name: app.api_name,
    args: configArgs,
  }));
  const objectSettingsMenuItems = app.artifacts.object_settings_menu_items.map((item) => ({
    ...item,
    plugin_api_name: app.api_name,
    args: configArgs,
  }));
  const dataAdornments = app.artifacts.data_adornments.map((adornment) => ({
    ...adornment,
    plugin_api_name: app.api_name,
    args: configArgs,
  }));

  const calendarSources = app.artifacts.calendar_sources.map(
    (source) =>
      ({ ...source, plugin_api_name: app.api_name, args: configArgs }) as CalendarSourceConfig,
  );

  const hasAnyControls =
    toolbarItems.length > 0 ||
    jsActions.length > 0 ||
    objectSettingsMenuItems.length > 0 ||
    dataAdornments.length > 0;

  const isInstalled =
    bootstrap?.enabled_plugin_apps.some((p) => p.api_name === app.api_name) ?? false;

  return (
    <>
      {showingToast && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-20 rounded px-4 py-2 text-sm font-medium ${
            {
              success: 'bg-green-100 text-green-700',
              error: 'bg-red-100 text-red-700',
              failure: 'bg-red-100 text-red-700',
              alert: 'bg-amber-100 text-amber-700',
            }[showingToast.variant ?? 'success'] ?? 'bg-green-100 text-green-700'
          }`}
        >
          {showingToast.message}
        </div>
      )}

      <div style={{ paddingRight: floatingFrames.length > 0 ? GUTTER_WIDTH : 0 }}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
            {hasAnyControls && (
              <div className="flex flex-col gap-4 xl:flex-1 xl:min-w-0">
                {toolbarItems.length > 0 && (
                  <Card>
                    <div className="mb-3">
                      <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-600">
                        Toolbar Items
                      </span>
                      <p className="mt-1 text-[12px] text-neutral-400">
                        Click a button to run its script in the context of a generic app view.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {toolbarItems.map((item) => (
                        <ToolbarItem key={item.api_name} item={item} whenState={whenState} />
                      ))}
                    </div>
                  </Card>
                )}

                {jsActions.length > 0 && (
                  <Card>
                    <div className="mb-3">
                      <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-600">
                        JS Action Templates
                      </span>
                      <p className="mt-1 text-[12px] text-neutral-400">
                        Select a record and trigger a JS action to test its script with real data.
                      </p>
                    </div>
                    <JsActionSection
                      actions={jsActions}
                      pluginApiName={app.api_name}
                      configArgs={configArgs}
                    />
                  </Card>
                )}

                {objectSettingsMenuItems.length > 0 && (
                  <Card>
                    <div className="mb-3">
                      <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-600">
                        Object Settings Menu Items
                      </span>
                      <p className="mt-1 text-[12px] text-neutral-400">
                        Select a custom object and click an item to run its script against that
                        object.
                      </p>
                    </div>
                    <ObjectSettingsMenuItemSection
                      items={objectSettingsMenuItems}
                      pluginApiName={app.api_name}
                      configArgs={configArgs}
                      whenState={whenState}
                    />
                  </Card>
                )}

                {dataAdornments.length > 0 && (
                  <Card>
                    <div className="mb-3">
                      <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-600">
                        Data Adornments
                      </span>
                      <p className="mt-1 text-[12px] text-neutral-400">
                        Select an object and record, then click an adornment to run its script
                        against a specific field value.
                      </p>
                    </div>
                    <DataAdornmentSection
                      adornments={dataAdornments}
                      pluginApiName={app.api_name}
                      configArgs={configArgs}
                      whenState={whenState}
                    />
                  </Card>
                )}
              </div>
            )}

            <div className="min-w-0 flex-1 flex flex-col gap-4">
              <Card>
                <div className="mb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-600">
                    Routable Pages
                  </span>
                  <p className="mt-1 text-[12px] text-neutral-400">
                    {routablePages.length > 0
                      ? 'Navigate between pages as they would appear when embedded in Kizen.'
                      : 'No routable pages are defined in this plugin.'}
                  </p>
                </div>
                <RoutablePageBrowser ref={browserRef} pages={routablePages} />
              </Card>

              {calendarSources.length > 0 && (
                <Card>
                  <div className="mb-3">
                    <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-600">
                      Calendar Sources
                    </span>
                    <p className="mt-1 text-[12px] text-neutral-400">
                      Pick calendars from each source and navigate the grid to run its{' '}
                      <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
                        calendars_script
                      </code>{' '}
                      and{' '}
                      <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
                        events_script
                      </code>
                      . Click an event to inspect the raw payload.
                    </p>
                  </div>
                  {isInstalled ? (
                    <CalendarSourceSection
                      calendarSources={calendarSources}
                      pluginApiName={app.api_name}
                      whenState={whenState}
                    />
                  ) : (
                    <NotInstalledNotice />
                  )}
                </Card>
              )}
            </div>
          </div>

          {(app.services?.length ?? 0) > 0 && (
            <ServiceSection
              services={app.services ?? []}
              pluginApiName={app.api_name}
              isInstalled={isInstalled}
            />
          )}
        </div>
      </div>

      {floatingFrames.length > 0 && (
        <div className="pointer-events-none fixed inset-0">
          {/* Right-side gutter for circle triggers */}
          <div
            className="absolute inset-y-0 flex w-14 flex-col-reverse items-center gap-2 border-l border-black/8 bg-white/60 pb-4 backdrop-blur-sm"
            style={{ right: sidebarWidth }}
          >
            {floatingFrames.map((frame) => (
              <div key={frame.api_name} className="flex flex-col items-center">
                <div id={`${frame.plugin_api_name}-${frame.api_name}-trigger-left`} />
                <div id={`${frame.plugin_api_name}-${frame.api_name}-trigger-right`} />
              </div>
            ))}
            <strong className="text-[9px] uppercase tracking-widest text-neutral-400">
              Frames
            </strong>
            <label className="flex flex-col items-center gap-0.5 cursor-pointer pointer-events-auto">
              <input
                type="checkbox"
                className="h-3 w-3 cursor-pointer accent-neutral-600"
                checked={framesEnabled}
                onChange={(e) => {
                  toggleFrames(e.target.checked);
                }}
              />
              <span className="text-[8px] uppercase tracking-widest text-neutral-400 text-center leading-tight">
                enable
                <br />
                frames
              </span>
            </label>
          </div>
          {floatingFrames.map((frame) => (
            <Frame
              key={frame.api_name}
              frame={frame}
              framesEnabled={framesEnabled}
              whenState={whenState}
            />
          ))}
        </div>
      )}
    </>
  );
};

export const SandboxPage: FC = () => {
  const [showingToast, setShowingToast] = useState<{ message: string; variant?: string } | null>(
    null,
  );
  const [showing, setShowing] = useState(false);
  const [show, setShow] = useState(false);
  const browserRef = useRef<BrowserHandle>(null);

  useEffect(() => {
    const original = window.open;

    window.open = (url?: string | URL): null => {
      browserRef.current?.openNewTab(String(url ?? ''));

      return null;
    };

    return () => {
      window.open = original;
    };
  }, []);

  useEffect(() => {
    if (!showingToast) {
      return;
    }

    const timer = setTimeout(() => {
      setShowingToast(null);
    }, 5000);

    return () => {
      clearTimeout(timer);
    };
  }, [showingToast]);

  const { apiName } = useParams({ strict: false });
  const { data: bundle } = useQuery(bundleQueryOptions);
  const bootstrap = useBootstrap();
  const request = useApi();
  const apiClient = useMemo(() => createKizenApiClient(request), [request]);
  const { environment } = useCredentials();
  const baseUrl = BASE_URLS[environment];

  const userConfigs = useMemo(() => {
    if (!apiName) {
      return [];
    }

    const stored = loadUserConfig(apiName);

    if (!stored?.__kizen_clean_config) {
      return [];
    }

    return [
      {
        api_name: apiName,
        config: { __kizen_clean_config: stored.__kizen_clean_config } as UnknownJSON,
      },
    ];
  }, [apiName]);

  const routablePages = useMemo((): RoutablePageConfig[] => {
    if (!bundle || !apiName) {
      return [];
    }

    const app = bundle.find((a) => a.api_name === apiName);

    if (!app) {
      return [];
    }

    const baseConfig = app.base_config as PluginBaseConfig | undefined;
    const hasSetupAssistant =
      (baseConfig?.setup_assistant?.fields?.length ?? 0) > 0 ||
      (baseConfig?.user_setup_assistant?.fields?.length ?? 0) > 0;
    const effectiveConfig = resolveEffectiveConfig(apiName, app.config_template);
    const configArgs: Record<string, unknown> = effectiveConfig
      ? hasSetupAssistant
        ? { __kizen_clean_config: effectiveConfig }
        : { ...effectiveConfig }
      : {};

    return app.artifacts.routable_pages.map(
      (page) =>
        ({ ...page, plugin_api_name: app.api_name, args: configArgs }) as RoutablePageConfig,
    );
  }, [bundle, apiName]);

  const showPrompt = (): void => {
    setShowing(true);

    setShow(true);
  };

  const onConfirm = (): void => {
    setShowing(false);

    setShow(false);
  };

  const onHide = (): void => {
    setShowing(false);

    setShow(false);
  };

  const { onMonitoringException, dialog: criticalExceptionDialog } = useCriticalExceptionDialog();

  const showToast: ShowToastFn = ({ message, variant }) => {
    setShowingToast({ message, variant: variant ?? 'success' });
  };

  if (!bootstrap) {
    return <FontAwesomeIcon icon={faSpinner} className="animate-spin text-neutral-400" size="2x" />;
  }

  return (
    <AppEngineProvider
      appPath={baseUrl}
      user={{
        id: bootstrap.team.user,
        crm_client_id: '',
      }}
      business={bootstrap.business}
      userConfigs={userConfigs}
      clientObject={
        bootstrap.business.client_object
          ? {
              id: bootstrap.business.client_object.id,
              objectName: bootstrap.business.client_object.object_name,
            }
          : undefined
      }
      teamMember={bootstrap.team}
      onNavigate={(path, options) => {
        browserRef.current?.navigate(path, options);
      }}
      performFileUpload={({ file }) => {
        // Dev viewer stub: inline the upload as a data URL instead of calling
        // Kizen's file service. Lets plugins exercise the upload flow locally
        // without needing to configure storage credentials.
        return new Promise((resolve, reject) => {
          const reader = new FileReader();

          reader.onload = () => {
            resolve({ url: reader.result as string });
          };

          reader.onerror = reject;

          reader.readAsDataURL(file);
        });
      }}
      monitoringExceptionHelper={onMonitoringException}
      performRequest={kizenRequestHandler(apiClient)}
      modal={{ showing, show, showPrompt, onConfirm, onHide }}
      showToast={showToast}
      clearToasts={() => {
        setShowingToast(null);
      }}
    >
      {({ showPluginModal, derivedModalState, pluginApiName }) => (
        <ToastContext.Provider value={showToast}>
          <SandboxPageInner
            showingToast={showingToast}
            browserRef={browserRef}
            routablePages={routablePages}
          />
          <Modal
            show={showPluginModal}
            config={derivedModalState.config}
            pluginApiName={pluginApiName}
            onConfirm={derivedModalState.props.onConfirm}
            onHide={derivedModalState.props.onHide}
            pages={routablePages}
          />
          {criticalExceptionDialog}
        </ToastContext.Provider>
      )}
    </AppEngineProvider>
  );
};
