import type { DeployablePlugin } from '@kizenapps/packager';
import {
  BusinessAppError,
  THUMBNAIL_REQUIRED_MESSAGE,
  type BusinessAppArtifacts,
  type BusinessAppPublishBody,
} from './businessApps.js';

export interface PublishBodyOptions {
  release: boolean;
  sourcePackageId: string;
  thumbnailId: string | null;
}

function publishBaseConfig(
  baseConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return structuredClone(
    Object.fromEntries(Object.entries(baseConfig ?? {}).filter(([, value]) => value !== undefined)),
  );
}

function publishArtifacts(artifacts: DeployablePlugin['artifacts']): BusinessAppArtifacts {
  const copy = <T>(items: T[] | undefined): T[] => structuredClone(items ?? []);

  return {
    data_adornments: copy(artifacts.data_adornments),
    floating_frames: copy(artifacts.floating_frames),
    custom_blocks: copy(artifacts.custom_blocks),
    routable_pages: copy(artifacts.routable_pages),
    toolbar_items: copy(artifacts.toolbar_items),
    object_settings_menu_items: copy(artifacts.object_settings_menu_items),
    calendar_sources: copy(artifacts.calendar_sources),
    js_action_templates: copy(artifacts.js_action_templates),
    // The server reads route_script_templates and silently ignores route_scripts.
    route_script_templates: copy(artifacts.route_scripts),
    automation_action_configs: copy(artifacts.automation_action_configs),
  };
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function toPublishBody(
  deployable: DeployablePlugin,
  opts: PublishBodyOptions,
): BusinessAppPublishBody {
  if (opts.release && !opts.thumbnailId) {
    throw new BusinessAppError('thumbnail_required', THUMBNAIL_REQUIRED_MESSAGE);
  }

  const extra = deployable as unknown as Record<string, unknown>;
  const body: BusinessAppPublishBody = {
    name: deployable.name,
    api_name: deployable.api_name,
    engine: deployable.engine,
    services: structuredClone(deployable.services ?? []),
    base_config: publishBaseConfig(deployable.base_config),
    artifacts: publishArtifacts(deployable.artifacts),
    release: opts.release,
    source_filesystem_package: opts.sourcePackageId,
    thumbnail: opts.thumbnailId,
  };

  const description = optionalString(deployable.description);
  const agenticDescription = optionalString(deployable.agentic_description);
  const externalLink = optionalString(extra.external_link);
  const releaseNotes = optionalString(deployable.releaseNotes);

  if (description !== undefined) {
    body.description = description;
  }

  if (agenticDescription !== undefined) {
    body.agentic_description = agenticDescription;
  }

  if (externalLink !== undefined) {
    body.external_link = externalLink;
  }

  if (deployable.config_template !== undefined) {
    body.config_template = structuredClone(deployable.config_template);
  }

  if (Array.isArray(extra.catalogs) && extra.catalogs.every((item) => typeof item === 'string')) {
    body.catalogs = [...extra.catalogs];
  }

  if (releaseNotes !== undefined) {
    body.release_notes = releaseNotes;
  }

  return body;
}
