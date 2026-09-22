// Every localStorage key the viewer reads or writes lives here so the full
// persistence surface is auditable from one place. Changing a key string below
// strands whatever value existing users have under the old name — migrate
// deliberately rather than as a drive-by.

export const STORAGE_KEYS = {
  credentials: 'devtools-credentials',
  activeProfile: 'devtools-active-profile',
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

// --- Credential-scoped prefix ------------------------------------------------
// Plugin config, selected objects/entities, and service history are all
// account-specific. When the user switches credential profiles the previously
// stored values would be stale (wrong object IDs, wrong config, etc.), so we
// scope these keys to the active credential profile name.

let _credentialPrefix: string | null = null;

function getCredentialPrefix(): string {
  if (_credentialPrefix === null) {
    _credentialPrefix = localStorage.getItem(STORAGE_KEYS.activeProfile) ?? 'credentials';
  }

  return _credentialPrefix;
}

export const CREDENTIAL_PREFIX_CHANGED_EVENT = 'kizen:credential-prefix-changed';

export function setCredentialPrefix(name: string | null): void {
  _credentialPrefix = name ?? 'credentials';
  localStorage.setItem(STORAGE_KEYS.activeProfile, _credentialPrefix);
  window.dispatchEvent(new Event(CREDENTIAL_PREFIX_CHANGED_EVENT));
}

// --- Dynamic key builders (scoped per plugin / service / frame) -------------

export const pluginConfigKey = (apiName: string): string =>
  `${getCredentialPrefix()}:kizen-plugin-config:${apiName}`;

// Plan config and entitlements are business-wide, not per-plugin.
export const planEntitlementsKey = (): string => `${getCredentialPrefix()}:kizen-plan-entitlements`;

export const pluginUserConfigKey = (apiName: string): string =>
  `${getCredentialPrefix()}:kizen-plugin-user-config:${apiName}`;

export const integrationSecretKey = (pluginApiName: string, secretName: string): string =>
  `${getCredentialPrefix()}:kizen-integration-secret:${encodeURIComponent(pluginApiName)}:${encodeURIComponent(secretName)}`;

export const calendarHarnessSelectionKey = (appApiName: string): string =>
  `${getCredentialPrefix()}:calendar-harness-selection:${appApiName}`;

export const serviceRequestHistoryKey = (pluginApiName: string, serviceName: string): string =>
  `${getCredentialPrefix()}:kizen-sandbox:${pluginApiName}:service:${serviceName}:requestHistory`;

const variantSuffix = (variant: string): string => (variant ? `:${variant}` : '');

export const sandboxSelectedObjectKey = (pluginApiName: string, variant = ''): string =>
  `${getCredentialPrefix()}:kizen-sandbox:${pluginApiName}:selectedObject${variantSuffix(variant)}`;

export const sandboxSelectedEntityKey = (pluginApiName: string, variant = ''): string =>
  `${getCredentialPrefix()}:kizen-sandbox:${pluginApiName}:selectedEntity${variantSuffix(variant)}`;

export const sandboxObjectSettingsSelectedObjectKey = (pluginApiName: string): string =>
  `${getCredentialPrefix()}:kizen-sandbox:${pluginApiName}:objectSettings:selectedObject`;

export const floatingFramePositionKey = (id: string): string => `floating-frame-pos-${id}`;

export const blockPreviewSizeKey = (pluginApiName: string, blockApiName: string): string =>
  `${getCredentialPrefix()}:kizen-sandbox:${pluginApiName}:block:${blockApiName}:previewSize`;
