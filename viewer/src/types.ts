// Shared domain types used across multiple sandbox section components.

import type { SetupAssistantConfig } from '@kizenapps/engine';
import type { DeployablePlugin } from '@kizenapps/packager';

export interface OAuthCredentials {
  client_id?: string;
  scopes?: string;
  authorize_url?: string;
  token_url?: string;
  // client_secret intentionally omitted — never displayed in the viewer
}

export interface ServiceConfig {
  service_name: string;
  display_name: string;
  auth_type: string;
  auth_level?: string;
  required_entitlement?: string | null;
  base_service_url: string;
  auth_credentials?: OAuthCredentials;
}

// How DeployablePlugin serializes over the /api/bundle endpoint. The CLI's
// runBuild.ts encodes binary fields as base64 strings and tacks on
// allReleaseNotes; services are narrowed from the packager's generic shape
// to the structured form the viewer actually consumes.
export type BundlePlugin = Omit<DeployablePlugin, 'thumbnail' | 'kznFile' | 'services'> & {
  thumbnail: string | null;
  kznFile: string | null;
  services?: ServiceConfig[];
  allReleaseNotes: { version: string; notes: string }[];
};

export interface PluginBaseConfig {
  setup_assistant?: SetupAssistantConfig;
  user_setup_assistant?: SetupAssistantConfig;
}

export interface CustomObjectRecord {
  id: string;
  object_name: string;
}

export interface EntityField {
  name: string;
  value: unknown;
}

export interface EntityRecord {
  id: string;
  fields: Record<string, EntityField>;
}

export interface PaginatedResponse<T> {
  results: T[];
  count: number;
}
