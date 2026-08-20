import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { FC } from 'react';
import { bundleQueryOptions } from '../bundleQuery.js';
import { Card } from '../components/Card.js';
import type { DeployablePlugin } from '@kizenapps/packager';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { ICON_MAP, CUSTOM_ICON_NAMES } from '../lib/iconMap.js';
import { VALID_ICONS } from '@shared/lib/validIcons.js';
import type { PluginBaseConfig } from '../types.js';
import type { SetupAssistantConfig } from '@kizenapps/engine';
import { resolveBlockDimensions } from '../lib/blockDimensions.js';
import { hasSetupAssistant, setupAssistantView } from '../lib/setupAssistant.js';
import { formatBytes } from '@shared/lib/formatBytes.js';

const SetupAssistantSummary: FC<{ title: string; config: SetupAssistantConfig }> = ({
  title,
  config,
}) => {
  const view = setupAssistantView(config);
  const fields = config.fields ?? [];

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
          {title}
        </span>
        <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
          {view === undefined ? fields.length : 'view'}
        </span>
      </div>
      {view === undefined ? (
        <>
          <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
            <span className="min-w-0 flex-1">Field</span>
            <span className="shrink-0">Type</span>
          </div>
          <div className="divide-y divide-black/5">
            {fields.map((field, i: number) => (
              <div key={i} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-neutral-900">
                  {'label' in field ? (field.label ?? field.key) : field.type}
                </span>
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                  {field.type}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mb-1 text-[10px] text-neutral-400">View</div>
          <div className="truncate py-1.5 font-mono text-[11px] text-neutral-900">{view}</div>
          <p className="m-0 mt-1 text-[12px] text-neutral-400">
            This assistant declares no fields. The view renders setup and saves its own config.
          </p>
        </>
      )}
    </Card>
  );
};

export const AppDetailPage: FC = () => {
  const { apiName } = useParams({ strict: false });

  const { data: bundle, isLoading, isError } = useQuery(bundleQueryOptions);

  if (isLoading) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-400">Fetching bundle.json…</p>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-red-700">Could not load bundle.json.</p>
      </Card>
    );
  }

  const app = bundle?.find((a) => a.api_name === apiName) as DeployablePlugin | undefined;

  if (!app) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-500">
          No app found with api_name{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5">{apiName}</code>.
        </p>
      </Card>
    );
  }

  const {
    floating_frames: floatingFrames,
    data_adornments: dataAdornments,
    routable_pages: routablePages,
    toolbar_items: toolbarItems,
    js_action_templates: jsActions,
    route_scripts: routeScripts,
    object_settings_menu_items: objectSettings,
    automation_action_configs: automationActions,
    calendar_sources: calendarSources,
    custom_blocks: customBlocks,
  } = app.artifacts;

  const hasAnyArtifacts =
    floatingFrames.length > 0 ||
    dataAdornments.length > 0 ||
    routablePages.length > 0 ||
    toolbarItems.length > 0 ||
    jsActions.length > 0 ||
    routeScripts.length > 0 ||
    objectSettings.length > 0 ||
    automationActions.length > 0 ||
    calendarSources.length > 0 ||
    customBlocks.length > 0;

  const bundleSizeBytes = bundle
    ? new TextEncoder().encode(JSON.stringify(bundle, null, 2)).length
    : null;

  const baseConfig = app.base_config as PluginBaseConfig | undefined;
  const setupAssistant = baseConfig?.setup_assistant;
  const userSetupAssistant = baseConfig?.user_setup_assistant;
  const hasBusinessSetup = hasSetupAssistant(setupAssistant);
  const hasUserSetup = hasSetupAssistant(userSetupAssistant);

  return (
    <div className="space-y-4 text-[13px]">
      {/* Header */}
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <h1 className="text-lg font-bold leading-tight text-neutral-900">{app.name}</h1>
            <p className="mt-0.5 font-mono text-[11px] text-neutral-400">{app.api_name}</p>
          </div>
          {app.description && (
            <p className="text-[13px] leading-relaxed text-neutral-600">{app.description}</p>
          )}
          <div className="divide-y divide-black/5">
            {app.version && (
              <div className="flex items-center gap-3 py-2">
                <span className="shrink-0 rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-neutral-600">
                  v{app.version}
                </span>
                <span className="text-[12px] text-neutral-500">App version</span>
              </div>
            )}
            {app.engine && (
              <div className="flex items-center gap-3 py-2">
                <span className="shrink-0 rounded bg-blue-50 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-blue-600">
                  engine: {app.engine}
                </span>
                <span className="text-[12px] text-neutral-500">Plugin engine version</span>
              </div>
            )}
            <div className="flex items-center gap-3 py-2">
              <span
                className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide ${
                  app.published ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                }`}
              >
                {app.published ? 'published' : 'unpublished'}
              </span>
              <span className="text-[12px] text-neutral-500">
                Whether this app is publicly available
              </span>
            </div>
            {(app.release_environments as string[] | undefined)?.map((env) => (
              <div key={env} className="flex items-center gap-3 py-2">
                <span className="shrink-0 rounded bg-violet-50 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-violet-600">
                  {env}
                </span>
                <span className="text-[12px] text-neutral-500">Release environment</span>
              </div>
            ))}
            {app.block_loading_for_setup && (
              <div className="flex items-center gap-3 py-2">
                <span className="shrink-0 rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-amber-700">
                  blocks app loading
                </span>
                <span className="text-[12px] text-neutral-500">
                  Whether this app blocks loading of Kizen UI until resources are fetched and
                  processed
                </span>
              </div>
            )}
            {app.developer_business_id &&
              (typeof app.developer_business_id === 'string' ? (
                <div className="flex items-center gap-3 py-2">
                  <span className="shrink-0 rounded bg-neutral-100 px-2 py-0.5 font-mono text-[11px] tracking-wide text-neutral-500">
                    biz: {app.developer_business_id}
                  </span>
                  <span className="text-[12px] text-neutral-500">Developer business ID</span>
                </div>
              ) : (
                Object.entries(app.developer_business_id as Record<string, string>).map(
                  ([env, id]) => (
                    <div key={env} className="flex items-center gap-3 py-2">
                      <span className="shrink-0 rounded bg-neutral-100 px-2 py-0.5 font-mono text-[11px] tracking-wide text-neutral-500">
                        biz ({env}): {id}
                      </span>
                      <span className="text-[12px] text-neutral-500">
                        Developer business ID ({env})
                      </span>
                    </div>
                  ),
                )
              ))}
            {bundleSizeBytes !== null && (
              <div className="flex items-center gap-3 py-2">
                <span className="shrink-0 rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-neutral-600">
                  bundle: {formatBytes(bundleSizeBytes)}
                </span>
                <span className="text-[12px] text-neutral-500">Total size of bundle.json</span>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Artifact Sections */}
      {hasAnyArtifacts || hasBusinessSetup || hasUserSetup || app.releaseNotes ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {floatingFrames.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Floating Frames
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {floatingFrames.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Name</span>
                <span className="shrink-0">Position</span>
              </div>
              <div className="divide-y divide-black/5">
                {floatingFrames.map((frame, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-900">{frame.name}</div>
                      <div className="truncate font-mono text-[11px] text-neutral-400">
                        {frame.api_name}
                      </div>
                    </div>
                    {frame.default_position && (
                      <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                        {frame.default_position}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {dataAdornments.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Data Adornments
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {dataAdornments.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Field</span>
                <span className="shrink-0">Type</span>
              </div>
              <div className="divide-y divide-black/5">
                {dataAdornments.map((adornment, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    {adornment.config.color && (
                      <span
                        className="h-3 w-4 shrink-0 rounded-sm border border-black/10"
                        style={{ backgroundColor: adornment.config.color }}
                      />
                    )}
                    {adornment.config.icon &&
                      (ICON_MAP[adornment.config.icon] ? (
                        <FontAwesomeIcon
                          icon={ICON_MAP[adornment.config.icon]}
                          className="shrink-0 text-[12px] text-neutral-500"
                        />
                      ) : (
                        <span
                          className={`shrink-0 rounded px-1 font-mono text-[10px] ${VALID_ICONS.has(adornment.config.icon) || CUSTOM_ICON_NAMES.has(adornment.config.icon) ? 'bg-neutral-100 text-neutral-400' : 'bg-amber-100 text-amber-600'}`}
                        >
                          {adornment.config.icon}
                        </span>
                      ))}
                    <div className="min-w-0 flex-1 truncate text-neutral-900">
                      {adornment.config.tooltip || adornment.field_type}
                    </div>
                    <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                      {adornment.field_type}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {routablePages.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Routable Pages
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {routablePages.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Page</span>
                <span className="shrink-0">Type</span>
              </div>
              <div className="divide-y divide-black/5">
                {routablePages.map((page, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-900">{page.name}</div>
                      <div className="truncate font-mono text-[11px] text-neutral-400">
                        {page.api_name}
                      </div>
                    </div>
                    {page.iframe_url && (
                      <span className="shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-600">
                        iframe
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {customBlocks.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Content Blocks
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {customBlocks.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Block</span>
                <span className="shrink-0">Grid (w×h)</span>
              </div>
              <div className="divide-y divide-black/5">
                {customBlocks.map((block, i) => {
                  const dims = resolveBlockDimensions(block);

                  return (
                    <div key={i} className="flex items-center gap-2 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-neutral-900">{block.name}</div>
                        <div className="truncate font-mono text-[11px] text-neutral-400">
                          {block.api_name}
                        </div>
                      </div>
                      {(block.types ?? []).map((surface) => (
                        <span
                          key={surface}
                          className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600"
                        >
                          {surface}
                        </span>
                      ))}
                      <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                        {dims.minW}–{dims.maxW}×{dims.minH}–{dims.maxH}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {toolbarItems.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Toolbar Items
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {toolbarItems.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Label</span>
                <span className="shrink-0">Icon</span>
              </div>
              <div className="divide-y divide-black/5">
                {toolbarItems.map((item, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    {item.color && (
                      <span
                        className="h-3 w-4 shrink-0 rounded-sm border border-black/10"
                        style={{ backgroundColor: item.color }}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-900">{item.label}</div>
                      <div className="truncate font-mono text-[11px] text-neutral-400">
                        {item.api_name}
                      </div>
                    </div>
                    {item.icon &&
                      (ICON_MAP[item.icon] ? (
                        <FontAwesomeIcon
                          icon={ICON_MAP[item.icon]}
                          className="shrink-0 text-[12px] text-neutral-400"
                        />
                      ) : (
                        <span
                          className={`shrink-0 rounded px-1 font-mono text-[10px] ${VALID_ICONS.has(item.icon) || CUSTOM_ICON_NAMES.has(item.icon) ? 'bg-neutral-100 text-neutral-400' : 'bg-amber-100 text-amber-600'}`}
                        >
                          {item.icon}
                        </span>
                      ))}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {jsActions.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  JS Action Templates
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {jsActions.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Name</span>
                <span className="shrink-0">Object</span>
              </div>
              <div className="divide-y divide-black/5">
                {jsActions.map((action, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-900">{action.name}</div>
                      <div className="truncate font-mono text-[11px] text-neutral-400">
                        {action.api_name}
                      </div>
                    </div>
                    {action.hint_object_name && (
                      <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                        {action.hint_object_name}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {routeScripts.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Route Scripts
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {routeScripts.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Name</span>
                <span className="shrink-0">Routes</span>
              </div>
              <div className="divide-y divide-black/5">
                {routeScripts.map((script, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-900">
                        {script.name || script.api_name}
                      </div>
                      {script.name && (
                        <div className="truncate font-mono text-[11px] text-neutral-400">
                          {script.api_name}
                        </div>
                      )}
                    </div>
                    {script.routes.length > 0 && (
                      <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                        {script.routes.length} route{script.routes.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {objectSettings.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Object Settings
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {objectSettings.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Label</span>
              </div>
              <div className="divide-y divide-black/5">
                {objectSettings.map((item, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-900">{item.label}</div>
                      <div className="truncate font-mono text-[11px] text-neutral-400">
                        {item.api_name}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {automationActions.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Automation Actions
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {automationActions.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Name</span>
                <span className="shrink-0">Type</span>
              </div>
              <div className="divide-y divide-black/5">
                {automationActions.map((action, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-900">{action.name}</div>
                      <div className="truncate font-mono text-[11px] text-neutral-400">
                        {action.action_step_api_name}
                      </div>
                    </div>
                    {action.action_type && (
                      <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">
                        {action.action_type}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {calendarSources.length > 0 && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                  Calendar Sources
                </span>
                <span className="ml-auto rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                  {calendarSources.length}
                </span>
              </div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1">Name</span>
              </div>
              <div className="divide-y divide-black/5">
                {calendarSources.map((source, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-900">{source.name}</div>
                      <div className="truncate font-mono text-[11px] text-neutral-400">
                        {source.api_name}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {hasBusinessSetup && setupAssistant && (
            <SetupAssistantSummary title="Setup Assistant" config={setupAssistant} />
          )}

          {hasUserSetup && userSetupAssistant && (
            <SetupAssistantSummary title="User Setup Assistant" config={userSetupAssistant} />
          )}

          {app.releaseNotes && (
            <Card>
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
                Release Notes
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-neutral-700">
                {app.releaseNotes}
              </pre>
            </Card>
          )}
        </div>
      ) : (
        <Card>
          <p className="text-[13px] text-neutral-400">No plugin assets defined.</p>
        </Card>
      )}
    </div>
  );
};
