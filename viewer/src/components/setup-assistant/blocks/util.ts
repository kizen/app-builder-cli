import { useCallback } from 'react';
import { useBootstrap } from '../../../BootstrapContext';
import { useCredentials } from '../../../CredentialsContext';
import type { IncludeOption } from '@kizenapps/engine';

export const useAuthParams = (): ((key: IncludeOption) => string) => {
  const { businessId } = useCredentials();
  const bootstrap = useBootstrap();

  const getParam = useCallback(
    (key: IncludeOption): string => {
      switch (key) {
        case 'user_id':
          return bootstrap?.team.user ?? '';
        case 'business_id':
          return businessId;
        case 'email':
          return bootstrap?.team.email ?? '';
        case 'name':
          return bootstrap?.team.full_name ?? '';
        case 'base_url':
          return '';
      }
    },
    [businessId, bootstrap],
  );

  return getParam;
};
