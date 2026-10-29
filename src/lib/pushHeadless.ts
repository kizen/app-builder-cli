import { randomUUID } from 'node:crypto';
import type { Block, DeployablePlugin, ValidationIssue } from '@kizenapps/packager';
import { APP_URLS, isProductionEnvironment } from '../../shared/lib/kizenUrls.js';
import {
  accountArgs,
  apiFailure,
  commandArgv,
  createDefaultCommandDeps,
  createOAuthCommandDeps,
  credentialArgs,
  DRY_RUN_NOTE,
  errorMessage,
  failure as coreFailure,
  headlessWriteGate,
  pinnedCredentialArgs,
  resolveCredentials,
  success,
  warningLines,
  writeFailure,
  writeNotices,
  writeResult,
  type ChoiceArgv as CoreChoiceArgv,
  type CommandChoice,
  type CommandDeps,
  type CommandErrorCode,
  type CommandFailure,
  type CommandOutput,
  type CommandStep,
  type OAuthCommandDeps,
} from './commandCore.js';
import type { Credentials, Environment } from './credentials.js';
import { packageBlocks, resolvePackagedBlock, type PackagedBlocks } from './exportBlock.js';
import { formatValidationIssues } from './formatValidationIssues.js';
import { ensureGitignore } from './gitignore.js';
import { dashletPath, KizenApiError } from './kizenClient.js';
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
  type TargetMatch,
} from './pushBlock.js';
import { staleAgentFileWarnings } from './agentSetup.js';

export type PushErrorCode = CommandErrorCode;

export type ChoiceKind = 'environment' | 'block' | 'dashboard' | 'target';

export interface PushChoice extends CommandChoice {
  surface?: Surface;
  canEdit?: boolean | null;
  pushKey?: string | null;
  isFromThisPlugin?: boolean;
}

export type PushFailure = CommandFailure<ChoiceKind, PushChoice>;

export type Step<T> = CommandStep<T, PushFailure>;

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
  env?: string;
  business?: string;
  user?: string;
}

export interface TargetsCommandOptions {
  credentials?: string;
  profile?: string;
  object?: string;
  json?: boolean;
  env?: string;
  business?: string;
  user?: string;
}

export type OAuthPushDeps = OAuthCommandDeps;

export const createOAuthPushDeps = createOAuthCommandDeps;

export interface PushDeps extends CommandDeps {
  packageBlocks: (dir: string) => Promise<PackagedBlocks>;
  readPushMap: (dir: string) => Promise<PushMapEntry[]>;
  writePushMap: (dir: string, entries: readonly PushMapEntry[]) => Promise<void>;
  ensureGitignore: (dir: string) => void;
  /** The out-of-date warnings of the agent skills appbuilder manages here (Claude, Codex). */
  staleAgentFileWarnings: (dir: string) => Promise<string[]>;
  randomUUID: () => string;
}

export function createDefaultPushDeps(cwd: string): PushDeps {
  return {
    ...createDefaultCommandDeps(cwd),
    packageBlocks,
    readPushMap,
    writePushMap,
    ensureGitignore,
    staleAgentFileWarnings: (dir) => staleAgentFileWarnings(dir),
    randomUUID,
  };
}

const EDIT_ACCESS_LEVELS = new Set(['owner', 'admin', 'edit']);

const CHART_GROUP_HINT =
  'Chart groups are not listed here; find them with `appbuilder block targets --object <id> --json` and pass --dashboard <id>.';

const failure = coreFailure<ChoiceKind, PushChoice>;

/** What a push reads from the credentials: where it pushes, and the push map key. */
export type PushAccount = Pick<Credentials, 'environment' | 'businessId'>;
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

// A packaging throw (PluginValidationError or anything else) propagates; callers map
// it through apiFailure.
export async function resolveBlock(
  apiName: string | undefined,
  deps: PushDeps,
): Promise<Step<ResolvedBlock>> {
  const packaged = await deps.packageBlocks(deps.cwd);
  const resolved = resolvePackagedBlock(packaged, apiName, 'push');

  if (!resolved.ok) {
    const { reason, message, field } = resolved;

    if (reason === 'no_blocks' || reason === 'invalid_block') {
      return failure('invalid_block', message, field === undefined ? {} : { field });
    }

    return failure('needs_choice', message, {
      choice: 'block',
      choices: blockChoices(packaged.deployable, resolved.available),
    });
  }

  const { block, pluginApiName, views, warnings } = resolved.value;
  const content = toCustomCodeContent(block, views);

  return success({
    block,
    pluginApiName,
    content,
    contentHash: canonicalContentHash(content),
    warnings,
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
  credentials: PushAccount,
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
  credentials: PushAccount;
  block: ResolvedBlock;
  pushMap: PushMapEntry[];
  entry: PushMapEntry | undefined;
}

export type ResolvedBy = 'flag' | 'remembered' | 'push_map' | 'name';

interface ResolvedTargetBase {
  dashboard: WireDashboard;
  surface: Surface;
  resolvedBy: ResolvedBy;
}

/** An update always names the dashlet it overwrites; a create never does. */
export type ResolvedTarget =
  | (ResolvedTargetBase & { action: 'create'; dashlet: undefined })
  | (ResolvedTargetBase & { action: 'update'; dashlet: WireDashlet });

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

export const matchContextTarget = (
  context: Pick<PushContext, 'block' | 'entry'>,
  dashboard: WireDashboard,
): TargetMatch =>
  matchPushTarget({
    dashboardId: dashboard.id,
    dashlets: dashboard.dashlets,
    pluginApiName: context.block.pluginApiName,
    blockApiName: context.block.block.api_name,
    entry: context.entry,
  });

const createTarget = (dashboard: WireDashboard, resolvedBy: ResolvedBy): Step<ResolvedTarget> =>
  success({
    dashboard,
    surface: dashboardTypeToSurface(dashboard.type),
    action: 'create',
    dashlet: undefined,
    resolvedBy,
  });

const updateTarget = (
  dashboard: WireDashboard,
  dashlet: WireDashlet,
  resolvedBy: ResolvedBy,
): Step<ResolvedTarget> =>
  success({
    dashboard,
    surface: dashboardTypeToSurface(dashboard.type),
    action: 'update',
    dashlet,
    resolvedBy,
  });

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
    return createTarget(dashboard, 'flag');
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

    return updateTarget(dashboard, dashlet, 'flag');
  }

  const match = matchContextTarget(context, dashboard);

  if (match.kind === 'map') {
    return updateTarget(dashboard, match.dashlet, 'push_map');
  }

  if (match.kind === 'name') {
    return updateTarget(dashboard, match.dashlet, 'name');
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
    return createTarget(dashboard, 'remembered');
  }

  const dashlet = dashboard.dashlets.find(
    (candidate) => candidate.id === entry.dashletId && isMemberDashlet(dashboard, candidate),
  );

  if (dashlet && isCustomCodeDashlet(dashlet)) {
    return updateTarget(dashboard, dashlet, 'remembered');
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
  /** Bytes of the views JSON; present only when the block carries views. */
  viewsBytes?: number;
}

type PushPlanAction =
  | { action: 'create'; method: 'POST'; path: string; body: CreateDashletBody; dashletId: null }
  | {
      action: 'update';
      method: 'PATCH';
      path: string;
      body: UpdateDashletBody;
      dashletId: string;
    };

/** An update always carries the dashlet id it PATCHes; a create carries null. */
export type PushPlan = PushPlanAction & {
  dashboard: { id: string; name: string; type: Surface };
  url: string;
  resolvedBy: ResolvedBy;
  summary: PushSummary;
  warnings: string[];
};

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

export async function buildPlan(
  context: PushContext,
  resolved: ResolvedTarget,
  options: Pick<PushCommandOptions, 'force'>,
  deps: Pick<PushDeps, 'randomUUID'>,
): Promise<Step<PushPlan>> {
  const { credentials, block } = context;
  const { dashboard, surface } = resolved;
  const warnings: string[] = [];
  let planAction: PushPlanAction;
  let actionLine: string;

  if (resolved.action === 'update') {
    const { dashlet } = resolved;

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

    planAction = {
      action: 'update',
      method: 'PATCH',
      path: dashletPath(dashboard.id, dashlet.id),
      body: buildUpdateBody(dashlet, block.content),
      dashletId: dashlet.id,
    };
    actionLine = `Update "${customCodeName(dashlet)}" (dashlet ${dashlet.id})`;
  } else {
    planAction = {
      action: 'create',
      method: 'POST',
      path: dashletPath(dashboard.id),
      body: buildCreateBody({
        pluginApiName: block.pluginApiName,
        blockApiName: block.block.api_name,
        content: block.content,
        dashlets: dashboard.dashlets,
        objectId: deps.randomUUID(),
        layoutId: deps.randomUUID(),
      }),
      dashletId: null,
    };
    actionLine = `Create a new block on "${dashboard.name}"`;
  }

  const url = buildDashboardUrl({
    appBaseUrl: APP_URLS[credentials.environment],
    surface,
    dashboardId: dashboard.id,
    customObject: await customObjectOf(context.client, dashboard, surface),
  });

  return success({
    ...planAction,
    dashboard: { id: dashboard.id, name: dashboard.name, type: surface },
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
      dashletId: planAction.dashletId,
      blockName: block.block.name,
      blockApiName: block.block.api_name,
      pluginApiName: block.pluginApiName,
      scriptBytes: Buffer.byteLength(block.content.script, 'utf8'),
      stylesBytes: Buffer.byteLength(block.content.styles, 'utf8'),
      ...(block.content.views && {
        viewsBytes: Buffer.byteLength(JSON.stringify(block.content.views), 'utf8'),
      }),
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
      const created = await context.client.createDashlet(plan.dashboard.id, plan.body);

      const createdId: unknown = created.id;

      if (typeof createdId !== 'string' || createdId === '') {
        return failure(
          'api_error',
          `POST ${plan.path} succeeded but the response had no dashlet id; check "${plan.dashboard.name}" before pushing again.`,
        );
      }

      dashletId = createdId;
    } else {
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

/** Removes this block's remembered target; returns the written entries, or null if none was remembered. */
export async function forgetRemembered(
  context: Pick<PushContext, 'credentials' | 'block' | 'pushMap'>,
  deps: Pick<PushDeps, 'cwd' | 'writePushMap'>,
): Promise<PushMapEntry[] | null> {
  const key = pushMapKeyOf(context);

  if (!findPushMapEntry(context.pushMap, key)) {
    return null;
  }

  const remaining = removePushMapEntry(context.pushMap, key);

  await deps.writePushMap(deps.cwd, remaining);

  return remaining;
}

/** Reads the push map, applies --forget, and finds this block's remembered target. */
export async function loadPushContext(
  args: { client: KizenClient; credentials: PushAccount; block: ResolvedBlock; forget?: boolean },
  deps: Pick<PushDeps, 'cwd' | 'readPushMap' | 'writePushMap'>,
): Promise<{ context: PushContext; forgotten: boolean }> {
  const { client, credentials, block } = args;
  let pushMap = await deps.readPushMap(deps.cwd);
  let forgotten = false;

  if (args.forget) {
    const remaining = await forgetRemembered({ credentials, block, pushMap }, deps);

    if (remaining) {
      pushMap = remaining;
      forgotten = true;
    }
  }

  return {
    context: {
      client,
      credentials,
      block,
      pushMap,
      entry: findPushMapEntry(pushMap, pushMapKeyOf({ credentials, block })),
    },
    forgotten,
  };
}

export function formatSummaryLines(summary: PushSummary): string[] {
  return [
    `Environment: ${summary.environment}${summary.isProduction ? ' (production)' : ''}`,
    `Business: ${summary.businessId}`,
    `Surface: ${summary.surface}`,
    `Dashboard: "${summary.dashboardName}" (${summary.dashboardId})`,
    `Action: ${summary.actionLine}`,
    `Block: ${summary.blockName} (${summary.pluginApiName}/${summary.blockApiName})`,
    `Size: script ${String(summary.scriptBytes)} bytes, styles ${String(summary.stylesBytes)} bytes${
      summary.viewsBytes === undefined ? '' : `, views ${String(summary.viewsBytes)} bytes`
    }`,
  ];
}

const formatIssueWarning = (issue: ValidationIssue): string =>
  `${issue.path === undefined ? '' : `${issue.path}: `}${issue.message} (${issue.rule})`;

type ChoiceArgv = CoreChoiceArgv<ChoiceKind, PushChoice>;
async function agentSkillWarnings(deps: PushDeps): Promise<string[]> {
  try {
    return await deps.staleAgentFileWarnings(deps.cwd);
  } catch {
    return [];
  }
}

export async function runPushHeadless(
  apiName: string | undefined,
  options: PushCommandOptions,
  deps: PushDeps,
): Promise<void> {
  const output: CommandOutput = { json: options.json === true, deps };
  const command = 'appbuilder block push';
  let blockArgs = apiName === undefined ? [] : [apiName];
  // The run's credential flags until it signs in; then the account it resolved, so a printed
  // command can't act as another account a switch made current meanwhile.
  let credentialFlags = credentialArgs(options, deps.processEnv);
  // Every choice re-runs `block push` without the run's write or target flags, so it's a dry run
  // of the choice; its `applyArgv` then writes. An environment choice carries only the account
  // flags (its --env replaces the run's), a block or target choice the credential flags.
  const choiceArgs = (choice: PushChoice, kind: ChoiceKind | undefined): string[] => {
    if (kind === 'environment') {
      return [...blockArgs, ...choice.args, ...accountArgs(options, deps.processEnv)];
    }

    if (kind === 'block') {
      return [...choice.args, ...credentialFlags];
    }

    return [...blockArgs, ...credentialFlags, ...choice.args];
  };

  const choiceArgv: ChoiceArgv = (choice, kind) =>
    commandArgv(command, choiceArgs(choice, kind), output);

  const fail = (result: PushFailure): void => {
    writeFailure(output, result, choiceArgv);
  };

  try {
    const credentialStep = await resolveCredentials(options, deps);

    if (!credentialStep.ok) {
      fail(credentialStep);

      return;
    }

    const { credentials, client, notices } = credentialStep.value;

    credentialFlags = pinnedCredentialArgs(options, credentials);
    writeNotices(deps, notices);

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

    const { context, forgotten } = await loadPushContext(
      { client, credentials, block, forget: options.forget === true },
      deps,
    );

    if (forgotten) {
      deps.writeStderr(`Forgot the remembered target for ${block.block.api_name}.\n`);
    }

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
      ...(await agentSkillWarnings(deps)),
    ];
    const gate = gateStep.value;

    if (gate.kind === 'dry-run') {
      const warnings = [...issueWarnings, ...plan.warnings];
      const production = plan.summary.isProduction;
      // This dry run with --yes, pinned to the target it showed (so a remembered target that
      // changes meanwhile can't redirect the write); --allow-production only on production, where
      // the agent asks the user first (`requiresProductionConsent`).
      const applyArgv = commandArgv(
        command,
        [
          block.block.api_name,
          ...credentialFlags,
          '--dashboard',
          plan.dashboard.id,
          ...(plan.action === 'update' ? ['--dashlet', plan.dashletId] : ['--create']),
          ...(options.force === true ? ['--force'] : []),
          '--yes',
          ...(production ? ['--allow-production'] : []),
        ],
        output,
      );
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
        applyArgv,
        requiresProductionConsent: production,
      };

      writeResult(
        output,
        result,
        [
          ...formatSummaryLines(plan.summary),
          `URL: ${plan.url}`,
          ...warningLines(warnings),
          '',
          `${plan.method} ${plan.path}`,
          JSON.stringify(plan.body, null, 2),
          '',
        ].join('\n'),
        [...formatSummaryLines(plan.summary), ...warningLines(warnings), ''].join('\n'),
      );

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

    writeResult(
      output,
      result,
      [
        `✓ ${result.action === 'created' ? 'Created' : 'Updated'} ${block.block.name} on "${plan.dashboard.name}" (dashlet ${applied.dashletId})`,
        ...formatSummaryLines(plan.summary),
        `URL: ${plan.url}`,
        ...(refresh ? [`Refresh an open tab: ${refresh.script}`] : []),
        ...warningLines(warnings),
        '',
      ].join('\n'),
    );
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
  const output: CommandOutput = { json: options.json === true, deps };
  const command = 'appbuilder block targets';
  const objectArgs = options.object === undefined ? [] : ['--object', options.object];
  const choiceArgv: ChoiceArgv = (choice) =>
    commandArgv(
      command,
      [...choice.args, ...accountArgs(options, deps.processEnv), ...objectArgs],
      output,
    );
  const fail = (result: PushFailure): void => {
    writeFailure(output, result, choiceArgv);
  };

  try {
    const credentialStep = await resolveCredentials(options, deps);

    if (!credentialStep.ok) {
      fail(credentialStep);

      return;
    }

    const { credentials, client, notices } = credentialStep.value;

    writeNotices(deps, notices);

    const targetsStep = await listTargets(
      client,
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
