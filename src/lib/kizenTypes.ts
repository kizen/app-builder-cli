export type DashboardType = 'generic_dashboard' | 'homepage' | 'chart_group';

export type Surface = 'dashboard' | 'homepage' | 'chart_group';

export interface DashletLayout {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WireDashlet {
  id: string;
  name: string;
  layout: DashletLayout | null;
  config: Record<string, unknown> | null;
  dashboard: string;
}

export interface WireDashboardSummary {
  id: string;
  name: string;
  type?: DashboardType;
  employee_access?: string | null;
  hidden?: boolean;
  dashlets_count?: number | null;
}

export interface WireDashboard {
  id: string;
  name: string;
  type: DashboardType;
  custom_object: string | { id: string; fetch_url?: string } | null;
  employee_access?: string | null;
  dashlets: WireDashlet[];
}

export interface WireCustomObject {
  id: string;
  object_name: string;
  fetch_url: string;
  name?: string;
  entity_name?: string;
}

export interface ListCustomObjectsOptions {
  /** false includes Contacts (`custom_only=false`); the server's default (true) leaves it out. */
  customOnly?: boolean;
}

export interface EventScriptEntry {
  name: string;
  script: string;
}

/**
 * A plugin view carried inside custom_code content so a block can open it with
 * `this.showViewInModal(api_name)`. `event_scripts` is an array, never a map,
 * because react-app's DashletService rewrites object keys.
 */
export interface CustomCodeView {
  api_name: string;
  name?: string;
  type: 'script' | 'html';
  script?: string;
  html?: string;
  css?: string;
  event_scripts: EventScriptEntry[];
}

export interface CustomCodeContent {
  kind: 'custom_code';
  version: 1;
  name: string;
  script: string;
  styles: string;
  event_scripts: EventScriptEntry[];
  min_w?: number;
  max_w?: number;
  min_h?: number;
  max_h?: number;
  default_w?: number;
  default_h?: number;
  host_chrome?: boolean;
  /** Omitted when the plugin has no views, so view-less content is unchanged. */
  views?: CustomCodeView[];
}

/** Every block size key, in canonical content order. */
export const BLOCK_SIZE_FIELDS = [
  'min_w',
  'max_w',
  'min_h',
  'max_h',
  'default_w',
  'default_h',
] as const satisfies readonly (keyof CustomCodeContent)[];

export interface CreateDashletBody {
  name: string;
  layout: DashletLayout;
  config: Record<string, unknown>;
}

export interface UpdateDashletBody {
  config: Record<string, unknown>;
}

export interface KizenClient {
  listDashboards(type: DashboardType, customObjectId?: string): Promise<WireDashboardSummary[]>;
  listCustomObjects(options?: ListCustomObjectsOptions): Promise<WireCustomObject[]>;
  getCustomObject(id: string): Promise<WireCustomObject>;
  getClientObjectId(): Promise<string | null>;
  getDashboard(id: string): Promise<WireDashboard>;
  createDashlet(dashboardId: string, body: CreateDashletBody): Promise<WireDashlet>;
  updateDashlet(
    dashboardId: string,
    dashletId: string,
    body: UpdateDashletBody,
  ): Promise<WireDashlet>;
  requestJson(method: KizenJsonMethod, path: string, body?: unknown): Promise<unknown>;
  postForm(path: string, fields: Readonly<Record<string, string>>): Promise<unknown>;
  getBinary(path: string): Promise<Uint8Array>;
}

export type KizenJsonMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type KizenApiErrorKind =
  | 'auth_failed'
  | 'forbidden'
  | 'not_found'
  | 'api_error'
  | 'network_error'
  | 'session_store_unwritable';

export interface PushMapEntry {
  environment: string;
  businessId: string;
  pluginApiName: string;
  blockApiName: string;
  dashboardId: string;
  dashletId: string;
  contentHash: string;
  pushedAt: string;
}
