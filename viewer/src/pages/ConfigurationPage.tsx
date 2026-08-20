import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState, type FC } from 'react';
import { bundleQueryOptions } from '../bundleQuery.js';
import { Card } from '../components/Card.js';
import type { DeployablePlugin } from '@kizenapps/packager';
import type {
  CompleteSetupLevel,
  RoutablePageConfig,
  SetupAssistantConfig,
  ValueStore,
  UnknownJSON,
  AssistantField,
} from '@kizenapps/engine';
import { AppEngineProvider, SetupAssistantController } from '@kizenapps/engine/react';
import { SetupAssistantRow } from '../components/setup-assistant/SetupAssistantRow.js';
import { JsonConfigEditor } from '../components/setup-assistant/JsonConfigEditor.js';
import { ConfigJsonDialog } from '../components/setup-assistant/ConfigJsonDialog.js';
import { Modal } from '../components/Modal.js';
import { PluginToast } from '../components/PluginToast.js';
import { ToastContext } from '../ToastContext.js';
import { usePluginToast } from '../hooks/usePluginToast.js';
import { PluginViewContent, usePluginView } from '../components/PluginViewContent.js';
import {
  loadConfig,
  saveConfig,
  clearConfig,
  loadUserConfig,
  saveUserConfig,
  clearUserConfig,
  type StoredConfig,
} from '../lib/configStorage.js';
import { PLUGIN_IFRAME_ALLOW } from '../lib/constants.js';
import { hasSetupAssistant, setupAssistantView } from '../lib/setupAssistant.js';
import { createKizenApiClient } from '../lib/kizenApiClient.js';
import { useApi, BASE_URLS, kizenRequestHandler } from '../api.js';
import { useBootstrap } from '../BootstrapContext.js';
import { useObjectLookups } from '../hooks/useObjectLookups.js';
import { useCriticalExceptionDialog } from '../hooks/useCriticalExceptionDialog.js';
import { useCompleteSetup } from '../hooks/useCompleteSetup.js';
import { usePluginConfig, type PluginUserConfig } from '../hooks/usePluginConfig.js';
import { useCredentials } from '../CredentialsContext.js';
import type { PluginBaseConfig } from '../types.js';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';

interface SetupAssistantFormProps {
  config: SetupAssistantConfig;
  apiName: string;
  loadFn: (apiName: string) => StoredConfig | null;
  saveFn: (
    apiName: string,
    rawValues: Record<string, ValueStore>,
    setupAssistantConfig: SetupAssistantConfig,
  ) => void;
  clearFn: (apiName: string) => void;
}

const SetupAssistantFormInner: FC<SetupAssistantFormProps> = ({
  config,
  apiName,
  loadFn,
  saveFn,
  clearFn,
}) => {
  const existing = loadFn(apiName);
  const savedValues = existing?.__kizen_setup_assistant_values;

  const stateRef = useRef<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);

  const { getObjectByAPIName, getCustomObjectDetails } = useObjectLookups();

  const handleStateChange = useCallback((state: Record<string, unknown>) => {
    stateRef.current = state;
  }, []);

  const handleSave = (): void => {
    const rawValues = stateRef.current as Record<string, ValueStore>;

    saveFn(apiName, rawValues, config);

    setSaved(true);

    setTimeout(() => {
      setSaved(false);
    }, 2000);
  };

  const handleReset = (): void => {
    clearFn(apiName);

    window.location.reload();
  };

  return (
    <SetupAssistantController
      config={config}
      value={savedValues as Record<string, UnknownJSON>}
      onStateChange={handleStateChange}
      disabledKeys={[]}
      getObjectByAPIName={getObjectByAPIName}
      getCustomObjectDetails={getCustomObjectDetails}
    >
      <div className="flex flex-col gap-4">
        {config.fields?.map((field) => (
          <SetupAssistantRow
            key={field.key}
            field={field as AssistantField}
            pluginApiName={apiName}
          />
        ))}

        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleSave}
            className="rounded bg-blue-600 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 active:bg-blue-800"
          >
            Save Configuration
          </button>
          <button
            onClick={handleReset}
            className="rounded border border-black/10 px-4 py-1.5 text-[13px] font-medium text-neutral-600 hover:bg-neutral-50 active:bg-neutral-100"
          >
            Reset
          </button>
          {saved && <span className="text-[12px] text-green-600 font-medium">Saved</span>}
        </div>
      </div>
    </SetupAssistantController>
  );
};

const Code: FC<{ children: string }> = ({ children }) => (
  <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">{children}</code>
);

// A view-based assistant owns setup end to end: it saves through
// `this.completeSetup` and ships its own buttons, so nothing here adds a Save.
const SetupAssistantViewInner: FC<{
  page: RoutablePageConfig | undefined;
  viewApiName: string;
}> = ({ page, viewApiName }) => {
  if (!page) {
    return (
      <p className="m-0 rounded border border-dashed border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800">
        This setup assistant delegates to view <Code>{viewApiName}</Code>, which this plugin does
        not define. Add a <Code>{`views/${viewApiName}/`}</Code> component, or drop{' '}
        <Code>view</Code> from the manifest to go back to the declarative assistant.
      </p>
    );
  }

  return (
    <PluginViewContent
      page={page}
      className="h-[520px] w-full overflow-hidden rounded border border-black/10"
      iframeAllow={PLUGIN_IFRAME_ALLOW}
    />
  );
};

const SetupCardDescription: FC<{ level: CompleteSetupLevel; isViewBased: boolean }> = ({
  level,
  isViewBased,
}) => {
  const accessor = level === 'user' ? 'this.userConfig' : 'this.config';

  if (isViewBased) {
    return (
      <>
        Setup for this plugin is a view, so it saves its own{' '}
        {level === 'user' ? 'per-user' : 'business-level'} config by calling{' '}
        <Code>this.completeSetup()</Code> — there is no form or Save button here. Whatever it writes
        becomes <Code>{accessor}</Code>; use View JSON to inspect it.
      </>
    );
  }

  if (level === 'user') {
    return (
      <>
        Configure the per-user setup assistant fields. These values are scoped to the logged-in user
        and exposed to plugin scripts at <Code>{accessor}</Code>.
      </>
    );
  }

  return (
    <>
      Configure the business-level setup assistant fields. These values are shared across the whole
      business and exposed to plugin scripts at <Code>{accessor}</Code>.
    </>
  );
};

interface SetupSurfaceProps extends SetupAssistantFormProps {
  /** Which store `this.completeSetup` writes when the script passes no level. */
  level: CompleteSetupLevel;
  /** The plugin's packaged views/pages, so a view-based assistant can be resolved. */
  views: RoutablePageConfig[];
  userConfigs: PluginUserConfig[];
  onConfigWrite: () => void;
}

const SetupSurface: FC<SetupSurfaceProps> = ({
  config,
  apiName,
  loadFn,
  saveFn,
  clearFn,
  level,
  views,
  userConfigs,
  onConfigWrite,
}) => {
  const bootstrap = useBootstrap();
  const request = useApi();
  const apiClient = useMemo(() => createKizenApiClient(request), [request]);
  const { environment } = useCredentials();
  const baseUrl = BASE_URLS[environment];

  const [showing, setShowing] = useState(false);
  const [show, setShow] = useState(false);

  const { onMonitoringException, dialog: criticalExceptionDialog } = useCriticalExceptionDialog();

  const { toast, showToast, clearToasts } = usePluginToast();

  const onCompleteSetup = useCompleteSetup(level, onConfigWrite);

  const viewApiName = setupAssistantView(config);
  const setupView = usePluginView(views, viewApiName);

  if (!bootstrap) {
    return <FontAwesomeIcon icon={faSpinner} className="animate-spin text-neutral-400" />;
  }

  return (
    <AppEngineProvider
      appPath={baseUrl}
      user={{ id: bootstrap.team.user, crm_client_id: '' }}
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
      onNavigate={() => {
        /* no-op */
      }}
      performFileUpload={() => Promise.resolve({ url: '' })}
      monitoringExceptionHelper={onMonitoringException}
      performRequest={kizenRequestHandler(apiClient)}
      onCompleteSetup={onCompleteSetup}
      modal={{
        showing,
        show,
        showPrompt: () => {
          setShowing(true);

          setShow(true);
        },
        onConfirm: () => {
          setShowing(false);

          setShow(false);
        },
        onHide: () => {
          setShowing(false);

          setShow(false);
        },
      }}
      showToast={showToast}
      clearToasts={clearToasts}
    >
      {({ showPluginModal, derivedModalState, pluginApiName }) => (
        <ToastContext.Provider value={showToast}>
          <PluginToast toast={toast} />
          {viewApiName === undefined ? (
            <SetupAssistantFormInner
              config={config}
              apiName={apiName}
              loadFn={loadFn}
              saveFn={saveFn}
              clearFn={clearFn}
            />
          ) : (
            <SetupAssistantViewInner page={setupView} viewApiName={viewApiName} />
          )}
          <Modal
            show={showPluginModal}
            config={derivedModalState.config}
            pluginApiName={pluginApiName}
            onConfirm={derivedModalState.props.onConfirm}
            onHide={derivedModalState.props.onHide}
            pages={views}
          />
          {criticalExceptionDialog}
        </ToastContext.Provider>
      )}
    </AppEngineProvider>
  );
};

export const ConfigurationPage: FC = () => {
  const { apiName } = useParams({ strict: false });
  const { data: bundle, isLoading, isError } = useQuery(bundleQueryOptions);
  const [jsonDialog, setJsonDialog] = useState<'business' | 'user' | null>(null);

  const app = useMemo(
    () => bundle?.find((a) => a.api_name === apiName) as DeployablePlugin | undefined,
    [bundle, apiName],
  );

  const baseConfig = app?.base_config as PluginBaseConfig | undefined;

  const { configArgs, userConfigs, refreshConfig } = usePluginConfig(
    apiName,
    baseConfig,
    app?.config_template,
  );

  const views = useMemo((): RoutablePageConfig[] => {
    if (!app) {
      return [];
    }

    return app.artifacts.routable_pages.map(
      (page) =>
        ({ ...page, plugin_api_name: app.api_name, args: configArgs }) as RoutablePageConfig,
    );
  }, [app, configArgs]);

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

  const setupAssistant = baseConfig?.setup_assistant;
  const userSetupAssistant = baseConfig?.user_setup_assistant;
  const hasBusinessSetup = hasSetupAssistant(setupAssistant);
  const hasUserSetup = hasSetupAssistant(userSetupAssistant);

  if (!hasBusinessSetup && !hasUserSetup) {
    return (
      <Card>
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-[15px] font-bold text-neutral-900 m-0">Configuration</h2>
            <p className="text-[12px] text-neutral-400 m-0 mt-1">
              Enter plugin configuration as JSON.
            </p>
          </div>
          <JsonConfigEditor apiName={apiName ?? ''} configTemplate={app.config_template} />
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {hasBusinessSetup && setupAssistant && (
        <Card className="lg:flex-1 lg:min-w-0">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[15px] font-bold text-neutral-900 m-0">
                  Business Configuration
                </h2>
                <p className="text-[12px] text-neutral-400 m-0 mt-1">
                  <SetupCardDescription
                    level="business"
                    isViewBased={setupAssistantView(setupAssistant) !== undefined}
                  />
                </p>
              </div>
              <button
                onClick={() => {
                  setJsonDialog('business');
                }}
                className="shrink-0 rounded border border-black/10 px-3 py-1.5 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50 active:bg-neutral-100"
              >
                View JSON
              </button>
            </div>
            <SetupSurface
              config={setupAssistant}
              apiName={apiName ?? ''}
              loadFn={loadConfig}
              saveFn={saveConfig}
              clearFn={clearConfig}
              level="business"
              views={views}
              userConfigs={userConfigs}
              onConfigWrite={refreshConfig}
            />
          </div>
        </Card>
      )}

      {hasUserSetup && userSetupAssistant && (
        <Card className="lg:flex-1 lg:min-w-0">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[15px] font-bold text-neutral-900 m-0">User Configuration</h2>
                <p className="text-[12px] text-neutral-400 m-0 mt-1">
                  <SetupCardDescription
                    level="user"
                    isViewBased={setupAssistantView(userSetupAssistant) !== undefined}
                  />
                </p>
              </div>
              <button
                onClick={() => {
                  setJsonDialog('user');
                }}
                className="shrink-0 rounded border border-black/10 px-3 py-1.5 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50 active:bg-neutral-100"
              >
                View JSON
              </button>
            </div>
            <SetupSurface
              config={userSetupAssistant}
              apiName={apiName ?? ''}
              loadFn={loadUserConfig}
              saveFn={saveUserConfig}
              clearFn={clearUserConfig}
              level="user"
              views={views}
              userConfigs={userConfigs}
              onConfigWrite={refreshConfig}
            />
          </div>
        </Card>
      )}

      <ConfigJsonDialog
        open={jsonDialog === 'business'}
        onClose={() => {
          setJsonDialog(null);
        }}
        apiName={apiName ?? ''}
        loadFn={loadConfig}
        label="this.config"
      />
      <ConfigJsonDialog
        open={jsonDialog === 'user'}
        onClose={() => {
          setJsonDialog(null);
        }}
        apiName={apiName ?? ''}
        loadFn={loadUserConfig}
        label="this.userConfig"
      />
    </div>
  );
};
