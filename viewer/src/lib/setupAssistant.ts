import type { SetupAssistantConfig } from '@kizenapps/engine';

export const setupAssistantView = (
  config: SetupAssistantConfig | undefined,
): string | undefined => {
  const view = config?.view;

  return view !== undefined && view !== '' ? view : undefined;
};

export const isViewBasedSetupAssistant = (config: SetupAssistantConfig | undefined): boolean =>
  setupAssistantView(config) !== undefined;

export const hasSetupAssistant = (config: SetupAssistantConfig | undefined): boolean =>
  (config?.fields?.length ?? 0) > 0 || isViewBasedSetupAssistant(config);
