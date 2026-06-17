import { useState, type FC } from 'react';
import { LoadingOverlay } from './LoadingOverlay.js';
import { useRecordDetailCustomScript } from '@kizenapps/engine/react';
import type { JSAction } from '@kizenapps/packager';
import { useCredentials } from '../CredentialsContext.js';
import { Typeahead } from './Typeahead.js';
import { useEntitySelector } from '../hooks/useEntitySelector.js';
import { ScriptResultPill, toErrorMessage, type ScriptResult } from './ScriptResultPill.js';

interface JsActionItemProps {
  action: JSAction;
  objectId: string;
  entityId: string;
  actionObjectId?: string | undefined;
  actionEntityId?: string | undefined;
  pluginApiName: string;
  configArgs?: Record<string, unknown> | undefined;
  disabled?: boolean;
}

const JsActionItem: FC<JsActionItemProps> = ({
  action,
  objectId,
  entityId,
  actionObjectId,
  actionEntityId,
  pluginApiName,
  configArgs,
  disabled,
}) => {
  const [result, setResult] = useState<ScriptResult | null>(null);

  const [execute, { pending }] = useRecordDetailCustomScript({
    objectId,
    entityId,
    onError: (e) => {
      console.error(`[js-action] ${action.api_name}:`, e);

      setResult({ kind: 'error', message: toErrorMessage(e) });
    },
  });

  const executionPlugin = {
    id: action.api_name,
    api_name: action.api_name,
    plugin_api_name: pluginApiName,
  };

  return (
    <button
      onClick={() => {
        const overrideContext: Record<string, unknown> = { objectId, entityId };

        if (actionObjectId && actionEntityId) {
          overrideContext.actionObjectId = actionObjectId;
          overrideContext.actionEntityId = actionEntityId;
        }

        setResult(null);

        void execute(action.script, configArgs, executionPlugin, overrideContext).then((value) => {
          setResult({ kind: 'value', value });
        });
      }}
      disabled={disabled === true || pending}
      className="relative flex flex-col items-start rounded border border-black/8 bg-white px-3 py-1.5 text-left transition-colors hover:bg-black/5 disabled:opacity-50"
    >
      <span className="font-mono text-[12px] text-neutral-800">{action.name}</span>
      {action.hint_object_name && (
        <span className="font-mono text-[10px] text-neutral-400">
          for: {action.hint_object_name}
        </span>
      )}
      {result && <ScriptResultPill result={result} />}
      <LoadingOverlay visible={pending} />
    </button>
  );
};

interface JsActionSectionProps {
  actions: JSAction[];
  pluginApiName: string;
  configArgs?: Record<string, unknown>;
}

export const JsActionSection: FC<JsActionSectionProps> = ({
  actions,
  pluginApiName,
  configArgs,
}) => {
  const { apiKey } = useCredentials();

  const {
    selectedObject,
    setSelectedObject,
    objectSearch,
    setObjectSearch,
    objectsQuery,
    objectOptions,
    selectedEntity,
    setSelectedEntity,
    entitySearch,
    setEntitySearch,
    entitiesQuery,
    entityOptions,
  } = useEntitySelector(pluginApiName);

  const {
    selectedObject: selectedActionObject,
    setSelectedObject: setSelectedActionObject,
    objectSearch: actionObjectSearch,
    setObjectSearch: setActionObjectSearch,
    objectsQuery: actionObjectsQuery,
    objectOptions: actionObjectOptions,
    selectedEntity: selectedActionEntity,
    setSelectedEntity: setSelectedActionEntity,
    entitySearch: actionEntitySearch,
    setEntitySearch: setActionEntitySearch,
    entitiesQuery: actionEntitiesQuery,
    entityOptions: actionEntityOptions,
  } = useEntitySelector(pluginApiName, 'action');

  if (!apiKey) {
    return (
      <p className="mt-1 text-[12px] text-neutral-400">
        Configure API credentials in Dev Tools to use JS action templates.
      </p>
    );
  }

  const bothSelected = selectedObject !== null && selectedEntity !== null;
  const actionPairSelected = selectedActionObject !== null && selectedActionEntity !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <div className="flex-1">
          <Typeahead
            label="Custom Object"
            value={objectSearch}
            onChange={(v) => {
              setObjectSearch(v);

              if (selectedObject) {
                setSelectedObject(null);

                setSelectedEntity(null);

                setEntitySearch('');
              }
            }}
            onSelect={(id, label) => {
              setSelectedObject({ id, name: label });

              setObjectSearch(label);

              setSelectedEntity(null);

              setEntitySearch('');
            }}
            options={objectOptions}
            loading={objectsQuery.isFetching}
            placeholder="Search custom objects…"
          />
        </div>
        <div className="flex-1">
          <Typeahead
            label="Record"
            value={entitySearch}
            onChange={(v) => {
              setEntitySearch(v);

              if (selectedEntity) {
                setSelectedEntity(null);
              }
            }}
            onSelect={(id, label) => {
              setSelectedEntity({ id, label });

              setEntitySearch(label);
            }}
            options={entityOptions}
            loading={entitiesQuery.isFetching}
            placeholder="Search records…"
            disabled={selectedObject === null}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <Typeahead
            label="Related Object (optional)"
            value={actionObjectSearch}
            onChange={(v) => {
              setActionObjectSearch(v);

              if (selectedActionObject) {
                setSelectedActionObject(null);

                setSelectedActionEntity(null);

                setActionEntitySearch('');
              }
            }}
            onSelect={(id, label) => {
              setSelectedActionObject({ id, name: label });

              setActionObjectSearch(label);

              setSelectedActionEntity(null);

              setActionEntitySearch('');
            }}
            options={actionObjectOptions}
            loading={actionObjectsQuery.isFetching}
            placeholder="Search custom objects…"
          />
        </div>
        <div className="flex-1">
          <Typeahead
            label="Action Record (optional)"
            value={actionEntitySearch}
            onChange={(v) => {
              setActionEntitySearch(v);

              if (selectedActionEntity) {
                setSelectedActionEntity(null);
              }
            }}
            onSelect={(id, label) => {
              setSelectedActionEntity({ id, label });

              setActionEntitySearch(label);
            }}
            options={actionEntityOptions}
            loading={actionEntitiesQuery.isFetching}
            placeholder="Search records…"
            disabled={selectedActionObject === null}
          />
        </div>
      </div>

      <div
        key={
          bothSelected
            ? `${selectedObject.id}-${selectedEntity.id}-${
                actionPairSelected ? `${selectedActionObject.id}-${selectedActionEntity.id}` : '-'
              }`
            : 'no-selection'
        }
        className="flex flex-wrap gap-2"
      >
        {actions.map((action) => (
          <JsActionItem
            key={action.api_name}
            action={action}
            objectId={selectedObject?.id ?? ''}
            entityId={selectedEntity?.id ?? ''}
            actionObjectId={selectedActionObject?.id}
            actionEntityId={selectedActionEntity?.id}
            pluginApiName={pluginApiName}
            configArgs={configArgs}
            disabled={!bothSelected}
          />
        ))}
      </div>
    </div>
  );
};
