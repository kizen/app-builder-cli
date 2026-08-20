import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnknownJSON } from '@kizenapps/engine';
import { mergeConfig } from '@kizenapps/engine/util';
import { loadConfig, loadUserConfig, type StoredConfig } from '../lib/configStorage.js';
import { hasSetupAssistant } from '../lib/setupAssistant.js';
import type { PluginBaseConfig } from '../types.js';

export interface PluginUserConfig {
  api_name: string;
  config: UnknownJSON;
}

export interface PluginConfig {
  configArgs: Record<string, unknown>;
  userConfigs: PluginUserConfig[];
  whenState: Record<string, UnknownJSON>;
  refreshConfig: () => void;
}

interface StoredPair {
  business: StoredConfig | null;
  user: StoredConfig | null;
}

const EMPTY_STORES: StoredPair = { business: null, user: null };

function readStores(apiName: string | undefined): StoredPair {
  if (!apiName) {
    return EMPTY_STORES;
  }

  return { business: loadConfig(apiName), user: loadUserConfig(apiName) };
}

export function usePluginConfig(
  apiName: string | undefined,
  baseConfig: PluginBaseConfig | undefined,
  configTemplate: Record<string, unknown> | undefined,
): PluginConfig {
  const [stores, setStores] = useState<StoredPair>(() => readStores(apiName));

  const refreshConfig = useCallback((): void => {
    setStores(readStores(apiName));
  }, [apiName]);

  const loadedFor = useRef(apiName);

  useEffect(() => {
    if (loadedFor.current === apiName) {
      return;
    }

    loadedFor.current = apiName;

    setStores(readStores(apiName));
  }, [apiName]);

  const configArgs = useMemo((): Record<string, unknown> => {
    const effectiveConfig = stores.business?.__kizen_clean_config ?? configTemplate ?? null;

    if (!effectiveConfig) {
      return {};
    }

    const assisted =
      hasSetupAssistant(baseConfig?.setup_assistant) ||
      hasSetupAssistant(baseConfig?.user_setup_assistant);

    return assisted ? { __kizen_clean_config: effectiveConfig } : { ...effectiveConfig };
  }, [stores.business, baseConfig, configTemplate]);

  const userConfigs = useMemo((): PluginUserConfig[] => {
    const clean = stores.user?.__kizen_clean_config;

    if (!apiName || !clean) {
      return [];
    }

    return [{ api_name: apiName, config: { __kizen_clean_config: clean } as UnknownJSON }];
  }, [apiName, stores.user]);

  const whenState = useMemo((): Record<string, UnknownJSON> => {
    const mergedConfig = mergeConfig(
      (stores.business?.__kizen_clean_config ?? {}) as Record<string, UnknownJSON>,
      [],
      (stores.business?.__kizen_setup_assistant_values ?? {}) as Record<string, UnknownJSON>,
      baseConfig?.setup_assistant?.fields,
    );
    const mergedUserConfig = mergeConfig(
      (stores.user?.__kizen_clean_config ?? {}) as Record<string, UnknownJSON>,
      [],
      (stores.user?.__kizen_setup_assistant_values ?? {}) as Record<string, UnknownJSON>,
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
  }, [stores.business, stores.user, baseConfig]);

  return useMemo(
    () => ({ configArgs, userConfigs, whenState, refreshConfig }),
    [configArgs, userConfigs, whenState, refreshConfig],
  );
}
