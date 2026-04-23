import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState, type FC } from 'react';
import { bundleQueryOptions } from '../bundleQuery.js';
import { Card } from '../components/Card.js';
import type { DeployablePlugin } from '@kizenapps/packager';
import type {
  SetupAssistantConfig,
  ValueStore,
  UnknownJSON,
  AssistantField,
} from '@kizenapps/engine';
import { AppEngineProvider, SetupAssistantController } from '@kizenapps/engine/react';
import { SetupAssistantRow } from '../components/setup-assistant/SetupAssistantRow.js';
import { JsonConfigEditor } from '../components/setup-assistant/JsonConfigEditor.js';
import { ConfigJsonDialog } from '../components/setup-assistant/ConfigJsonDialog.js';
import {
  loadConfig,
  saveConfig,
  clearConfig,
  loadUserConfig,
  saveUserConfig,
  clearUserConfig,
  type StoredConfig,
} from '../lib/configStorage.js';
import { createKizenApiClient } from '../lib/kizenApiClient.js';
import { useApi, BASE_URLS } from '../api.js';
import { useBootstrap } from '../BootstrapContext.js';
import { useObjectLookups } from '../hooks/useObjectLookups.js';
import { useCriticalExceptionDialog } from '../hooks/useCriticalExceptionDialog.js';
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

const SetupAssistantForm: FC<SetupAssistantFormProps> = ({
  config,
  apiName,
  loadFn,
  saveFn,
  clearFn,
}) => {
  const bootstrap = useBootstrap();
  const request = useApi();
  const apiClient = useMemo(() => createKizenApiClient(request), [request]);
  const { environment } = useCredentials();
  const baseUrl = BASE_URLS[environment];

  const [showing, setShowing] = useState(false);
  const [show, setShow] = useState(false);

  const { onMonitoringException, dialog: criticalExceptionDialog } = useCriticalExceptionDialog();

  if (!bootstrap) {
    return <FontAwesomeIcon icon={faSpinner} className="animate-spin text-neutral-400" />;
  }

  return (
    <AppEngineProvider
      appPath={baseUrl}
      user={{ id: bootstrap.team.user, crm_client_id: '' }}
      business={bootstrap.business}
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
      performRequest={async (method, url, payload, options) => {
        const data = await apiClient.request(method, url, payload, options);

        return { data };
      }}
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
      showToast={() => {
        /* no-op */
      }}
      clearToasts={() => {
        /* no-op */
      }}
    >
      {() => (
        <>
          <SetupAssistantFormInner
            config={config}
            apiName={apiName}
            loadFn={loadFn}
            saveFn={saveFn}
            clearFn={clearFn}
          />
          {criticalExceptionDialog}
        </>
      )}
    </AppEngineProvider>
  );
};

export const ConfigurationPage: FC = () => {
  const { apiName } = useParams({ strict: false });
  const { data: bundle, isLoading, isError } = useQuery(bundleQueryOptions);
  const [jsonDialog, setJsonDialog] = useState<'business' | 'user' | null>(null);

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

  const app = bundle?.find((a) => a.api_name === apiName) as DeployablePlugin | undefined;

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
  const setupAssistant = baseConfig?.setup_assistant;
  const userSetupAssistant = baseConfig?.user_setup_assistant;
  const hasBusinessSetup = (setupAssistant?.fields?.length ?? 0) > 0;
  const hasUserSetup = (userSetupAssistant?.fields?.length ?? 0) > 0;

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
                  Configure the business-level setup assistant fields. These values are shared
                  across the whole business and exposed to plugin scripts at{' '}
                  <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
                    this.config
                  </code>
                  .
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
            <SetupAssistantForm
              config={setupAssistant}
              apiName={apiName ?? ''}
              loadFn={loadConfig}
              saveFn={saveConfig}
              clearFn={clearConfig}
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
                  Configure the per-user setup assistant fields. These values are scoped to the
                  logged-in user and exposed to plugin scripts at{' '}
                  <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
                    this.userConfig
                  </code>
                  .
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
            <SetupAssistantForm
              config={userSetupAssistant}
              apiName={apiName ?? ''}
              loadFn={loadUserConfig}
              saveFn={saveUserConfig}
              clearFn={clearUserConfig}
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
