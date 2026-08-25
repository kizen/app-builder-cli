import { useState, type FC } from 'react';
import { LoadingOverlay } from './LoadingOverlay.js';
import { useRecordDetailCustomScript } from '@kizenapps/engine/react';
import type { DataAdornment } from '@kizenapps/packager';
import type { UnknownJSON } from '@kizenapps/engine';
import { useCredentials } from '../CredentialsContext.js';
import { Typeahead } from './Typeahead.js';
import { useEntitySelector } from '../hooks/useEntitySelector.js';
import { IconNameBadge } from './IconNameBadge.js';
import { WhenBadge } from './WhenBadge.js';
import { ScriptResultPill, toErrorMessage, type ScriptResult } from './ScriptResultPill.js';

interface DataAdornmentItemProps {
  adornment: DataAdornment;
  objectId: string;
  entityId: string;
  pluginApiName: string;
  fieldValue: string;
  configArgs?: Record<string, unknown> | undefined;
  disabled?: boolean;
  whenState?: Record<string, UnknownJSON>;
}

const DataAdornmentItem: FC<DataAdornmentItemProps> = ({
  adornment,
  objectId,
  entityId,
  pluginApiName,
  fieldValue,
  configArgs,
  disabled,
  whenState,
}) => {
  const [result, setResult] = useState<ScriptResult | null>(null);

  const [execute, { pending }] = useRecordDetailCustomScript({
    objectId,
    entityId,
    onError: (e) => {
      console.error(`[data-adornment] ${adornment.field_type}:`, e);

      setResult({ kind: 'error', message: toErrorMessage(e) });
    },
  });

  const executionPlugin = {
    id: adornment.config.tooltip || adornment.field_type,
    api_name: adornment.field_type,
    plugin_api_name: pluginApiName,
  };

  return (
    <button
      onClick={() => {
        const scriptArgs = {
          value: fieldValue,
          fieldId: '',
          fieldType: adornment.field_type,
          objectId,
          entityId,
          ...configArgs,
        };

        setResult(null);

        void execute(adornment.script, scriptArgs, executionPlugin).then((value) => {
          setResult({ kind: 'value', value });
        });
      }}
      disabled={disabled === true || pending}
      className="relative flex flex-col items-start rounded border border-black/8 bg-white px-3 py-1.5 text-left transition-colors hover:bg-black/5 disabled:opacity-50"
    >
      <span className="flex items-center gap-1.5 font-mono text-[12px] text-neutral-800">
        {adornment.config.color && (
          <span
            className="h-3 w-4 shrink-0 rounded-sm border border-black/10"
            style={{ backgroundColor: adornment.config.color }}
          />
        )}
        {adornment.config.icon && (
          <IconNameBadge name={adornment.config.icon} className="text-[10px]" />
        )}
        {adornment.config.tooltip || adornment.field_type}
      </span>
      <span className="font-mono text-[10px] text-neutral-400">{adornment.field_type}</span>
      {adornment.when && whenState && <WhenBadge when={adornment.when} whenState={whenState} />}
      {result && <ScriptResultPill result={result} />}
      <LoadingOverlay visible={pending} />
    </button>
  );
};

interface DataAdornmentSectionProps {
  adornments: DataAdornment[];
  pluginApiName: string;
  configArgs?: Record<string, unknown>;
  whenState?: Record<string, UnknownJSON>;
}

export const DataAdornmentSection: FC<DataAdornmentSectionProps> = ({
  adornments,
  pluginApiName,
  configArgs,
  whenState,
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

  // Field value state per field_type group
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  if (!apiKey) {
    return (
      <p className="mt-1 text-[12px] text-neutral-400">
        Configure API credentials in Dev Tools to use data adornments.
      </p>
    );
  }

  const bothSelected = selectedObject !== null && selectedEntity !== null;

  // Group adornments by field_type
  const grouped = adornments.reduce<Record<string, DataAdornment[]>>((acc, adornment) => {
    const key = adornment.field_type;

    acc[key] ??= [];

    acc[key].push(adornment);

    return acc;
  }, {});

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

      <div
        key={bothSelected ? `${selectedObject.id}-${selectedEntity.id}` : 'no-selection'}
        className="flex flex-col gap-3"
      >
        {Object.entries(grouped).map(([fieldType, fieldAdornments]) => (
          <div key={fieldType} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
                {fieldType}
              </label>
              <input
                type="text"
                className="w-full rounded border border-black/10 bg-white px-2.5 py-1.5 font-mono text-[12px] text-neutral-800 focus:border-neutral-400 focus:outline-none"
                placeholder={`${fieldType} value…`}
                value={fieldValues[fieldType] ?? ''}
                onChange={(e) => {
                  setFieldValues((prev) => ({ ...prev, [fieldType]: e.target.value }));
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {fieldAdornments.map((adornment, i) => (
                <DataAdornmentItem
                  key={i}
                  adornment={adornment}
                  objectId={selectedObject?.id ?? ''}
                  entityId={selectedEntity?.id ?? ''}
                  pluginApiName={pluginApiName}
                  fieldValue={fieldValues[fieldType] ?? ''}
                  configArgs={configArgs}
                  disabled={!bothSelected}
                  {...(whenState ? { whenState } : {})}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
