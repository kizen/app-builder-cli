import { useCallback } from 'react';
import { useCredentials, type Environment } from './CredentialsContext.js';
import { isMockError, type KizenApiClient } from './lib/kizenApiClient.js';
import {
  createKizenProxyError,
  handleKizenNetworkResponse,
  KizenRequestError,
} from '@kizenapps/engine/util';
import type { JSONObject, OnNetworkRequestFn } from '@kizenapps/engine';

export const BASE_URLS: Record<Environment, string> = {
  go: 'https://app.go.kizen.com/api',
  fmo: 'https://app.fmo.kizen.com/api',
  staging: 'https://staging.kizen.dev/api',
  integration: 'https://integration.kizen.dev/api',
  test1: 'https://test1.kizen.dev/api',
};

export const APP_URLS: Record<Environment, string> = {
  go: 'https://go.kizen.com',
  fmo: 'https://fmo.kizen.com',
  staging: 'https://v2.staging.kizen.com',
  integration: 'https://v2.integration.kizen.dev',
  test1: 'https://test1.kizen.dev',
};

/**
 * Returns an authenticated `request` function that proxies through the local
 * dev server to avoid CORS. The `x-proxy-target` header tells the server which
 * upstream base URL to forward to; the three Kizen auth headers are injected
 * automatically.
 *
 * Usage:
 *   const request = useApi();
 *   const res = await request('/api/v1/some-endpoint');
 */
type ApiRequestInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

export function useApi(): (path: string, options?: ApiRequestInit) => Promise<Response> {
  const { apiKey, userId, businessId, environment } = useCredentials();
  const baseUrl = BASE_URLS[environment];

  return useCallback(
    (path: string, options: ApiRequestInit = {}): Promise<Response> => {
      return fetch(`/api/proxy${path}`, {
        ...options,
        headers: {
          'x-proxy-target': baseUrl,
          'X-API-KEY': apiKey,
          'X-USER-ID': userId,
          'X-BUSINESS-ID': businessId,
          ...options.headers,
        },
      });
    },
    [baseUrl, apiKey, userId, businessId],
  );
}

export const kizenRequestHandler =
  (apiClient: KizenApiClient) =>
  async (
    method: string,
    url: string,
    payload?: unknown,
    options?: unknown,
  ): ReturnType<OnNetworkRequestFn> => {
    const isProxyRequest = url.startsWith('/external-integrations/proxy');

    if (isProxyRequest) {
      try {
        const response = await apiClient.request(method, url, payload, options);

        const processedResponse = handleKizenNetworkResponse({
          data: response,
          status: (response.status_code as number | undefined) ?? 200,
        });

        return processedResponse;
      } catch (ex) {
        // Re-throw KizenRequestErrors, they will be handled correctly

        if (ex instanceof KizenRequestError) {
          throw ex;
        }

        // If we get an error thrown by our fetch at this point, it means we failed to call the proxy
        if (isMockError(ex)) {
          throw createKizenProxyError(ex.response?.status, ex.response?.data?.error);
        }

        // This would be unexpected, but we should re-throw in case something falls through
        throw ex;
      }
    } else {
      const result = await apiClient.request(method, url, payload, options);

      return {
        ...result,
        data: result.data as JSONObject,
      };
    }
  };
