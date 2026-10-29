import {
  appFailure,
  appSummary,
  CANCELLED_MESSAGE,
  refreshAppContext,
  type AppChoiceKind,
  type AppContext,
  type AppFailure,
  type ApplyControl,
  type AppStep,
  type AppSummary,
} from './appFlow.js';
import type { ActionAssociation, BusinessAppDefinition, BusinessObject } from './businessApps.js';
import { failure as coreFailure, success, type CommandChoice } from './commandCore.js';
import { isRecord } from './guards.js';
import { KizenApiError } from './kizenClient.js';

const failure = coreFailure<AppChoiceKind>;

export interface JsActionTemplate {
  apiName: string;
  name: string;
  hintObjectName: string | null;
}

export function jsActionTemplatesOf(list: unknown): JsActionTemplate[] {
  if (!Array.isArray(list)) {
    return [];
  }

  return list.flatMap((item): JsActionTemplate[] => {
    if (!isRecord(item) || typeof item.api_name !== 'string' || item.api_name === '') {
      return [];
    }

    const hint = item.hint_object_name;

    return [
      {
        apiName: item.api_name,
        name: typeof item.name === 'string' && item.name !== '' ? item.name : item.api_name,
        hintObjectName: typeof hint === 'string' && hint !== '' ? hint : null,
      },
    ];
  });
}

const definitionTemplates = (definition: BusinessAppDefinition): JsActionTemplate[] => {
  const artifacts: unknown = definition.artifacts;

  return jsActionTemplatesOf(isRecord(artifacts) ? artifacts.js_action_templates : undefined);
};

export type JsActionStatus = 'linked' | 'unlinked' | 'unknown';

export interface JsActionLink {
  id: string;
  objectId: string;
  objectName: string;
  label: string;
  includePerformAction: boolean | null;
}

export interface JsActionInfo extends JsActionTemplate {
  status: JsActionStatus;
  inLive: boolean;
  links: JsActionLink[];
}

export type JsActionsCheckStatus = 'checked' | 'not_installed' | 'no_live_version' | 'failed';

export interface JsActionsCheck {
  status: JsActionsCheckStatus;
  liveVersion: string | null;
  actions: JsActionInfo[];
  error?: string;
}

const objectLabel = (object: ActionAssociation['custom_object']): string =>
  object.object_name ?? object.entity_name ?? object.name;

const toLink = (association: ActionAssociation): JsActionLink => ({
  id: association.id,
  objectId: association.custom_object.id,
  objectName: association.custom_object.name,
  label: objectLabel(association.custom_object),
  includePerformAction: association.include_perform_action,
});

export function classifyJsActions(input: {
  templates: readonly JsActionTemplate[];
  installed: boolean;
  liveApiNames: ReadonlySet<string> | null;
  associations: readonly ActionAssociation[];
}): JsActionInfo[] {
  const { templates, installed, liveApiNames, associations } = input;

  return templates.map((template) => {
    const links = associations
      .filter((association) => association.browser_js_action_template.api_name === template.apiName)
      .map(toLink);
    const inLive = liveApiNames?.has(template.apiName) ?? false;
    const status: JsActionStatus =
      links.length > 0 ? 'linked' : !installed || inLive ? 'unlinked' : 'unknown';

    return { ...template, status, inLive, links };
  });
}

const uniqueTemplates = (templates: readonly JsActionTemplate[]): JsActionTemplate[] => {
  const seen = new Set<string>();

  return templates.filter((template) => {
    if (seen.has(template.apiName)) {
      return false;
    }

    seen.add(template.apiName);

    return true;
  });
};

const isNotFound = (error: unknown): boolean =>
  error instanceof KizenApiError && error.kind === 'not_found';

export type JsActionsSource =
  | { kind: 'version'; templates: JsActionTemplate[] }
  | { kind: 'live'; version: string }
  | { kind: 'app' };

export async function readJsActions(
  context: AppContext,
  source: JsActionsSource,
): Promise<AppStep<JsActionsCheck>> {
  const { app, api } = context;

  if (app === null) {
    const templates = source.kind === 'version' ? uniqueTemplates(source.templates) : [];

    return success({
      status: 'not_installed',
      liveVersion: null,
      actions: classifyJsActions({
        templates,
        installed: false,
        liveApiNames: null,
        associations: [],
      }),
    });
  }

  const liveVersion = source.kind === 'live' ? source.version : app.live_version;

  if (source.kind === 'version' && source.templates.length === 0) {
    return success({ status: 'checked', liveVersion, actions: [] });
  }

  const preview = context.yourPreview;

  try {
    const [liveTemplates, previewTemplates, associations] = await Promise.all([
      liveVersion === null
        ? null
        : api.getVersion(app.api_name, liveVersion).then(definitionTemplates),
      source.kind === 'app' && preview !== null
        ? api
            .getPreview(app.api_name, context.credentials.userId)
            .then(definitionTemplates)
            .catch((error: unknown) => {
              if (isNotFound(error)) {
                return [];
              }

              throw error;
            })
        : [],
      liveVersion === null ? [] : api.listActionAssociations(app.api_name),
    ]);
    const templates =
      source.kind === 'version'
        ? source.templates
        : [...(liveTemplates ?? []), ...previewTemplates];

    return success({
      status: liveVersion === null ? 'no_live_version' : 'checked',
      liveVersion,
      actions: classifyJsActions({
        templates: uniqueTemplates(templates),
        installed: true,
        liveApiNames:
          liveTemplates === null
            ? null
            : new Set(liveTemplates.map((template) => template.apiName)),
        associations,
      }),
    });
  } catch (error) {
    return appFailure(error);
  }
}

export async function checkJsActions(
  context: AppContext,
  source: JsActionsSource,
): Promise<JsActionsCheck> {
  const read = await readJsActions(context, source);

  return read.ok ? read.value : failedCheck(context, source, read.message);
}

function failedCheck(context: AppContext, source: JsActionsSource, error: string): JsActionsCheck {
  const templates = source.kind === 'version' ? uniqueTemplates(source.templates) : [];

  return {
    status: 'failed',
    liveVersion: source.kind === 'live' ? source.version : (context.app?.live_version ?? null),
    actions: templates.map((template) => ({
      ...template,
      status: 'unknown',
      inLive: false,
      links: [],
    })),
    error,
  };
}

export async function checkPushedJsActions(
  context: AppContext,
  templates: JsActionTemplate[],
): Promise<JsActionsCheck> {
  const source: JsActionsSource = { kind: 'version', templates };
  const fresh = await refreshAppContext(context);

  return fresh.ok
    ? checkJsActions(fresh.value, source)
    : failedCheck(context, source, fresh.message);
}

const names = (actions: readonly JsActionInfo[]): string =>
  actions.map((action) => action.apiName).join(', ');

const LINK_HOW =
  "with `--json`, run an action's `linkArgv`, `linkMenuArgv` or `linkNoMenuArgv`; at a terminal, run `appbuilder app actions link` to pick them";

export function jsActionsWarnings(check: JsActionsCheck): string[] {
  const unlinked = check.actions.filter((action) => action.status === 'unlinked');
  const unknown = check.actions.filter((action) => action.status === 'unknown');
  const warnings: string[] = [];

  if (unlinked.length > 0) {
    warnings.push(
      `These JS actions aren't linked to any object: ${names(unlinked)}. Link them: ${LINK_HOW}.`,
    );
  }

  if (unknown.length > 0 && check.status !== 'failed') {
    warnings.push(
      `These JS actions aren't in the Live version, so their links can't be listed and they may not be linked to any object: ${names(unknown)}. To make sure, link them: ${LINK_HOW}.`,
    );
  }

  return warnings;
}

export const jsActionsNotices = (check: JsActionsCheck): string[] =>
  check.status === 'failed'
    ? [
        `Couldn't check which JS actions are linked to objects: ${check.error ?? 'unknown error'}. Run \`appbuilder app actions list\` to check.`,
      ]
    : [];

export function jsActionsNextArgs(check: JsActionsCheck): { step: string; args: string[] }[] {
  const pending = check.actions.some((action) => action.status !== 'linked');

  if (!pending && check.status !== 'failed') {
    return [];
  }

  return [
    { step: 'actions', args: ['actions', 'list'] },
    ...check.actions.flatMap((action) =>
      action.status === 'unlinked' && action.hintObjectName !== null
        ? [{ step: 'link', args: ['actions', 'link', action.apiName, action.hintObjectName] }]
        : [],
    ),
  ];
}

const sameText = (left: string, right: string): boolean =>
  left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;

export function resolveObject(
  objects: readonly BusinessObject[],
  arg: string,
  choiceArgv: (object: BusinessObject) => string[],
): AppStep<BusinessObject> {
  const wanted = arg.trim();
  const exact =
    objects.find((object) => object.id === wanted) ??
    objects.find((object) => object.name === wanted);

  if (exact !== undefined) {
    return success(exact);
  }

  const matches = objects.filter(
    (object) =>
      sameText(object.name, wanted) ||
      sameText(object.objectName, wanted) ||
      (object.entityName !== null && sameText(object.entityName, wanted)),
  );
  const [only] = matches;

  if (only !== undefined && matches.length === 1) {
    return success(only);
  }

  if (matches.length > 1) {
    const choices: CommandChoice[] = matches.map((object) => ({
      value: object.id,
      label: `${object.objectName} (${object.name})`,
      args: [],
      argv: choiceArgv(object),
    }));

    return failure(
      'needs_choice',
      `Several objects match "${arg}". Pick one by its api name or id.`,
      {
        choice: 'object',
        choices,
      },
    );
  }

  return failure(
    'not_found',
    `No object "${arg}" on this business that you can see. Pass an object's api name (like client_client) or its id.`,
  );
}

export interface ActionObject {
  id: string;
  name: string;
  label: string;
}

const toActionObject = (object: BusinessObject): ActionObject => ({
  id: object.id,
  name: object.name,
  label: object.objectName,
});

export interface ActionsListReport {
  summary: AppSummary;
  check: JsActionsCheck;
}

export async function planActionsList(context: AppContext): Promise<AppStep<ActionsListReport>> {
  const check = await readJsActions(context, { kind: 'app' });

  return check.ok ? success({ summary: appSummary(context), check: check.value }) : check;
}

const notOnBusiness = (context: AppContext): AppFailure =>
  failure(
    'not_found',
    `${context.baseApiName} isn't on this business yet, so it has no JS actions to link. Push it first with \`appbuilder app push\`.`,
  );

const unknownAction = (context: AppContext, action: string): AppFailure =>
  failure(
    'not_found',
    `${context.baseApiName} has no JS action "${action}" in its Live version or your preview. If it's new, push this folder first with \`appbuilder app push\`.`,
  );

export interface ActionChoices {
  appApiName: string;
  check: JsActionsCheck;
  objects: BusinessObject[];
}

export async function readActionChoices(context: AppContext): Promise<AppStep<ActionChoices>> {
  const { app } = context;

  if (app === null) {
    return notOnBusiness(context);
  }

  let objects: BusinessObject[];
  let check: AppStep<JsActionsCheck>;

  try {
    [check, objects] = await Promise.all([
      readJsActions(context, { kind: 'app' }),
      context.api.listObjects(),
    ]);
  } catch (error) {
    return appFailure(error);
  }

  return check.ok ? success({ appApiName: app.api_name, check: check.value, objects }) : check;
}

export function findAction(
  context: AppContext,
  choices: ActionChoices,
  apiName: string,
): AppStep<JsActionInfo> {
  const action = choices.check.actions.find((candidate) => candidate.apiName === apiName);

  return action === undefined ? unknownAction(context, apiName) : success(action);
}

interface ActionTarget {
  choices: ActionChoices;
  action: JsActionInfo;
  object: BusinessObject;
}

async function resolveTarget(
  context: AppContext,
  actionArg: string,
  objectArg: string,
  choiceArgv: (object: BusinessObject) => string[],
): Promise<AppStep<ActionTarget>> {
  const read = await readActionChoices(context);

  if (!read.ok) {
    return read;
  }

  const object = resolveObject(read.value.objects, objectArg, choiceArgv);

  if (!object.ok) {
    return object;
  }

  const action = findAction(context, read.value, actionArg);

  return action.ok
    ? success({ choices: read.value, action: action.value, object: object.value })
    : action;
}

export type ActionLinkChange = 'create' | 'update' | 'up_to_date';

export interface ActionLinkPlan {
  summary: AppSummary;
  appApiName: string;
  action: JsActionInfo;
  object: ActionObject;
  change: ActionLinkChange;
  includePerformAction: boolean | null;
  existing: { id: string; includePerformAction: boolean | null } | null;
  notices: string[];
  warnings: string[];
}

export const LIVE_LINK_CHANGE_WARNING = (action: string, object: string): string =>
  `${action} is in the Live version, so this change to its link to ${object} applies to everyone using Live as soon as it's made.`;

const liveLinkWarnings = (action: JsActionInfo, object: string): string[] =>
  action.inLive ? [LIVE_LINK_CHANGE_WARNING(action.apiName, object)] : [];

export const UNLISTED_LINK_NOTICE = (action: string): string =>
  `${action} isn't in the Live version, so an existing link to this object can't be seen. If there is one, linking reports it as already linked and leaves its menu setting as it is.`;

export async function planActionLink(
  context: AppContext,
  args: { action: string; object: string; menu?: boolean },
  choiceArgv: (object: BusinessObject) => string[],
): Promise<AppStep<ActionLinkPlan>> {
  const target = await resolveTarget(context, args.action, args.object, choiceArgv);

  if (!target.ok) {
    return target;
  }

  const { choices, action, object } = target.value;

  return success(
    actionLinkPlanOf(context, choices, action, object, {
      ...(args.menu !== undefined && { menu: args.menu }),
    }),
  );
}

export function actionLinkPlanOf(
  context: AppContext,
  choices: ActionChoices,
  action: JsActionInfo,
  object: BusinessObject,
  { menu }: { menu?: boolean },
): ActionLinkPlan {
  const listed = action.links.find((link) => link.objectId === object.id);
  const existing =
    listed === undefined
      ? null
      : { id: listed.id, includePerformAction: listed.includePerformAction };
  let change: ActionLinkChange;
  let includePerformAction: boolean | null;

  if (existing === null) {
    change = 'create';
    includePerformAction = menu ?? false;
  } else if (menu === undefined || menu === existing.includePerformAction) {
    change = 'up_to_date';
    includePerformAction = existing.includePerformAction;
  } else {
    change = 'update';
    includePerformAction = menu;
  }

  return {
    summary: appSummary(context),
    appApiName: choices.appApiName,
    action,
    object: toActionObject(object),
    change,
    includePerformAction,
    existing,
    notices: change === 'create' && !action.inLive ? [UNLISTED_LINK_NOTICE(action.apiName)] : [],
    warnings: change === 'up_to_date' ? [] : liveLinkWarnings(action, object.name),
  };
}

export type ActionLinkStatus = 'created' | 'updated' | 'already_linked' | 'up_to_date';

export interface AppliedActionLink {
  status: ActionLinkStatus;
  warnings: string[];
}

export const ALREADY_LINKED_WARNING = (action: string, object: string): string =>
  `${action} was already linked to ${object}. Its link isn't listed (the action isn't in the Live version), so its menu setting couldn't be checked or changed.`;

export const ALREADY_LINKED_LIVE_WARNING = (action: string, object: string): string =>
  `${action} was already linked to ${object} (the link was made after this command listed the links), so nothing was changed and its menu setting wasn't set. Run \`appbuilder app actions list\`, then link it again to set the menu setting.`;

const isDuplicateLink = (error: unknown): boolean =>
  error instanceof KizenApiError && error.status === 400 && /already exists/i.test(error.message);

const isTemplateNotFound = (error: unknown): boolean =>
  error instanceof KizenApiError &&
  error.status === 400 &&
  /Browser JS action template not found/i.test(error.message);

export const PREVIEW_ONLY_LINK_HINT = (action: string): string =>
  `${action} is only in your preview, and Kizen couldn't find it to link it. Kizen environments without the fix for linking preview-only actions (KZN-19521) only link actions in Live: publish it first, then link it.`;

const cancelled = (): AppFailure => failure('local_error', CANCELLED_MESSAGE);

export async function applyActionLink(
  context: AppContext,
  plan: ActionLinkPlan,
  { isAborted = () => false }: ApplyControl = {},
): Promise<AppStep<AppliedActionLink>> {
  const include = plan.includePerformAction;

  if (plan.change === 'up_to_date' || include === null) {
    return success({ status: 'up_to_date', warnings: [] });
  }

  if (isAborted()) {
    return cancelled();
  }

  try {
    if (plan.change === 'update' && plan.existing !== null) {
      await context.api.updateActionAssociation(plan.appApiName, plan.existing.id, include);

      return success({ status: 'updated', warnings: [] });
    }

    await context.api.createActionAssociation({
      appApiName: plan.appApiName,
      actionApiName: plan.action.apiName,
      objectId: plan.object.id,
      includePerformAction: include,
    });

    return success({ status: 'created', warnings: [] });
  } catch (error) {
    if (plan.change === 'create' && isDuplicateLink(error)) {
      return success({
        status: 'already_linked',
        warnings: [
          (plan.action.inLive ? ALREADY_LINKED_LIVE_WARNING : ALREADY_LINKED_WARNING)(
            plan.action.apiName,
            plan.object.name,
          ),
        ],
      });
    }

    if (plan.change === 'create' && !plan.action.inLive && isTemplateNotFound(error)) {
      return { ...appFailure(error), hint: PREVIEW_ONLY_LINK_HINT(plan.action.apiName) };
    }

    return appFailure(error);
  }
}

export interface ActionUnlinkPlan {
  summary: AppSummary;
  appApiName: string;
  action: JsActionInfo;
  object: ActionObject;
  associationId: string;
  includePerformAction: boolean | null;
  warnings: string[];
}

export const NOT_LINKED_MESSAGE = (action: string, object: string): string =>
  `${action} isn't linked to ${object}.`;

export const UNLISTED_UNLINK_HINT = (action: string): string =>
  `${action} isn't in the Live version, so its links can't be listed or removed here. If it was linked while only in a preview, publish it first, then unlink it.`;

export async function planActionUnlink(
  context: AppContext,
  args: { action: string; object: string },
  choiceArgv: (object: BusinessObject) => string[],
): Promise<AppStep<ActionUnlinkPlan>> {
  const target = await resolveTarget(context, args.action, args.object, choiceArgv);

  if (!target.ok) {
    return target;
  }

  const { choices, action, object } = target.value;

  return actionUnlinkPlanOf(context, choices, action, object);
}

export function actionUnlinkPlanOf(
  context: AppContext,
  choices: ActionChoices,
  action: JsActionInfo,
  object: BusinessObject,
): AppStep<ActionUnlinkPlan> {
  const link = action.links.find((candidate) => candidate.objectId === object.id);

  if (link === undefined) {
    return failure(
      'not_found',
      NOT_LINKED_MESSAGE(action.apiName, object.name),
      action.inLive ? {} : { hint: UNLISTED_UNLINK_HINT(action.apiName) },
    );
  }

  return success({
    summary: appSummary(context),
    appApiName: choices.appApiName,
    action,
    object: toActionObject(object),
    associationId: link.id,
    includePerformAction: link.includePerformAction,
    warnings: liveLinkWarnings(action, object.name),
  });
}

export async function applyActionUnlink(
  context: AppContext,
  plan: ActionUnlinkPlan,
  { isAborted = () => false }: ApplyControl = {},
): Promise<AppStep<{ status: 'unlinked' }>> {
  if (isAborted()) {
    return cancelled();
  }

  try {
    await context.api.deleteActionAssociation(plan.associationId);
  } catch (error) {
    return appFailure(error);
  }

  return success({ status: 'unlinked' });
}
