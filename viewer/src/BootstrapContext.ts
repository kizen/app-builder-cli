import type { PartialBusiness, PartialTeamMember } from '@kizenapps/engine';
import { createContext, useContext } from 'react';

interface ClientObject {
  id: string;
  name: string;
  object_name: string;
  access: boolean;
}

export interface EnabledPluginApp {
  id: string;
  api_name: string;
  version: string;
}

export interface BootstrapData {
  team: PartialTeamMember & {
    user: string;
  };
  business: PartialBusiness & { client_object?: ClientObject };
  enabled_plugin_apps: EnabledPluginApp[];
}

export const BootstrapContext = createContext<BootstrapData | undefined>(undefined);

export const useBootstrap = (): BootstrapData | undefined => {
  const context = useContext(BootstrapContext);

  return context;
};
