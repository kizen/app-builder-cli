// One place decides what "this plugin has a setup assistant" means. A manifest can
// configure setup either declaratively (`fields`) or by naming one of the plugin's
// own views (`view`), and every caller that gates on setup — card visibility, the
// args shape handed to artifacts, the app summary — has to accept both. Checking
// `fields.length` alone silently treats a view-only assistant as "no assistant".

import type { SetupAssistantConfig } from '@kizenapps/engine';

/**
 * The api_name of the view a view-based assistant delegates to, or `undefined` when
 * the assistant is declarative (or absent).
 */
export const setupAssistantView = (
  config: SetupAssistantConfig | undefined,
): string | undefined => {
  const view = config?.view;

  return view !== undefined && view !== '' ? view : undefined;
};

/** True when the assistant hands setup off to one of the plugin's views. */
export const isViewBasedSetupAssistant = (config: SetupAssistantConfig | undefined): boolean =>
  setupAssistantView(config) !== undefined;

/** True when the assistant is configured at all — declarative fields or a view. */
export const hasSetupAssistant = (config: SetupAssistantConfig | undefined): boolean =>
  (config?.fields?.length ?? 0) > 0 || isViewBasedSetupAssistant(config);
