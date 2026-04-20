import { createContext, useContext } from 'react';
import { type Credentials } from '@shared/lib/credentials.js';
export { ENVIRONMENTS, type Environment, type Credentials } from '@shared/lib/credentials.js';

export const CredentialsContext = createContext<Credentials>({
  apiKey: '',
  userId: '',
  businessId: '',
  environment: 'go',
});

export const useCredentials = (): Credentials => useContext(CredentialsContext);
