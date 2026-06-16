import { useGenericAppCustomScript } from '@kizenapps/engine/react';
import type { ToolbarItemConfig, UnknownJSON } from '@kizenapps/engine';
import type { GenericPluginConfig } from '@kizenapps/engine';
import { useState, type FC } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { LoadingOverlay } from './LoadingOverlay.js';
import { VALID_ICONS } from '@shared/lib/validIcons.js';
import { ICON_MAP, CUSTOM_ICON_NAMES } from '../lib/iconMap.js';
import { WhenBadge } from './WhenBadge.js';
import { ScriptResultPill, toErrorMessage, type ScriptResult } from './ScriptResultPill.js';

type ToolbarItemWithWhen = ToolbarItemConfig & { when?: string };

export const ToolbarItem: FC<{
  item: ToolbarItemConfig;
  whenState?: Record<string, UnknownJSON>;
}> = ({ item, whenState }) => {
  // useGenericAppCustomScript wants a GenericPluginConfig (requires `name`
  // and `type`); a toolbar item carries neither. Build a minimal adapter with
  // `name` reusing the visible label and `type: 'script'` — it's invoked
  // purely as a script plugin here.
  const plugin: GenericPluginConfig = { ...item, name: item.label, type: 'script' };

  const [result, setResult] = useState<ScriptResult | null>(null);

  const [execute, { pending }] = useGenericAppCustomScript({
    onError: (e) => {
      console.error(`[toolbar] ${item.api_name}:`, e);

      setResult({ kind: 'error', message: toErrorMessage(e) });
    },
    plugin,
  });

  const when = (item as ToolbarItemWithWhen).when;

  return (
    <button
      onClick={() => {
        setResult(null);

        void execute(
          item.script,
          (item as typeof item & { args?: Record<string, unknown> }).args,
        ).then((value) => {
          setResult({ kind: 'value', value });
        });
      }}
      disabled={pending}
      className="relative flex flex-col items-start rounded border border-black/8 bg-white px-3 py-1.5 font-mono text-[12px] text-neutral-800 transition-colors hover:bg-black/5 disabled:opacity-50"
    >
      <span className="flex items-center gap-1.5">
        {item.color && (
          <span
            className="h-3 w-4 shrink-0 rounded-sm border border-black/10"
            style={{ backgroundColor: item.color }}
          />
        )}
        {item.icon &&
          (ICON_MAP[item.icon] ? (
            <FontAwesomeIcon icon={ICON_MAP[item.icon]} className="text-[12px] text-neutral-500" />
          ) : (
            <span
              className={`rounded px-1 font-mono text-[10px] ${VALID_ICONS.has(item.icon) || CUSTOM_ICON_NAMES.has(item.icon) ? 'bg-neutral-100 text-neutral-400' : 'bg-amber-100 text-amber-600'}`}
            >
              {item.icon}
            </span>
          ))}
        <span>{item.label}</span>
      </span>
      {when && whenState && <WhenBadge when={when} whenState={whenState} />}
      {result && <ScriptResultPill result={result} />}
      <LoadingOverlay visible={pending} />
    </button>
  );
};
