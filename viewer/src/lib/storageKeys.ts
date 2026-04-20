// Every localStorage key the viewer reads or writes lives here so the full
// persistence surface is auditable from one place. Changing a key string below
// strands whatever value existing users have under the old name — migrate
// deliberately rather than as a drive-by.

export const STORAGE_KEYS = {
  credentials: 'devtools-credentials',
  sidebarOpen: 'devtools-sidebar-open',
  sidebarWidth: 'devtools-sidebar-width',
  credsPanelOpen: 'devtools-creds-open',
  routesPanelOpen: 'devtools-routes-open',
  consolePanelOpen: 'devtools-console-open',
  proxyPanelOpen: 'devtools-proxy-open',
  buildPanelOpen: 'devtools-build-open',
  scriptRunnerLogging: 'kizen-flag-script-runner-logging',
  sandboxFramesEnabled: 'frames-enabled',
} as const;

// --- Dynamic key builders (scoped per plugin / service / frame) -------------

export const pluginConfigKey = (apiName: string): string => `kizen-plugin-config:${apiName}`;

export const pluginUserConfigKey = (apiName: string): string =>
  `kizen-plugin-user-config:${apiName}`;

export const calendarHarnessSelectionKey = (appApiName: string): string =>
  `calendar-harness-selection:${appApiName}`;

export const serviceRequestHistoryKey = (pluginApiName: string, serviceName: string): string =>
  `kizen-sandbox:${pluginApiName}:service:${serviceName}:requestHistory`;

const variantSuffix = (variant: string): string => (variant ? `:${variant}` : '');

export const sandboxSelectedObjectKey = (pluginApiName: string, variant = ''): string =>
  `kizen-sandbox:${pluginApiName}:selectedObject${variantSuffix(variant)}`;

export const sandboxSelectedEntityKey = (pluginApiName: string, variant = ''): string =>
  `kizen-sandbox:${pluginApiName}:selectedEntity${variantSuffix(variant)}`;

export const sandboxObjectSettingsSelectedObjectKey = (pluginApiName: string): string =>
  `kizen-sandbox:${pluginApiName}:objectSettings:selectedObject`;

export const floatingFramePositionKey = (id: string): string => `floating-frame-pos-${id}`;
