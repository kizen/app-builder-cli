import type { SetupAssistantConfig, ValueStore } from '@kizenapps/engine';
import { cleanConfig } from '@kizenapps/engine/util';
import { pluginConfigKey, pluginUserConfigKey } from './storageKeys.js';

export interface StoredConfig {
  __kizen_setup_assistant_values: Record<string, ValueStore>;
  __kizen_clean_config: Record<string, unknown>;
}

function makeStorageAccessors(key: (apiName: string) => string): {
  load: (apiName: string) => StoredConfig | null;
  save: (
    apiName: string,
    rawValues: Record<string, ValueStore>,
    setupAssistantConfig: SetupAssistantConfig,
  ) => void;
  saveRaw: (apiName: string, jsonObj: Record<string, unknown>) => void;
  replaceClean: (apiName: string, cleanConfig: Record<string, unknown>) => void;
  clear: (apiName: string) => void;
} {
  function load(apiName: string): StoredConfig | null {
    try {
      const raw = localStorage.getItem(key(apiName));

      if (!raw) {
        return null;
      }

      return JSON.parse(raw) as StoredConfig;
    } catch {
      return null;
    }
  }

  function save(
    apiName: string,
    rawValues: Record<string, ValueStore>,
    setupAssistantConfig: SetupAssistantConfig,
  ): void {
    const clean = cleanConfig(setupAssistantConfig, rawValues);
    const stored: StoredConfig = {
      __kizen_setup_assistant_values: rawValues,
      __kizen_clean_config: clean,
    };

    localStorage.setItem(key(apiName), JSON.stringify(stored));
  }

  function saveRaw(apiName: string, jsonObj: Record<string, unknown>): void {
    const stored: StoredConfig = {
      __kizen_setup_assistant_values: {},
      __kizen_clean_config: jsonObj,
    };

    localStorage.setItem(key(apiName), JSON.stringify(stored));
  }

  function replaceClean(apiName: string, cleanConfig: Record<string, unknown>): void {
    const stored: StoredConfig = {
      __kizen_setup_assistant_values: load(apiName)?.__kizen_setup_assistant_values ?? {},
      __kizen_clean_config: cleanConfig,
    };

    localStorage.setItem(key(apiName), JSON.stringify(stored));
  }

  function clear(apiName: string): void {
    localStorage.removeItem(key(apiName));
  }

  return { load, save, saveRaw, replaceClean, clear };
}

const systemStorage = makeStorageAccessors(pluginConfigKey);
const userStorage = makeStorageAccessors(pluginUserConfigKey);

export const loadConfig = systemStorage.load;
export const saveConfig = systemStorage.save;
export const saveRawConfig = systemStorage.saveRaw;
export const replaceCleanConfig = systemStorage.replaceClean;
export const clearConfig = systemStorage.clear;

export const loadUserConfig = userStorage.load;
export const saveUserConfig = userStorage.save;
export const replaceCleanUserConfig = userStorage.replaceClean;
export const clearUserConfig = userStorage.clear;
