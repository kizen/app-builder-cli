export const ENVIRONMENTS = [
  'go',
  'fmo',
  'staging',
  'e2e-staging',
  'integration',
  'e2e-integration',
  'test1',
  'perf',
] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface Credentials {
  apiKey: string;
  userId: string;
  businessId: string;
  environment: Environment;
}

export type CredentialIds = Pick<Credentials, 'apiKey' | 'userId' | 'businessId'>;

export function cleanCredentialId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeCredentialIds(
  values: Partial<Record<keyof CredentialIds, unknown>>,
): CredentialIds {
  return {
    apiKey: cleanCredentialId(values.apiKey),
    userId: cleanCredentialId(values.userId),
    businessId: cleanCredentialId(values.businessId),
  };
}
