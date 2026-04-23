import { BASE_URLS } from './api.js';
import type { BootstrapData } from './BootstrapContext.js';
import type { Credentials } from './CredentialsContext.js';

export function bootstrapQueryOptions(credentials: Credentials): {
  queryKey: readonly ['bootstrap', string, string, string, string];
  enabled: boolean;
  queryFn: () => Promise<BootstrapData>;
  retry: boolean;
} {
  const { apiKey, userId, businessId, environment } = credentials;
  const hasCredentials = !!(apiKey && userId && businessId);

  return {
    queryKey: ['bootstrap', environment, apiKey, userId, businessId] as const,
    enabled: hasCredentials,
    queryFn: async (): Promise<BootstrapData> => {
      const res = await fetch(`/api/proxy/auth/bootstrap`, {
        headers: {
          'x-proxy-target': BASE_URLS[environment],
          'X-API-KEY': apiKey,
          'X-USER-ID': userId,
          'X-BUSINESS-ID': businessId,
        },
      });

      if (!res.ok) {
        throw new Error(`Bootstrap failed: ${String(res.status)} ${res.statusText}`);
      }

      return res.json() as Promise<BootstrapData>;
    },
    retry: false,
  };
}
