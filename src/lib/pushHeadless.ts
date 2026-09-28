import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PluginValidationError } from '@kizenapps/packager';
import type { Block, DeployablePlugin, ValidationIssue } from '@kizenapps/packager';
import { APP_URLS, isProductionEnvironment } from '../../shared/lib/kizenUrls.js';
import { loadConfig, type AppBuilderConfig } from './config.js';
import {
  ENVIRONMENTS,
  GLOBAL_CREDENTIALS_PATH,
  listLoadableCredentialProfiles,
  loadCredentialsDetailed,
  type CredentialProfile,
  type Credentials,
  type DetailedCredentials,
  type Environment,
} from './credentials.js';
import {
  findInvalidBlockField,
  invalidBlockMessage,
  packageBlocks,
  selectBlock,
  formatAvailableBlocks,
} from './exportBlock.js';
import { formatValidationIssues } from './formatValidationIssues.js';
import { ensureGitignore } from './gitignore.js';
import { createKizenClient, KizenApiError } from './kizenClient.js';
import type {
  CreateDashletBody,
  CustomCodeContent,
  KizenClient,
  PushMapEntry,
  Surface,
  UpdateDashletBody,
  WireCustomObject,
  WireDashboard,
  WireDashboardSummary,
  WireDashlet,
} from './kizenTypes.js';
import {
  buildCreateBody,
  buildDashboardUrl,
  buildUpdateBody,
  canonicalContentHash,
  customCodeName,
  dashboardTypeToSurface,
  detectDrift,
  findCustomCodeDashlets,
  findPushMapEntry,
  isCustomCodeDashlet,
  matchPushTarget,
  parsePushKey,
  PUSH_MAP_RELATIVE_PATH,
  readPushMap,
  removePushMapEntry,
  toCustomCodeContent,
  upsertPushMapEntry,
  writePushMap,
  type PushMapKey,
} from './pushBlock.js';
import { isClaudeSkillStale, STALE_CLAUDE_SKILL_WARNING } from './setupClaude.js';

export type PushErrorCode =
  | 'needs_choice'
  | 'validation_failed'
  | 'invalid_block'
  | 'auth_failed'
  | 'forbidden'
  | 'remembered_target_missing'
  | 'drift_detected'
  | 'network_error'
  | 'credentials_invalid'
  | 'production_requires_flag'
  | 'not_found'
  | 'usage_error'
  | 'api_error'
  | 'local_error';

export type ChoiceKind = 'profile' | 'block' | 'dashboard' | 'target';

export interface PushChoice {
  value: string;
  label: string;
  args: string[];
  surface?: Surface;
  canEdit?: boolean | null;
  pushKey?: string | null;
  isFromThisPlugin?: boolean;
}

export interface PushFailure {
  ok: false;
  code: PushErrorCode;
  message: string;
  choice?: ChoiceKind;
  choices?: PushChoice[];
  issues?: ValidationIssue[];
  field?: string;
  hint?: string;
}

export type Step<T> = { ok: true; value: T } | PushFailure;

export interface PushCommandOptions {
  credentials?: string;
  profile?: string;
  dashboard?: string;
  dashlet?: string;
  create?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  allowProduction?: boolean;
  force?: boolean;
  forget?: boolean;
  json?: boolean;
}

export interface TargetsCommandOptions {
  credentials?: string;
  profile?: string;
  object?: string;
  json?: boolean;
}

export interface PushDeps {
  cwd: string;
  loadCredentialsDetailed: (path: string) => Promise<DetailedCredentials>;
  listLoadableCredentialProfiles: () => Promise<CredentialProfile[]>;
  loadConfig: (outputDir: string) => Promise<AppBuilderConfig>;
  packageBlocks: (
    dir: string,
  ) => Promise<{ deployable: DeployablePlugin[]; warnings: ValidationIssue[] }>;
  createClient: (credentials: Credentials) => KizenClient;
  readPushMap: (dir: string) => Promise<PushMapEntry[]>;
  writePushMap: (dir: string, entries: readonly PushMapEntry[]) => Promise<void>;
  ensureGitignore: (dir: string) => void;
  isClaudeSkillStale: (dir: string) => Promise<boolean>;
  randomUUID: () => string;
  now: () => Date;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

export function createDefaultPushDeps(cwd: string): PushDeps {
  return {
    cwd,
    loadCredentialsDetailed,
    listLoadableCredentialProfiles,
    loadConfig,
    packageBlocks,
    createClient: (credentials) => createKizenClient({ credentials }),
    readPushMap,
    writePushMap,
    ensureGitignore,
    isClaudeSkillStale: (dir) => isClaudeSkillStale(dir),
    randomUUID,
    now: () => new Date(),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

const EDIT_ACCESS_LEVELS = new Set(['owner', 'admin', 'edit']);

const CHART_GROUP_HINT =
  'Chart groups are not listed here; find them with `appbuilder block targets --object <id> --json` and pass --dashboard <id>.';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

function failure(
  code: PushErrorCode,
  message: string,
  extra: Omit<PushFailure, 'ok' | 'code' | 'message'> = {},
): PushFailure {
  return { ok: false, code, message, ...extra };
}

const success = <T>(value: T): Step<T> => ({ ok: true, value });

export function apiFailure(error: unknown): PushFailure {
  if (error instanceof KizenApiError) {
    return failure(error.kind, error.message, error.hint === undefined ? {} : { hint: error.hint });
  }

  if (error instanceof PluginValidationError) {
    return failure('validation_failed', formatValidationIssues(error.issues), {
      issues: error.issues,
    });
  }

  return failure('local_error', errorMessage(error));
}

export interface ResolvedCredentials {
  credentials: Credentials;
  source: { kind: 'file'; path: string } | { kind: 'profile'; name: string; path: string };
}

const environmentList = (): string => ENVIRONMENTS.join(', ');

async function loadCredentialSource(
  source: ResolvedCredentials['source'],
  deps: PushDeps,
): Promise<Step<ResolvedCredentials>> {
  let detailed: DetailedCredentials;

  try {
    detailed = await deps.loadCredentialsDetailed(source.path);
  } catch (error) {
    return failure(
      'credentials_invalid',
      `Couldn't read credentials from ${source.path}: ${errorMessage(error)}`,
    );
  }

  if (detailed.environmentSource !== 'explicit') {
    const problem =
      detailed.environmentSource === 'missing'
        ? 'has no "environment"'
        : 'has an invalid "environment"';

    return failure(
      'credentials_invalid',
      `${source.path} ${problem}. Set it to one of: ${environmentList()}. The CLI won't default to production.`,
    );
  }

  const { credentials } = detailed;
  const empty = (['apiKey', 'userId', 'businessId'] as const).filter(
    (field) => credentials[field].trim() === '',
  );

  if (empty.length > 0) {
    return failure(
      'credentials_invalid',
      `${source.path} is missing ${empty.map((field) => `"${field}"`).join(', ')}.`,
    );
  }

  return success({ credentials, source });
}

const profileSource = (profile: CredentialProfile): ResolvedCredentials['source'] => ({
  kind: 'profile',
  name: profile.name,
  path: profile.path,
});

export async function resolveCredentials(
  options: { credentials?: string; profile?: string },
  deps: PushDeps,
): Promise<Step<ResolvedCredentials>> {
  if (options.credentials !== undefined) {
    return loadCredentialSource({ kind: 'file', path: options.credentials }, deps);
  }

  const profiles = await deps.listLoadableCredentialProfiles();
  const names = profiles.map((profile) => profile.name);

  if (options.profile !== undefined) {
    const profile = profiles.find((candidate) => candidate.name === options.profile);

    if (!profile) {
      return failure(
        'credentials_invalid',
        names.length === 0
          ? `No loadable credential profile named "${options.profile}". No profiles are loadable; create ${GLOBAL_CREDENTIALS_PATH} or pass -c <path>.`
          : `No loadable credential profile named "${options.profile}". Loadable profiles: ${names.join(', ')}`,
      );
    }

    return loadCredentialSource(profileSource(profile), deps);
  }

  const config = await deps.loadConfig(join(deps.cwd, '.kizenapp'));

  if (config.credentialMode === 'local') {
    return failure(
      'credentials_invalid',
      "This plugin is set to use local browser-only credentials the CLI can't read. Pass -c <path> or --profile <name>.",
    );
  }

  const active =
    config.activeCredentialProfile === undefined
      ? undefined
      : profiles.find((candidate) => candidate.name === config.activeCredentialProfile);

  if (active) {
    return loadCredentialSource(profileSource(active), deps);
  }

  const [only] = profiles;

  if (profiles.length === 1 && only) {
    return loadCredentialSource(profileSource(only), deps);
  }

  if (profiles.length === 0) {
    return failure(
      'credentials_invalid',
      `No credentials found. Create ${GLOBAL_CREDENTIALS_PATH} or pass -c <path>.`,
    );
  }

  return failure(
    'needs_choice',
    `Several credential profiles are available; pass --profile <name>: ${names.join(', ')}`,
    {
      choice: 'profile',
      choices: profiles.map((profile) => ({
        value: profile.name,
        label: profile.isDefault ? `${profile.name} (default)` : profile.name,
        args: ['--profile', profile.name],
      })),
    },
  );
}

export interface ResolvedBlock {
  block: Block;
  pluginApiName: string;
  content: CustomCodeContent;
  contentHash: string;
  warnings: ValidationIssue[];
}

function blockChoices(
  deployable: DeployablePlugin[],
  available: { pluginApiName: string; apiName: string }[],
): PushChoice[] {
  const multiplePlugins = new Set(available.map((entry) => entry.pluginApiName)).size > 1;

  return available.map(({ pluginApiName, apiName }) => {
    const block = deployable
      .find((plugin) => plugin.api_name === pluginApiName)
      ?.artifacts.custom_blocks.find((candidate) => candidate.api_name === apiName);
    const qualified = multiplePlugins ? `${pluginApiName}/${apiName}` : apiName;

    return {
      value: apiName,
      label: `${block?.name ?? apiName} (${qualified})`,
      args: [apiName],
    };
  });
}

function blockSelectionMessage(
  selection: Extract<ReturnType<typeof selectBlock>, { ok: false }>,
  apiName: string | undefined,
): string {
  const list = formatAvailableBlocks(selection.available);

  if (selection.reason === 'no_blocks') {
    return 'This plugin has no blocks. Scaffold one with `appbuilder create --artifacts block`.';
  }

  if (selection.reason === 'not_found') {
    return `No block with api_name "${apiName ?? ''}". Available blocks: ${list}`;
  }

  return apiName === undefined
    ? `This plugin has several blocks; pass the api_name of the one to push: ${list}`
    : `More than one plugin has a block with api_name "${apiName}": ${list}`;
}

export async function resolveBlock(
  apiName: string | undefined,
  deps: PushDeps,
): Promise<Step<ResolvedBlock>> {
  let packaged: { deployable: DeployablePlugin[]; warnings: ValidationIssue[] };

  try {
    packaged = await deps.packageBlocks(deps.cwd);
  } catch (error) {
    if (error instanceof PluginValidationError) {
      return failure('validation_failed', formatValidationIssues(error.issues), {
        issues: error.issues,
      });
    }

    throw error;
  }

  const selection = selectBlock(packaged.deployable, apiName);

  if (!selection.ok) {
    const message = blockSelectionMessage(selection, apiName);

    if (selection.reason === 'no_blocks') {
      return failure('invalid_block', message);
    }

    return failure('needs_choice', message, {
      choice: 'block',
      choices: blockChoices(packaged.deployable, selection.available),
    });
  }

  const field = findInvalidBlockField(selection.block);

  if (field !== undefined) {
    return failure('invalid_block', invalidBlockMessage(selection.block.api_name, field), {
      field,
    });
  }

  const content = toCustomCodeContent(selection.block);

  return success({
    block: selection.block,
    pluginApiName: selection.pluginApiName,
    content,
    contentHash: canonicalContentHash(content),
    warnings: packaged.warnings,
  });
}

export interface TargetRow {
  id: string;
  name: string;
  type: Surface;
  dashletsCount: number | null;
  employeeAccess: string | null;
  hidden: boolean;
  canEdit: boolean | null;
}

export interface TargetCustomObject {
  id: string;
  objectName: string;
  fetchUrl: string;
}

export type TargetsResult =
  | {
      ok: true;
      environment: Environment;
      businessId: string;
      surfaces: { dashboard: TargetRow[]; homepage: TargetRow[] };
      customObjects: TargetCustomObject[];
    }
  | {
      ok: true;
      environment: Environment;
      businessId: string;
      object: TargetCustomObject | null;
      surfaces: { chart_group: TargetRow[] };
    };

const canEditFor = (employeeAccess: string | null | undefined): boolean | null =>
  employeeAccess === undefined || employeeAccess === null
    ? null
    : EDIT_ACCESS_LEVELS.has(employeeAccess.toLowerCase());

export function toTargetRow(summary: WireDashboardSummary, surface: Surface): TargetRow {
  return {
    id: summary.id,
    name: summary.name,
    type: surface,
    dashletsCount: summary.dashlets_count ?? null,
    employeeAccess: summary.employee_access ?? null,
    hidden: summary.hidden ?? false,
    canEdit: canEditFor(summary.employee_access),
  };
}

const toTargetCustomObject = (object: WireCustomObject): TargetCustomObject => ({
  id: object.id,
  objectName: object.object_name,
  fetchUrl: object.fetch_url,
});

const CONTACTS_OBJECT_NAME = 'Contacts';

export async function listPushableObjects(client: KizenClient): Promise<TargetCustomObject[]> {
  const [objects, clientObjectId] = await Promise.all([
    client.listCustomObjects(),
    client.getClientObjectId().catch((): null => null),
  ]);
  const pushable = objects
    .map(toTargetCustomObject)
    .sort((left, right) => left.objectName.localeCompare(right.objectName));

  if (
    clientObjectId !== null &&
    clientObjectId !== '' &&
    !pushable.some((object) => object.id === clientObjectId)
  ) {
    pushable.push({ id: clientObjectId, objectName: CONTACTS_OBJECT_NAME, fetchUrl: 'client' });
  }

  return pushable;
}

export async function listTargets(
  client: KizenClient,
  credentials: Credentials,
  options: { object?: string },
): Promise<Step<TargetsResult>> {
  const { environment, businessId } = credentials;

  try {
    if (options.object !== undefined) {
      const objectId = options.object;
      const [object, chartGroups] = await Promise.all([
        client.getCustomObject(objectId).catch((): null => null),
        client.listDashboards('chart_group', objectId),
      ]);

      return success({
        ok: true,
        environment,
        businessId,
        object: object ? toTargetCustomObject(object) : null,
        surfaces: { chart_group: chartGroups.map((row) => toTargetRow(row, 'chart_group')) },
      });
    }

    const [dashboards, homepages, customObjects] = await Promise.all([
      client.listDashboards('generic_dashboard'),
      client.listDashboards('homepage'),
      listPushableObjects(client),
    ]);

    return success({
      ok: true,
      environment,
      businessId,
      surfaces: {
        dashboard: dashboards.map((row) => toTargetRow(row, 'dashboard')),
        homepage: homepages.map((row) => toTargetRow(row, 'homepage')),
      },
      customObjects,
    });
  } catch (error) {
    return apiFailure(error);
  }
}

export interface PushContext {
  client: KizenClient;
  credentials: Credentials;
  block: ResolvedBlock;
  pushMap: PushMapEntry[];
  entry: PushMapEntry | undefined;
}

export type ResolvedBy = 'flag' | 'remembered' | 'push_map' | 'name';

export interface ResolvedTarget {
  dashboard: WireDashboard;
  surface: Surface;
  action: 'create' | 'update';
  dashlet: WireDashlet | undefined;
  resolvedBy: ResolvedBy;
}

const isMemberDashlet = (dashboard: WireDashboard, dashlet: WireDashlet): boolean =>
  dashlet.dashboard === dashboard.id;

export function buildTargetChoices(dashboard: WireDashboard, block: ResolvedBlock): PushChoice[] {
  const existing = findCustomCodeDashlets(dashboard)
    .filter((dashlet) => isMemberDashlet(dashboard, dashlet))
    .map((dashlet): PushChoice => {
      const parsed = parsePushKey(dashlet.name);

      return {
        value: dashlet.id,
        label: customCodeName(dashlet),
        args: ['--dashboard', dashboard.id, '--dashlet', dashlet.id],
        pushKey: parsed ? dashlet.name : null,
        isFromThisPlugin: parsed?.pluginApiName === block.pluginApiName,
      };
    });

  return [
    ...existing,
    { value: 'new', label: 'Create a new block', args: ['--dashboard', dashboard.id, '--create'] },
  ];
}

function target(
  dashboard: WireDashboard,
  action: 'create' | 'update',
  dashlet: WireDashlet | undefined,
  resolvedBy: ResolvedBy,
): Step<ResolvedTarget> {
  return success({
    dashboard,
    surface: dashboardTypeToSurface(dashboard.type),
    action,
    dashlet,
    resolvedBy,
  });
}

async function chooseDashboard(context: PushContext): Promise<Step<ResolvedTarget>> {
  const [dashboards, homepages] = await Promise.all([
    context.client.listDashboards('generic_dashboard'),
    context.client.listDashboards('homepage'),
  ]);
  const toChoice =
    (surface: Surface) =>
    (summary: WireDashboardSummary): PushChoice => ({
      value: summary.id,
      label: summary.name,
      args: ['--dashboard', summary.id],
      surface,
      canEdit: canEditFor(summary.employee_access),
    });

  return failure(
    'needs_choice',
    `Choose where to push; pass --dashboard <id>. ${CHART_GROUP_HINT}`,
    {
      choice: 'dashboard',
      choices: [...dashboards.map(toChoice('dashboard')), ...homepages.map(toChoice('homepage'))],
    },
  );
}

async function resolveFlaggedDashboard(
  context: PushContext,
  dashboardId: string,
  options: PushCommandOptions,
): Promise<Step<ResolvedTarget>> {
  const dashboard = await context.client.getDashboard(dashboardId);

  if (options.create) {
    return target(dashboard, 'create', undefined, 'flag');
  }

  const choices = (): PushChoice[] => buildTargetChoices(dashboard, context.block);

  if (options.dashlet !== undefined) {
    const dashletId = options.dashlet;
    const dashlet = dashboard.dashlets.find(
      (candidate) => candidate.id === dashletId && isMemberDashlet(dashboard, candidate),
    );

    if (!dashlet) {
      return failure(
        'not_found',
        `Dashlet ${dashletId} is not on dashboard "${dashboard.name}" (${dashboard.id}).`,
        { choice: 'target', choices: choices() },
      );
    }

    if (!isCustomCodeDashlet(dashlet)) {
      return failure(
        'usage_error',
        `Dashlet ${dashletId} is not a custom code block, so it can't be updated with a pushed block. Pass --create to add a new one.`,
      );
    }

    return target(dashboard, 'update', dashlet, 'flag');
  }

  const match = matchPushTarget({
    dashboardId: dashboard.id,
    dashlets: dashboard.dashlets,
    pluginApiName: context.block.pluginApiName,
    blockApiName: context.block.block.api_name,
    entry: context.entry,
  });

  if (match.kind === 'map') {
    return target(dashboard, 'update', match.dashlet, 'push_map');
  }

  if (match.kind === 'name') {
    return target(dashboard, 'update', match.dashlet, 'name');
  }

  return failure(
    'needs_choice',
    match.kind === 'ambiguous'
      ? `Dashboard "${dashboard.name}" has ${String(match.dashlets.length)} blocks pushed from this block; pass --dashlet <id> to pick one, or --create.`
      : `Choose a block to update on "${dashboard.name}", or create a new one; pass --dashlet <id> or --create.`,
    { choice: 'target', choices: choices() },
  );
}

async function resolveRemembered(
  context: PushContext,
  entry: PushMapEntry,
  options: PushCommandOptions,
): Promise<Step<ResolvedTarget>> {
  let dashboard: WireDashboard;

  try {
    dashboard = await context.client.getDashboard(entry.dashboardId);
  } catch (error) {
    if (error instanceof KizenApiError && error.kind === 'not_found') {
      return failure(
        'remembered_target_missing',
        `The remembered dashboard ${entry.dashboardId} no longer exists. Pass --dashboard <id> to choose another, or --forget to clear it.`,
      );
    }

    throw error;
  }

  if (options.create) {
    return target(dashboard, 'create', undefined, 'remembered');
  }

  const dashlet = dashboard.dashlets.find(
    (candidate) => candidate.id === entry.dashletId && isMemberDashlet(dashboard, candidate),
  );

  if (dashlet && isCustomCodeDashlet(dashlet)) {
    return target(dashboard, 'update', dashlet, 'remembered');
  }

  return failure(
    'remembered_target_missing',
    `The remembered block (dashlet ${entry.dashletId}) is no longer on "${dashboard.name}". Choose a block to update, or create a new one.`,
    { choice: 'target', choices: buildTargetChoices(dashboard, context.block) },
  );
}

export async function resolveTarget(
  context: PushContext,
  options: PushCommandOptions,
): Promise<Step<ResolvedTarget>> {
  if (options.dashlet !== undefined && options.create) {
    return failure('usage_error', 'Pass either --dashlet <id> or --create, not both.');
  }

  if (options.dashlet !== undefined && options.dashboard === undefined) {
    return failure('usage_error', '--dashlet <id> needs --dashboard <id>.');
  }

  try {
    if (options.dashboard !== undefined) {
      return await resolveFlaggedDashboard(context, options.dashboard, options);
    }

    if (context.entry) {
      return await resolveRemembered(context, context.entry, options);
    }

    return await chooseDashboard(context);
  } catch (error) {
    return apiFailure(error);
  }
}

export interface PushSummary {
  environment: Environment;
  businessId: string;
  isProduction: boolean;
  surface: Surface;
  dashboardId: string;
  dashboardName: string;
  action: 'create' | 'update';
  actionLine: string;
  dashletId: string | null;
  blockName: string;
  blockApiName: string;
  pluginApiName: string;
  scriptBytes: number;
  stylesBytes: number;
}

export interface PushPlan {
  action: 'create' | 'update';
  method: 'POST' | 'PATCH';
  path: string;
  body: CreateDashletBody | UpdateDashletBody;
  dashboard: { id: string; name: string; type: Surface };
  dashletId: string | null;
  url: string;
  resolvedBy: ResolvedBy;
  summary: PushSummary;
  warnings: string[];
}

async function customObjectOf(
  client: KizenClient,
  dashboard: WireDashboard,
  surface: Surface,
): Promise<{ id: string; fetchUrl?: string } | null> {
  const raw: unknown = dashboard.custom_object;

  if (raw === null || raw === undefined || raw === '') {
    return null;
  }

  if (typeof raw !== 'string') {
    if (typeof raw !== 'object' || typeof (raw as { id?: unknown }).id !== 'string') {
      return null;
    }

    const { id, fetch_url: fetchUrl } = raw as { id: string; fetch_url?: unknown };

    return typeof fetchUrl === 'string' ? { id, fetchUrl } : { id };
  }

  if (surface !== 'chart_group') {
    return { id: raw };
  }

  try {
    const object = await client.getCustomObject(raw);

    return { id: raw, fetchUrl: object.fetch_url };
  } catch {
    return { id: raw };
  }
}

const segment = encodeURIComponent;

export async function buildPlan(
  context: PushContext,
  resolved: ResolvedTarget,
  options: Pick<PushCommandOptions, 'force'>,
  deps: Pick<PushDeps, 'randomUUID'>,
): Promise<Step<PushPlan>> {
  const { credentials, block } = context;
  const { dashboard, surface, dashlet } = resolved;
  const warnings: string[] = [];
  let body: CreateDashletBody | UpdateDashletBody;
  let path: string;
  let actionLine: string;

  if (resolved.action === 'update') {
    if (!dashlet) {
      return failure('usage_error', 'An update needs a dashlet to update.');
    }

    if (detectDrift(dashlet, context.entry)) {
      const drift = `"${customCodeName(dashlet)}" (dashlet ${dashlet.id}) was changed in Kizen since the last push.`;

      if (!options.force) {
        return failure(
          'drift_detected',
          `${drift} Pushing would overwrite those changes; pass --force to overwrite them.`,
        );
      }

      warnings.push(`${drift} Overwriting it because of --force.`);
    }

    body = buildUpdateBody(dashlet, block.content);
    path = `/dashboards/${segment(dashboard.id)}/dashlet/${segment(dashlet.id)}`;
    actionLine = `Update "${customCodeName(dashlet)}" (dashlet ${dashlet.id})`;
  } else {
    body = buildCreateBody({
      pluginApiName: block.pluginApiName,
      blockApiName: block.block.api_name,
      content: block.content,
      dashlets: dashboard.dashlets,
      objectId: deps.randomUUID(),
      layoutId: deps.randomUUID(),
    });
    path = `/dashboards/${segment(dashboard.id)}/dashlet`;
    actionLine = `Create a new block on "${dashboard.name}"`;
  }

  const dashletId = resolved.action === 'update' && dashlet ? dashlet.id : null;
  const url = buildDashboardUrl({
    appBaseUrl: APP_URLS[credentials.environment],
    surface,
    dashboardId: dashboard.id,
    customObject: await customObjectOf(context.client, dashboard, surface),
  });

  return success({
    action: resolved.action,
    method: resolved.action === 'update' ? 'PATCH' : 'POST',
    path,
    body,
    dashboard: { id: dashboard.id, name: dashboard.name, type: surface },
    dashletId,
    url,
    resolvedBy: resolved.resolvedBy,
    warnings,
    summary: {
      environment: credentials.environment,
      businessId: credentials.businessId,
      isProduction: isProductionEnvironment(credentials.environment),
      surface,
      dashboardId: dashboard.id,
      dashboardName: dashboard.name,
      action: resolved.action,
      actionLine,
      dashletId,
      blockName: block.block.name,
      blockApiName: block.block.api_name,
      pluginApiName: block.pluginApiName,
      scriptBytes: Buffer.byteLength(block.content.script, 'utf8'),
      stylesBytes: Buffer.byteLength(block.content.styles, 'utf8'),
    },
  });
}

export interface AppliedPush {
  dashletId: string;
  remembered: boolean;
  warnings: string[];
}

export const pushMapKeyOf = (context: Pick<PushContext, 'credentials' | 'block'>): PushMapKey => ({
  environment: context.credentials.environment,
  businessId: context.credentials.businessId,
  pluginApiName: context.block.pluginApiName,
  blockApiName: context.block.block.api_name,
});

export async function applyPlan(
  context: PushContext,
  plan: PushPlan,
  deps: PushDeps,
): Promise<Step<AppliedPush>> {
  let dashletId: string;

  try {
    if (plan.action === 'create') {
      const created = await context.client.createDashlet(
        plan.dashboard.id,
        plan.body as CreateDashletBody,
      );

      const createdId: unknown = created.id;

      if (typeof createdId !== 'string' || createdId === '') {
        return failure(
          'api_error',
          `POST ${plan.path} succeeded but the response had no dashlet id; check "${plan.dashboard.name}" before pushing again.`,
        );
      }

      dashletId = createdId;
    } else {
      if (plan.dashletId === null) {
        return failure('usage_error', 'An update needs a dashlet to update.');
      }

      await context.client.updateDashlet(plan.dashboard.id, plan.dashletId, plan.body);
      dashletId = plan.dashletId;
    }
  } catch (error) {
    return apiFailure(error);
  }

  const warnings = [...plan.warnings];
  const entry: PushMapEntry = {
    ...pushMapKeyOf(context),
    dashboardId: plan.dashboard.id,
    dashletId,
    contentHash: context.block.contentHash,
    pushedAt: deps.now().toISOString(),
  };
  let remembered = false;

  try {
    deps.ensureGitignore(deps.cwd);
    await deps.writePushMap(deps.cwd, upsertPushMapEntry(context.pushMap, entry));
    remembered = true;
  } catch (error) {
    warnings.push(
      `The push succeeded, but ${PUSH_MAP_RELATIVE_PATH} couldn't be written, so this target isn't remembered: ${errorMessage(error)}`,
    );
  }

  return success({ dashletId, remembered, warnings });
}

export interface BrowserRefresh {
  dashboardId: string;
  script: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildBrowserRefresh(dashboardId: string): BrowserRefresh | null {
  if (!UUID_PATTERN.test(dashboardId)) {
    return null;
  }

  return {
    dashboardId,
    script: `await window.__kizenCustomBlocks?.refresh('${dashboardId}')`,
  };
}

export async function forgetRemembered(
  context: Pick<PushContext, 'credentials' | 'block' | 'pushMap'>,
  deps: Pick<PushDeps, 'cwd' | 'writePushMap'>,
): Promise<boolean> {
  const key = pushMapKeyOf(context);

  if (!findPushMapEntry(context.pushMap, key)) {
    return false;
  }

  await deps.writePushMap(deps.cwd, removePushMapEntry(context.pushMap, key));

  return true;
}

export type WriteGate = { kind: 'dry-run'; reason: 'flag' | 'no_yes' } | { kind: 'apply' };

export function headlessWriteGate(
  options: PushCommandOptions,
  environment: Environment,
): Step<WriteGate> {
  if (options.dryRun) {
    return success({ kind: 'dry-run', reason: 'flag' });
  }

  if (!options.yes) {
    return success({ kind: 'dry-run', reason: 'no_yes' });
  }

  if (isProductionEnvironment(environment) && !options.allowProduction) {
    return failure(
      'production_requires_flag',
      `${environment} is a production environment. Pass --allow-production with --yes to write to it.`,
    );
  }

  return success({ kind: 'apply' });
}

export const DRY_RUN_NOTE = 'Dry run only: pass --yes to write.';

export function formatSummaryLines(summary: PushSummary): string[] {
  return [
    `Environment: ${summary.environment}${summary.isProduction ? ' (production)' : ''}`,
    `Business: ${summary.businessId}`,
    `Surface: ${summary.surface}`,
    `Dashboard: "${summary.dashboardName}" (${summary.dashboardId})`,
    `Action: ${summary.actionLine}`,
    `Block: ${summary.blockName} (${summary.pluginApiName}/${summary.blockApiName})`,
    `Size: script ${String(summary.scriptBytes)} bytes, styles ${String(summary.stylesBytes)} bytes`,
  ];
}

const formatIssueWarning = (issue: ValidationIssue): string =>
  `${issue.path === undefined ? '' : `${issue.path}: `}${issue.message} (${issue.rule})`;

const quoteArg = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : JSON.stringify(arg));

type ChoiceArgs = (choice: PushChoice, kind: ChoiceKind | undefined) => string[];

function formatFailureText(result: PushFailure, command: string, choiceArgs: ChoiceArgs): string {
  const lines = [`Error: ${result.message}`];

  if (result.hint !== undefined) {
    lines.push(`Hint: ${result.hint}`);
  }

  if (result.choices && result.choices.length > 0) {
    lines.push('Choices:');

    for (const choice of result.choices) {
      const args = choiceArgs(choice, result.choice).map(quoteArg).join(' ');

      lines.push(`  ${choice.label}  →  ${command} ${args}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

interface Output {
  json: boolean;
  deps: PushDeps;
}

function writeFailure(
  output: Output,
  result: PushFailure,
  command: string,
  choiceArgs: ChoiceArgs,
): void {
  if (output.json) {
    output.deps.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    output.deps.writeStderr(formatFailureText(result, command, choiceArgs));
  }

  output.deps.setExitCode(1);
}

const credentialArgs = (options: { credentials?: string; profile?: string }): string[] => {
  if (options.credentials !== undefined) {
    return ['-c', options.credentials];
  }

  return options.profile === undefined ? [] : ['--profile', options.profile];
};

async function claudeSkillWarnings(deps: PushDeps): Promise<string[]> {
  try {
    return (await deps.isClaudeSkillStale(deps.cwd)) ? [STALE_CLAUDE_SKILL_WARNING] : [];
  } catch {
    return [];
  }
}

export async function runPushHeadless(
  apiName: string | undefined,
  options: PushCommandOptions,
  deps: PushDeps,
): Promise<void> {
  const output: Output = { json: options.json === true, deps };
  const command = 'appbuilder block push';
  let blockArgs = apiName === undefined ? [] : [apiName];
  const choiceArgs: ChoiceArgs = (choice, kind) => {
    if (kind === 'profile') {
      return [...blockArgs, ...choice.args];
    }

    if (kind === 'block') {
      return [...choice.args, ...credentialArgs(options)];
    }

    return [...blockArgs, ...credentialArgs(options), ...choice.args];
  };

  const fail = (result: PushFailure): void => {
    writeFailure(output, result, command, choiceArgs);
  };

  try {
    const credentialStep = await resolveCredentials(options, deps);

    if (!credentialStep.ok) {
      fail(credentialStep);

      return;
    }

    const { credentials } = credentialStep.value;
    const client = deps.createClient(credentials);
    const blockStep = await resolveBlock(apiName, deps);

    if (!blockStep.ok) {
      fail(blockStep);

      return;
    }

    const block = blockStep.value;

    blockArgs = [block.block.api_name];

    if (block.warnings.length > 0) {
      deps.writeStderr(`${formatValidationIssues(block.warnings)}\n`);
    }

    const context: PushContext = { client, credentials, block, pushMap: [], entry: undefined };

    context.pushMap = await deps.readPushMap(deps.cwd);

    let forgotten = false;

    if (options.forget) {
      forgotten = await forgetRemembered(context, deps);

      if (forgotten) {
        context.pushMap = removePushMapEntry(context.pushMap, pushMapKeyOf(context));
        deps.writeStderr(`Forgot the remembered target for ${block.block.api_name}.\n`);
      }
    }

    context.entry = findPushMapEntry(context.pushMap, pushMapKeyOf(context));

    const targetStep = await resolveTarget(context, options);

    if (!targetStep.ok) {
      fail(targetStep);

      return;
    }

    const gateStep = headlessWriteGate(options, credentials.environment);

    if (!gateStep.ok) {
      fail(gateStep);

      return;
    }

    const planStep = await buildPlan(context, targetStep.value, options, deps);

    if (!planStep.ok) {
      fail(planStep);

      return;
    }

    const plan = planStep.value;
    const blockInfo = {
      pluginApiName: block.pluginApiName,
      apiName: block.block.api_name,
      name: block.block.name,
    };
    const common = {
      environment: credentials.environment,
      businessId: credentials.businessId,
      dashboard: plan.dashboard,
    };
    const issueWarnings = [
      ...block.warnings.map(formatIssueWarning),
      ...(await claudeSkillWarnings(deps)),
    ];
    const gate = gateStep.value;

    if (gate.kind === 'dry-run') {
      const warnings = [...issueWarnings, ...plan.warnings];
      const result = {
        ok: true as const,
        applied: false as const,
        dryRun: true as const,
        reason: gate.reason,
        action: plan.action,
        ...common,
        dashletId: plan.dashletId,
        url: plan.url,
        resolvedBy: plan.resolvedBy,
        block: blockInfo,
        method: plan.method,
        path: plan.path,
        body: plan.body,
        warnings,
        ...(forgotten ? { forgotten: true as const } : {}),
      };

      if (output.json) {
        deps.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
        deps.writeStderr(
          [...formatSummaryLines(plan.summary), ...warnings.map((w) => `Warning: ${w}`), ''].join(
            '\n',
          ),
        );
      } else {
        deps.writeStdout(
          [
            ...formatSummaryLines(plan.summary),
            `URL: ${plan.url}`,
            ...warnings.map((warning) => `Warning: ${warning}`),
            '',
            `${plan.method} ${plan.path}`,
            JSON.stringify(plan.body, null, 2),
            '',
          ].join('\n'),
        );
      }

      if (gate.reason === 'no_yes') {
        deps.writeStderr(`${DRY_RUN_NOTE}\n`);
      }

      return;
    }

    const appliedStep = await applyPlan(context, plan, deps);

    if (!appliedStep.ok) {
      fail(appliedStep);

      return;
    }

    const applied = appliedStep.value;
    const warnings = [...issueWarnings, ...applied.warnings];
    const refresh = buildBrowserRefresh(plan.dashboard.id);
    const result = {
      ok: true as const,
      applied: true as const,
      dryRun: false as const,
      action: plan.action === 'create' ? ('created' as const) : ('updated' as const),
      ...common,
      dashletId: applied.dashletId,
      url: plan.url,
      ...(refresh ? { refresh } : {}),
      resolvedBy: plan.resolvedBy,
      block: blockInfo,
      remembered: applied.remembered,
      warnings,
      ...(forgotten ? { forgotten: true as const } : {}),
    };

    const text = [
      `✓ ${result.action === 'created' ? 'Created' : 'Updated'} ${block.block.name} on "${plan.dashboard.name}" (dashlet ${applied.dashletId})`,
      ...formatSummaryLines(plan.summary),
      `URL: ${plan.url}`,
      ...(refresh ? [`Refresh an open tab: ${refresh.script}`] : []),
      ...warnings.map((warning) => `Warning: ${warning}`),
      '',
    ].join('\n');

    if (output.json) {
      deps.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
      deps.writeStderr(text);
    } else {
      deps.writeStdout(text);
    }
  } catch (error) {
    fail(apiFailure(error));
  }
}

const pad = (value: string, width: number): string => value.padEnd(width);

function formatTargetTable(title: string, rows: TargetRow[]): string[] {
  if (rows.length === 0) {
    return [title, '  (none)'];
  }

  const header = ['NAME', 'ID', 'DASHLETS', 'ACCESS'];
  const cells = rows.map((row) => [
    `${row.name}${row.hidden ? ' (hidden)' : ''}`,
    row.id,
    row.dashletsCount === null ? '-' : String(row.dashletsCount),
    `${row.employeeAccess ?? '-'}${row.canEdit === false ? ' (no edit access)' : ''}`,
  ]);
  const widths = header.map((label, index) =>
    Math.max(label.length, ...cells.map((cell) => (cell[index] ?? '').length)),
  );
  const line = (cell: string[]): string =>
    `  ${cell.map((value, index) => pad(value, widths[index] ?? 0)).join('  ')}`.trimEnd();

  return [title, line(header), ...cells.map(line)];
}

function formatTargetsText(result: TargetsResult): string {
  const lines = [`Environment: ${result.environment}`, `Business: ${result.businessId}`, ''];

  if ('object' in result) {
    lines.push(
      result.object === null
        ? 'Custom object: not found in /custom-objects'
        : `Custom object: ${result.object.objectName} (${result.object.id})`,
      '',
      ...formatTargetTable('Chart groups', result.surfaces.chart_group),
    );
  } else {
    lines.push(
      ...formatTargetTable('Dashboards', result.surfaces.dashboard),
      '',
      ...formatTargetTable('Homepages', result.surfaces.homepage),
      '',
      'Custom objects',
      ...(result.customObjects.length === 0
        ? ['  (none)']
        : result.customObjects.map((object) => `  ${object.objectName}  ${object.id}`)),
      '',
      'List an object’s chart groups with `appbuilder block targets --object <id>`.',
    );
  }

  return `${lines.join('\n')}\n`;
}

export async function runTargetsHeadless(
  options: TargetsCommandOptions,
  deps: PushDeps,
): Promise<void> {
  const output: Output = { json: options.json === true, deps };
  const command = 'appbuilder block targets';
  const objectArgs = options.object === undefined ? [] : ['--object', options.object];
  const choiceArgs: ChoiceArgs = (choice) => [...choice.args, ...objectArgs];
  const fail = (result: PushFailure): void => {
    writeFailure(output, result, command, choiceArgs);
  };

  try {
    const credentialStep = await resolveCredentials(options, deps);

    if (!credentialStep.ok) {
      fail(credentialStep);

      return;
    }

    const { credentials } = credentialStep.value;
    const targetsStep = await listTargets(
      deps.createClient(credentials),
      credentials,
      options.object === undefined ? {} : { object: options.object },
    );

    if (!targetsStep.ok) {
      fail(targetsStep);

      return;
    }

    deps.writeStdout(
      output.json
        ? `${JSON.stringify(targetsStep.value, null, 2)}\n`
        : formatTargetsText(targetsStep.value),
    );
  } catch (error) {
    fail(apiFailure(error));
  }
}
