import { useState, type FC } from 'react';
import { loadConfig, saveRawConfig, clearConfig } from '../../lib/configStorage.js';

interface JsonConfigEditorProps {
  apiName: string;
  configTemplate?: Record<string, unknown> | undefined;
}

const stringifyTemplate = (template?: Record<string, unknown>): string =>
  template ? JSON.stringify(template, null, 2) : '{}';

export const JsonConfigEditor: FC<JsonConfigEditorProps> = ({ apiName, configTemplate }) => {
  const existing = loadConfig(apiName);
  const templateJson = stringifyTemplate(configTemplate);
  const initialJson = existing?.__kizen_clean_config
    ? JSON.stringify(existing.__kizen_clean_config, null, 2)
    : templateJson;

  const [value, setValue] = useState(initialJson);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = (): void => {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;

      saveRawConfig(apiName, parsed);

      setError(null);

      setSaved(true);

      setTimeout(() => {
        setSaved(false);
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');

      setSaved(false);
    }
  };

  const handleReset = (): void => {
    clearConfig(apiName);

    setValue(templateJson);

    setError(null);

    setSaved(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-neutral-500 m-0">
          No setup assistant defined. Enter configuration as JSON.
          {configTemplate ? ' Pre-populated from config_template.' : ''}
        </p>
      </div>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);

          setError(null);

          setSaved(false);
        }}
        spellCheck={false}
        className={`w-full min-h-[300px] rounded border p-3 text-[13px] font-mono leading-relaxed focus:outline-none focus:ring-1 ${
          error ? 'border-red-300 focus:ring-red-400' : 'border-black/10 focus:ring-blue-400'
        }`}
      />
      {error && <span className="text-[12px] text-red-500">Parse error: {error}</span>}
      <div className="flex items-center gap-2">
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
  );
};
