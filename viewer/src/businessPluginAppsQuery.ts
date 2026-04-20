import { BASE_URLS } from './api.js';
import type { Credentials } from './CredentialsContext.js';

export interface BusinessPluginApp {
  id: string;
  disabled: boolean;
  plugin_app: { api_name: string };
  config: Record<string, unknown>;
}

export function businessPluginAppsQueryOptions(credentials: Credentials): {
  queryKey: readonly ['businessPluginApps', string, string, string, string];
  enabled: boolean;
  queryFn: () => Promise<BusinessPluginApp[]>;
  retry: boolean;
} {
  const { apiKey, userId, businessId, environment } = credentials;
  const hasCredentials = !!(apiKey && userId && businessId);

  return {
    queryKey: ['businessPluginApps', environment, apiKey, userId, businessId] as const,
    enabled: hasCredentials,
    queryFn: async (): Promise<BusinessPluginApp[]> => {
      const res = await fetch(`/api/proxy/external-integrations/business-plugin-apps`, {
        headers: {
          'x-proxy-target': BASE_URLS[environment],
          'X-API-KEY': apiKey,
          'X-USER-ID': userId,
          'X-BUSINESS-ID': businessId,
        },
      });

      if (!res.ok) {
        throw new Error(`businessPluginApps failed: ${String(res.status)} ${res.statusText}`);
      }

      return res.json() as Promise<BusinessPluginApp[]>;
    },
    retry: false,
  };
}
