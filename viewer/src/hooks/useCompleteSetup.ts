import { useCallback } from 'react';
import type {
  CompleteSetupLevel,
  CompleteSetupOptions,
  HostCompleteSetupFn,
  UnknownJSON,
} from '@kizenapps/engine';
import { replaceCleanConfig, replaceCleanUserConfig } from '../lib/configStorage.js';

/**
 * Unlike the real product this stamps no setup hash: there is no
 * install flow locally, so there is no re-prompt to suppress.
 */
export function useCompleteSetup(
  defaultLevel: CompleteSetupLevel,
  onWrite: () => void,
): HostCompleteSetupFn {
  return useCallback(
    (
      pluginApiName: string,
      payload: UnknownJSON,
      options?: CompleteSetupOptions,
    ): Promise<unknown> => {
      const level = options?.level ?? defaultLevel;

      if (!pluginApiName) {
        return Promise.reject(
          new Error('completeSetup: the calling script has no plugin api_name in scope'),
        );
      }

      try {
        if (level === 'user') {
          replaceCleanUserConfig(pluginApiName, payload);
        } else {
          replaceCleanConfig(pluginApiName, payload);
        }
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }

      onWrite();

      return Promise.resolve({ level });
    },
    [defaultLevel, onWrite],
  );
}
