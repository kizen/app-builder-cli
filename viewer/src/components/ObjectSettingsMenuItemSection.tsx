import { type FC } from 'react';
import { LoadingOverlay } from './LoadingOverlay.js';
import { useRecordDetailCustomScript } from '@kizenapps/engine/react';
import type { ObjectSettingsItem } from '@kizenapps/packager';
import type { UnknownJSON } from '@kizenapps/engine';
import { useCredentials } from '../CredentialsContext.js';
import { Typeahead } from './Typeahead.js';
import { useObjectSelector } from '../hooks/useObjectSelector.js';
import { sandboxObjectSettingsSelectedObjectKey } from '../lib/storageKeys.js';
import { WhenBadge } from './WhenBadge.js';

interface ObjectSettingsMenuItemItemProps {
  item: ObjectSettingsItem;
  objectId: string;
  pluginApiName: string;
  configArgs?: Record<string, unknown> | undefined;
  disabled?: boolean;
  whenState?: Record<string, UnknownJSON>;
}

const ObjectSettingsMenuItemItem: FC<ObjectSettingsMenuItemItemProps> = ({
  item,
  objectId,
  pluginApiName,
  configArgs,
  disabled,
  whenState,
}) => {
  const [execute, { pending }] = useRecordDetailCustomScript({
    objectId,
    entityId: '',
    onError: (e) => {
      console.error(`[object-settings] ${item.api_name}:`, e);
    },
  });

  const executionPlugin = {
    id: item.api_name,
    api_name: item.api_name,
    plugin_api_name: pluginApiName,
  };

  return (
    <button
      onClick={() => {
        void execute(item.script, configArgs, executionPlugin);
      }}
      disabled={disabled === true || pending}
      className="relative flex flex-col items-start rounded border border-black/8 bg-white px-3 py-1.5 text-left transition-colors hover:bg-black/5 disabled:opacity-50"
    >
      <span className="font-mono text-[12px] text-neutral-800">{item.label}</span>
      {item.when && whenState && <WhenBadge when={item.when} whenState={whenState} />}
      <LoadingOverlay visible={pending} />
    </button>
  );
};

interface ObjectSettingsMenuItemSectionProps {
  items: ObjectSettingsItem[];
  pluginApiName: string;
  configArgs?: Record<string, unknown>;
  whenState?: Record<string, UnknownJSON>;
}

export const ObjectSettingsMenuItemSection: FC<ObjectSettingsMenuItemSectionProps> = ({
  items,
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
  } = useObjectSelector(sandboxObjectSettingsSelectedObjectKey(pluginApiName));

  if (!apiKey) {
    return (
      <p className="mt-1 text-[12px] text-neutral-400">
        Configure API credentials in Dev Tools to use object settings menu items.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="w-64">
        <Typeahead
          label="Custom Object"
          value={objectSearch}
          onChange={(v) => {
            setObjectSearch(v);

            if (selectedObject) {
              setSelectedObject(null);
            }
          }}
          onSelect={(id, label) => {
            setSelectedObject({ id, name: label });

            setObjectSearch(label);
          }}
          options={objectOptions}
          loading={objectsQuery.isFetching}
          placeholder="Search custom objects…"
        />
      </div>

      <div key={selectedObject?.id ?? 'no-selection'} className="flex flex-wrap gap-2">
        {items.map((item) => (
          <ObjectSettingsMenuItemItem
            key={item.api_name}
            item={item}
            objectId={selectedObject?.id ?? ''}
            pluginApiName={pluginApiName}
            configArgs={configArgs}
            disabled={selectedObject === null}
            {...(whenState ? { whenState } : {})}
          />
        ))}
      </div>
    </div>
  );
};
