import { createContext, useContext } from 'react';

export const ENVIRONMENTS = ['go', 'fmo', 'staging', 'integration', 'test1'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface Credentials {
  apiKey: string;
  userId: string;
  businessId: string;
  environment: Environment;
}

export const CredentialsContext = createContext<Credentials>({
  apiKey: '',
  userId: '',
  businessId: '',
  environment: 'go',
});

export const useCredentials = (): Credentials => useContext(CredentialsContext);
