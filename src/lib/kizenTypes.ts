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
}

export interface EventScriptEntry {
  name: string;
  script: string;
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
}

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
  listCustomObjects(): Promise<WireCustomObject[]>;
  getCustomObject(id: string): Promise<WireCustomObject>;
  getClientObjectId(): Promise<string | null>;
  getDashboard(id: string): Promise<WireDashboard>;
  createDashlet(dashboardId: string, body: CreateDashletBody): Promise<WireDashlet>;
  updateDashlet(
    dashboardId: string,
    dashletId: string,
    body: UpdateDashletBody,
  ): Promise<WireDashlet>;
}

export type KizenApiErrorKind =
  | 'auth_failed'
  | 'forbidden'
  | 'not_found'
  | 'api_error'
  | 'network_error';

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
