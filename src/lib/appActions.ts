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

/**
 * The steps behind `appbuilder app actions …` and the JS-action check `app push`, `publish` and
 * `versions` report, free of any output (the headless runners and the TTY UI both drive these).
 *
 * A JS action template does nothing until it's linked to an object (an association of the app's
 * install, keyed by the template's api_name, so it survives previews and releases). The server
 * lists only the links of templates in the install's Live version, so a template that is only in a
 * preview is `unknown`: it may be linked, but nothing can show it. It can be linked right after a
 * push, like a Live one, where Kizen resolves the caller's preview for the link (see
 * `isTemplateNotFound` for where it doesn't).
 */

const failure = coreFailure<AppChoiceKind>;

/** A JS action template as the packager and the stored definitions carry it. */
export interface JsActionTemplate {
  apiName: string;
  name: string;
  hintObjectName: string | null;
}

/** The templates in an `artifacts.js_action_templates` list; malformed entries are skipped. */
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

/** `linked`: at least one link; `unlinked`: none; `unknown`: not in Live, so links can't be listed. */
export type JsActionStatus = 'linked' | 'unlinked' | 'unknown';

export interface JsActionLink {
  /** The association's id. */
  id: string;
  objectId: string;
  /** The object's api name (`client_client`). */
  objectName: string;
  /** The object's display name. */
  label: string;
  /** Whether the action shows in the object's Perform Action menus; null when never set. */
  includePerformAction: boolean | null;
}

export interface JsActionInfo extends JsActionTemplate {
  status: JsActionStatus;
  /** Whether the template is in the Live version, the only one whose links the server lists. */
  inLive: boolean;
  links: JsActionLink[];
}

/**
 * `checked`: the links were read; `not_installed`: the app isn't on this business, so nothing can
 * be linked yet; `no_live_version`: there's no Live version, so no links can be listed; `failed`: a
 * request failed (`error`), and every action is `unknown`.
 */
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

/**
 * Each template's status: linked when the server lists a link for it; otherwise unlinked when the
 * server would have listed one (it's in Live, or the app isn't installed, so none can exist), else
 * unknown. Pure.
 */
export function classifyJsActions(input: {
  templates: readonly JsActionTemplate[];
  installed: boolean;
  /** The api_names in the Live version; null when there is none. */
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

/** Templates in order, the first of each api_name kept. */
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

/**
 * Which templates to check: those of a version being acted on (`version`: what a push uploads, the
 * preview a publish promotes); the new Live version after a publish (`live`); or the app's Live
 * version plus your preview (`app`, for `versions` and `actions`).
 */
export type JsActionsSource =
  | { kind: 'version'; templates: JsActionTemplate[] }
  | { kind: 'live'; version: string }
  | { kind: 'app' };

/**
 * Reads the templates and the install's links and classifies each template. Makes no request when
 * a `version` source has no templates, and lists no links for an app that isn't on this business
 * or has no Live version.
 */
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

/**
 * `readJsActions` for a command whose job is something else (push, publish, versions): a failure
 * never fails it; it becomes a `failed` check whose templates are all `unknown`.
 */
export async function checkJsActions(
  context: AppContext,
  source: JsActionsSource,
): Promise<JsActionsCheck> {
  const read = await readJsActions(context, source);

  return read.ok ? read.value : failedCheck(context, source, read.message);
}

/** A check whose read failed with `error`: every template of a `version` source `unknown`. */
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

/**
 * `checkJsActions` of what a push uploaded, once it's applied: the app is read again first, since
 * the context is from before the push, and a first push installs the app (its actions are then
 * preview-only, not unlinked). A failed re-read is a `failed` check too.
 */
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

/** How to link them: the argvs each action carries in --json results, or the terminal's pickers. */
const LINK_HOW =
  "with `--json`, run an action's `linkArgv`, `linkMenuArgv` or `linkNoMenuArgv`; at a terminal, run `appbuilder app actions link` to pick them";

/** A warning per kind of action that may need linking: unlinked, and unknown (softer). */
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

/** A failed check, as a notice: it never fails the command. */
export const jsActionsNotices = (check: JsActionsCheck): string[] =>
  check.status === 'failed'
    ? [
        `Couldn't check which JS actions are linked to objects: ${check.error ?? 'unknown error'}. Run \`appbuilder app actions list\` to check.`,
      ]
    : [];

/**
 * What to run after a check, as `appbuilder app` args: `actions list` whenever an action may need
 * linking (or the check failed), and a link dry run per unlinked action that names a hint object.
 * An `unknown` action gets no link dry run of its own: it may be linked already (the list can't
 * show it), so its object is picked with the user, not suggested.
 */
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

// ---------------------------------------------------------------------------------------------
// objects

const sameText = (left: string, right: string): boolean =>
  left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;

/**
 * The object `arg` names: its id, else its api name exactly, else the one object whose api name or
 * display name matches ignoring case. Several matches are a `needs_choice` whose choices are
 * `choiceArgv(object)`, by id; none is `not_found`.
 */
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
  /** The api name. */
  name: string;
  label: string;
}

const toActionObject = (object: BusinessObject): ActionObject => ({
  id: object.id,
  name: object.name,
  label: object.objectName,
});

// ---------------------------------------------------------------------------------------------
// list

export interface ActionsListReport {
  summary: AppSummary;
  check: JsActionsCheck;
}

/** Every JS action of the app's Live version and your preview, with its links. Read-only. */
export async function planActionsList(context: AppContext): Promise<AppStep<ActionsListReport>> {
  const check = await readJsActions(context, { kind: 'app' });

  return check.ok ? success({ summary: appSummary(context), check: check.value }) : check;
}

// ---------------------------------------------------------------------------------------------
// link and unlink

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

/** What linking and unlinking pick from: the app's actions with their links, and the objects. */
export interface ActionChoices {
  /** The suffixed api_name of the app. */
  appApiName: string;
  check: JsActionsCheck;
  objects: BusinessObject[];
}

/** Reads the actions and the objects together; `not_found` for an app not on this business. */
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

/** The action named `apiName` among `choices`, else `not_found`. */
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

/** Reads the choices, then resolves `objectArg` and `actionArg`, in that order. */
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
  /** The suffixed api_name of the app. */
  appApiName: string;
  action: JsActionInfo;
  object: ActionObject;
  /** create: no link is listed; update: linked with the other menu setting; up_to_date: as asked. */
  change: ActionLinkChange;
  /** The menu setting the link gets, or has when up to date (null: never set). */
  includePerformAction: boolean | null;
  /** The listed link, for an update or up_to_date. */
  existing: { id: string; includePerformAction: boolean | null } | null;
  notices: string[];
  /** `LIVE_LINK_CHANGE_WARNING` when the link changes for an action in Live. */
  warnings: string[];
}

/**
 * Placeholder copy.
 * A link names the action by api_name on the app's one install, shared by Live and every preview,
 * and each viewer's version resolves it (webapp `CustomObject.get_browser_js_action_templates`).
 * So creating, changing or removing a link of an action in Live changes what Live users see at
 * once; for an action only in a preview, it reaches only the users of a version that has it.
 */
export const LIVE_LINK_CHANGE_WARNING = (action: string, object: string): string =>
  `${action} is in the Live version, so this change to its link to ${object} applies to everyone using Live as soon as it's made.`;

/** The Live warning for a link change of `action`, or none. */
const liveLinkWarnings = (action: JsActionInfo, object: string): string[] =>
  action.inLive ? [LIVE_LINK_CHANGE_WARNING(action.apiName, object)] : [];

/** The notice for a link whose existing links can't be seen. */
export const UNLISTED_LINK_NOTICE = (action: string): string =>
  `${action} isn't in the Live version, so an existing link to this object can't be seen. If there is one, linking reports it as already linked and leaves its menu setting as it is.`;

/**
 * Plans linking `actionArg` to `objectArg`. `menu` sets whether the action shows in the object's
 * Perform Action menus; left out, a new link doesn't show (as in the Kizen UI) and an existing one
 * keeps its setting. Writes nothing.
 */
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

/** `planActionLink` from choices already read (the action and object picked from them). Pure. */
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
    // A menu setting change counts: it changes the object's Perform Action menus in Live.
    warnings: change === 'up_to_date' ? [] : liveLinkWarnings(action, object.name),
  };
}

/** `already_linked`: the server said a link exists that the list couldn't show. */
export type ActionLinkStatus = 'created' | 'updated' | 'already_linked' | 'up_to_date';

export interface AppliedActionLink {
  status: ActionLinkStatus;
  warnings: string[];
}

export const ALREADY_LINKED_WARNING = (action: string, object: string): string =>
  `${action} was already linked to ${object}. Its link isn't listed (the action isn't in the Live version), so its menu setting couldn't be checked or changed.`;

/**
 * Placeholder copy. `already_linked` for an action in Live: the link was made after this run listed
 * the links (another run, say), so its menu setting is whatever that one set.
 */
export const ALREADY_LINKED_LIVE_WARNING = (action: string, object: string): string =>
  `${action} was already linked to ${object} (the link was made after this command listed the links), so nothing was changed and its menu setting wasn't set. Run \`appbuilder app actions list\`, then link it again to set the menu setting.`;

/** The 400 the create answers when the (template, object) pair is already linked. */
const isDuplicateLink = (error: unknown): boolean =>
  error instanceof KizenApiError && error.status === 400 && /already exists/i.test(error.message);

/**
 * The 400 the create answers when the template isn't in the version the server resolves for the
 * caller (webapp `get_for_business_plugin_app`): their active preview, else Live. On a Kizen
 * environment without KZN-19521's fix, an OAuth client like this CLI always gets Live (Bearer auth
 * didn't put the employee in webapp's request cache), so a preview-only action is never found.
 */
const isTemplateNotFound = (error: unknown): boolean =>
  error instanceof KizenApiError &&
  error.status === 400 &&
  /Browser JS action template not found/i.test(error.message);

/**
 * Placeholder copy.
 * Why a create can't find an action that is only in a preview: this Kizen environment doesn't
 * have the fix that links preview-only actions yet, or the caller isn't using their preview.
 */
export const PREVIEW_ONLY_LINK_HINT = (action: string): string =>
  `${action} is only in your preview, and Kizen couldn't find it to link it. Kizen environments without the fix for linking preview-only actions (KZN-19521) only link actions in Live: publish it first, then link it.`;

const cancelled = (): AppFailure => failure('local_error', CANCELLED_MESSAGE);

/** Creates the link, or patches its menu setting; nothing for `up_to_date`. */
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
  /** The link deleted. */
  associationId: string;
  includePerformAction: boolean | null;
  /** `LIVE_LINK_CHANGE_WARNING` when the action is in Live. */
  warnings: string[];
}

export const NOT_LINKED_MESSAGE = (action: string, object: string): string =>
  `${action} isn't linked to ${object}.`;

export const UNLISTED_UNLINK_HINT = (action: string): string =>
  `${action} isn't in the Live version, so its links can't be listed or removed here. If it was linked while only in a preview, publish it first, then unlink it.`;

/** Finds the link of `actionArg` to `objectArg` to delete. Writes nothing. */
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

/** `planActionUnlink` from choices already read; `not_found` when no link is listed. Pure. */
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

/** Deletes the planned link. */
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
