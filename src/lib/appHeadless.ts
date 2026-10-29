import type { ValidationIssue } from '@kizenapps/packager';
import {
  applyActionLink,
  applyActionUnlink,
  type ActionLinkStatus,
  checkJsActions,
  checkPushedJsActions,
  jsActionsNextArgs,
  jsActionsNotices,
  jsActionsWarnings,
  jsActionTemplatesOf,
  planActionLink,
  planActionsList,
  planActionUnlink,
  type ActionLinkPlan,
  type ActionUnlinkPlan,
  type JsActionInfo,
  type JsActionsCheck,
} from './appActions.js';
import {
  applyAppMerge,
  applyPublish,
  applyPreviewDelete,
  applyPull,
  applyPush,
  applyRollback,
  appFailure,
  deletedPreviewPlan,
  describeVersions,
  loadAppContext,
  planAppMerge,
  planPreviewDelete,
  planPublish,
  planPull,
  planPush,
  planRollback,
  preparePush,
  pullTargetOf,
  recordedFolderBase,
  requireDeleteAppConsent,
  type AppChoiceKind,
  type AppContext,
  type AppDeps,
  type AppFailure,
  type AppMergeLists,
  type AppMergePlan,
  type AppliedAppMerge,
  type AppliedAppPublish,
  type AppliedAppPull,
  type AppliedAppPush,
  type AppliedPreviewDelete,
  type AppPreviewDeletePlan,
  type AppPublishPlan,
  type AppPullPlan,
  type AppPushPlan,
  type AppRollbackPlan,
  type AppStep,
  type AppSummary,
  type AppVersionInfo,
  type AppVersionsReport,
  type ConflictCheck,
  type RecordedBase,
} from './appFlow.js';
import {
  accountArgs,
  commandArgv,
  credentialArgs,
  DRY_RUN_NOTE,
  failure,
  headlessWriteGate,
  resolveCredentials,
  success,
  warningLines,
  writeFailure,
  writeNotices,
  writeResult,
  jsonArgs,
  pinnedCredentialArgs,
  type ChoiceArgv,
  type CommandAccount,
  type CommandChoice,
  type CommandOutput,
  type NextCommand,
  type RunnableChoice,
  type WriteGate,
} from './commandCore.js';
import type { AuthFlags } from './authSelection.js';
import type { BusinessObject } from './businessApps.js';
import { formatValidationIssues } from './formatValidationIssues.js';
import type { KizenClient } from './kizenTypes.js';
import { quoteArg } from './shellArg.js';

export interface AppCommandOptions extends AuthFlags {
  json?: boolean;
}

export interface AppWriteOptions extends AppCommandOptions {
  dryRun?: boolean;
  yes?: boolean;
  allowProduction?: boolean;
}

export interface AppPushOptions extends AppWriteOptions {
  force?: boolean;
  baseFromPreview?: string;
}

export interface AppPublishOptions extends AppWriteOptions {
  force?: boolean;
  expectPreview?: string;
}

export interface AppMergeCommandOptions extends AppCommandOptions {
  dryRun?: boolean;
  yes?: boolean;
  release?: string;
  base?: string;
  acceptLiveBase?: boolean;
}

export interface AppPullOptions extends AppCommandOptions {
  out?: string;
  preview?: boolean;
}

interface Runner {
  output: CommandOutput;
  fail: (result: AppFailure) => void;
  runnable: (choices: CommandChoice[]) => RunnableChoice[];
  appArgv: (args: string[]) => string[];
  apply: (
    args: string[],
    production: boolean,
  ) => { applyArgv: string[]; requiresProductionConsent: boolean };
  pin: (account: CommandAccount) => void;
}

export type AppNextStep =
  | NextCommand
  | { step: 'resolve'; files: string[]; markers: { local: 'HEAD'; incoming: 'live' } };

const MARKER_LABELS = { local: 'HEAD', incoming: 'live' } as const;

function runner(
  command: string,
  rerunArgs: string[],
  options: AppCommandOptions,
  deps: AppDeps,
): Runner {
  const output: CommandOutput = { json: options.json === true, deps };
  let credentials = credentialArgs(options, deps.processEnv);
  const completeArgv = (argv: string[]): string[] => [
    ...argv,
    ...(argv[2] === 'push' && (options as AppWriteOptions).allowProduction === true
      ? ['--allow-production']
      : []),
    ...credentials,
    ...jsonArgs(output),
  ];
  const runnable = (choices: CommandChoice[]): RunnableChoice[] =>
    choices.map((choice) => ({ ...choice, argv: completeArgv(choice.argv ?? []) }));
  const choiceArgv: ChoiceArgv<AppChoiceKind> = (choice, kind) =>
    kind === 'base' || kind === 'object'
      ? completeArgv(choice.argv ?? [])
      : commandArgv(
          command,
          [...rerunArgs, ...choice.args, ...accountArgs(options, deps.processEnv)],
          output,
        );
  const appArgv = (args: string[]): string[] =>
    commandArgv('appbuilder app', [...args, ...credentials], output);

  return {
    output,
    runnable,
    appArgv,
    pin: (account) => {
      credentials = pinnedCredentialArgs(options, account);
    },
    apply: (args, production) => ({
      applyArgv: appArgv([...args, '--yes', ...(production ? ['--allow-production'] : [])]),
      requiresProductionConsent: production,
    }),
    fail: (result) => {
      const reason = result.conflict?.reason;
      const next: NextCommand[] | undefined =
        result.code === 'publish_conflict'
          ? [
              reason === 'preview_replaced'
                ? { step: 'publish', argv: appArgv(['publish']) }
                : reason === 'base_unknown'
                  ? { step: 'push', argv: appArgv(['push']) }
                  : { step: 'merge', argv: appArgv(['merge']) },
            ]
          : undefined;

      writeFailure(output, next === undefined ? result : { ...result, next }, choiceArgv);
    },
  };
}

interface Signed {
  credentials: CommandAccount;
  client: KizenClient;
}

async function signIn(
  options: AuthFlags,
  deps: AppDeps,
  pin: Runner['pin'],
): Promise<AppStep<Signed>> {
  const step = await resolveCredentials(options, deps);

  if (!step.ok) {
    return step;
  }

  pin(step.value.credentials);

  writeNotices(deps, step.value.notices);

  return success({ credentials: step.value.credentials, client: step.value.client });
}

async function contextFor(
  signed: Signed,
  baseApiName: string | undefined,
  deps: AppDeps,
): Promise<AppStep<AppContext>> {
  let name = baseApiName;

  if (name === undefined) {
    try {
      name = await deps.readManifestApiName(deps.cwd);
    } catch (error) {
      return appFailure(error);
    }
  }

  const context = await loadAppContext({ ...signed, baseApiName: name }, deps);

  if (context.ok) {
    writeNotices(deps, context.value.notices);
  }

  return context;
}

async function openContext(
  options: AppCommandOptions,
  deps: AppDeps,
  { fail, pin }: Pick<Runner, 'fail' | 'pin'>,
): Promise<AppContext | null> {
  const signed = await signIn(options, deps, pin);

  if (!signed.ok) {
    fail(signed);

    return null;
  }

  const context = await contextFor(signed.value, undefined, deps);

  if (!context.ok) {
    fail(context);

    return null;
  }

  return context.value;
}

const versionLabel = (version: string | null): string =>
  version === null ? 'none' : `v${version}`;

export function formatAppSummaryLines(summary: AppSummary): string[] {
  return [
    `Environment: ${summary.environment}${summary.isProduction ? ' (production)' : ''}`,
    `Business: ${summary.businessId}`,
    summary.apiName === null
      ? `App: ${summary.baseApiName} (not published to this business yet)`
      : `App: ${summary.name ?? summary.baseApiName} (${summary.apiName})`,
    `Live: ${versionLabel(summary.liveVersion)}`,
  ];
}

const appJson = (summary: AppSummary): Record<string, unknown> => ({
  environment: summary.environment,
  businessId: summary.businessId,
  userId: summary.userId,
  app: {
    baseApiName: summary.baseApiName,
    apiName: summary.apiName,
    name: summary.name,
    liveVersion: summary.liveVersion,
  },
});

const lines = (...parts: (string | false | undefined)[]): string =>
  `${parts.filter((part): part is string => typeof part === 'string').join('\n')}\n`;

async function agentSkillWarnings(deps: AppDeps): Promise<string[]> {
  try {
    return await deps.staleAgentFileWarnings(deps.cwd);
  } catch {
    return [];
  }
}

const choiceLines = (title: string, choices: RunnableChoice[]): string[] =>
  choices.length === 0
    ? []
    : [
        title,
        ...choices.map((choice) => `  ${choice.label}  →  ${choice.argv.map(quoteArg).join(' ')}`),
      ];

export function formatJsActionLine(action: JsActionInfo): string {
  const title = `${action.apiName} (${action.name})`;

  switch (action.status) {
    case 'linked':
      return `  ${title}: linked to ${action.links
        .map(
          (link) =>
            `${link.label} (${link.objectName}, menu: ${link.includePerformAction === true ? 'on' : 'off'})`,
        )
        .join(', ')}`;
    case 'unlinked':
      return `  ${title}: not linked${action.hintObjectName === null ? '' : ` (hint: ${action.hintObjectName})`}`;
    case 'unknown':
      return `  ${title}: not in Live, so its links can't be listed`;
  }
}

export const formatJsActionsLines = (check: JsActionsCheck): string[] =>
  check.actions.length === 0 ? [] : ['JS actions:', ...check.actions.map(formatJsActionLine)];

const jsActionsNext = (check: JsActionsCheck, appArgv: Runner['appArgv']): NextCommand[] =>
  jsActionsNextArgs(check).map(({ step, args }) => ({ step, argv: appArgv(args) }));

export const OBJECT_SLOT = '<object>';

const jsActionsListJson = (
  actions: readonly JsActionInfo[],
  appArgv: Runner['appArgv'],
): Record<string, unknown>[] =>
  actions.map((action) => ({
    ...action,
    links: action.links.map((link) => ({
      ...link,
      unlinkArgv: appArgv(['actions', 'unlink', action.apiName, link.objectId]),
    })),
    linkArgv: appArgv(['actions', 'link', action.apiName, OBJECT_SLOT]),
    linkMenuArgv: appArgv(['actions', 'link', action.apiName, OBJECT_SLOT, '--menu']),
    linkNoMenuArgv: appArgv(['actions', 'link', action.apiName, OBJECT_SLOT, '--no-menu']),
  }));

const jsActionsJson = (
  check: JsActionsCheck,
  next: NextCommand[],
  appArgv: Runner['appArgv'],
): Record<string, unknown> => ({
  status: check.status,
  liveVersion: check.liveVersion,
  ...(check.error === undefined ? {} : { error: check.error }),
  actions: jsActionsListJson(check.actions, appArgv),
  next,
});

function writeDryRun(
  output: CommandOutput,
  gate: Extract<WriteGate, { kind: 'dry-run' }>,
  result: Record<string, unknown>,
  apply: ReturnType<Runner['apply']> | null,
  text: string,
): void {
  writeResult(
    output,
    {
      ok: true,
      applied: false,
      dryRun: true,
      reason: gate.reason,
      ...result,
      ...(apply ?? {}),
      next: [],
    },
    text,
  );

  if (gate.reason === 'no_yes') {
    output.deps.writeStderr(`${DRY_RUN_NOTE}\n`);
  }
}

function formatVersionInfo(info: AppVersionInfo): string {
  const published = [
    info.publishedAt === null ? undefined : `published ${info.publishedAt}`,
    info.publishedBy === null ? undefined : `by ${info.publishedBy}`,
  ].filter((part) => part !== undefined);

  return `v${info.version}${published.length === 0 ? '' : ` (${published.join(' ')})`}`;
}

const baseText = (base: RecordedBase): string =>
  base.recorded ? versionLabel(base.version) : 'not recorded';

export function formatVersionsLines(report: AppVersionsReport): string[] {
  const summary = formatAppSummaryLines(report.summary).filter((line) => !line.startsWith('Live:'));
  const baseLines = [`Folder base: ${baseText(report.base.folder)}`];

  if (!report.published) {
    return [
      ...summary,
      '',
      `${report.summary.baseApiName} isn't published to this business yet.`,
      ...baseLines,
    ];
  }

  return [
    ...summary,
    `Live: ${report.live === null ? 'none' : formatVersionInfo(report.live)}`,
    'Released:',
    ...(report.released.length === 0
      ? ['  (none)']
      : report.released.map((info) => `  ${formatVersionInfo(info)}`)),
    'Previews:',
    ...(report.previews.length === 0
      ? ['  (none)']
      : report.previews.map(
          (info) =>
            `  ${info.previewOwner?.fullName ?? 'unknown'}${info.yours ? ' (yours)' : ''}, updated ${info.updated ?? 'unknown'}`,
        )),
    ...baseLines,
  ];
}

function versionsNextSteps(report: AppVersionsReport, appArgv: Runner['appArgv']): AppNextStep[] {
  if (report.base.liveMoved) {
    return [{ step: 'merge', argv: appArgv(['merge']) }];
  }

  return [
    { step: 'push', argv: appArgv(['push']) },
    { step: 'publish', argv: appArgv(['publish']) },
  ];
}

export async function runAppVersionsHeadless(
  options: AppCommandOptions,
  deps: AppDeps,
): Promise<void> {
  const run = runner('appbuilder app versions', [], options, deps);
  const { output, fail } = run;

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const folderBase = await recordedFolderBase(context);

    if (!folderBase.ok) {
      fail(folderBase);

      return;
    }

    const described = describeVersions(context, folderBase.value);
    const jsCheck = await checkJsActions(context, { kind: 'app' });
    const jsNotices = jsActionsNotices(jsCheck);
    const jsNext = jsActionsNext(jsCheck, run.appArgv);
    const report = {
      ...described,
      warnings: [
        ...described.warnings,
        ...jsActionsWarnings(jsCheck),
        ...(await agentSkillWarnings(deps)),
      ],
    };

    writeNotices(deps, jsNotices);
    writeResult(
      output,
      {
        ok: true,
        ...appJson(report.summary),
        published: report.published,
        live: report.live,
        released: report.released,
        previews: report.previews,
        yourPreview: report.yourPreview,
        base: report.base,
        jsActions: jsActionsJson(jsCheck, jsNext, run.appArgv),
        notices: jsNotices,
        warnings: report.warnings,
        next: [...versionsNextSteps(report, run.appArgv), ...jsNext],
      },
      lines(
        ...formatVersionsLines(report),
        ...formatJsActionsLines(jsCheck),
        ...warningLines(report.warnings),
      ),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

export const formatIssueWarning = (issue: ValidationIssue): string =>
  `${issue.path === undefined ? '' : `${issue.path}: `}${issue.message} (${issue.rule})`;

const BASE_SOURCE_TEXT = {
  recorded: 'recorded for this folder',
  never_published: 'the app has no Live version yet',
  detected: 'matched exactly',
  preview: "matches your preview exactly; your preview's base, read from the server",
  base_from_preview: "continues your preview; your preview's base, read from the server",
} as const satisfies Record<AppPushPlan['base']['source'], string>;

export const formatPushPlanLines = (plan: AppPushPlan): string[] => [
  ...formatAppSummaryLines(plan.summary),
  `Source: ${String(plan.source.files)} files (${plan.source.mode}), ${String(plan.source.bytes)} bytes`,
  `Thumbnail: ${plan.thumbnail ? 'yes' : 'no'}`,
  plan.preview.exists
    ? `Preview: replaces yours (last updated ${plan.preview.updated ?? 'unknown'})`
    : 'Preview: new',
  `Base: ${versionLabel(plan.base.version)} (${BASE_SOURCE_TEXT[plan.base.source]})`,
];

export const pushedLine = (appName: string, applied: AppliedAppPush): string =>
  `✓ Saved your preview of ${appName} (${applied.apiName})`;

export async function runAppPushHeadless(options: AppPushOptions, deps: AppDeps): Promise<void> {
  const run = runner('appbuilder app push', [], options, deps);
  const { output, fail, appArgv, apply } = run;
  const pushArgs = [
    'push',
    ...(options.force === true ? ['--force'] : []),
    ...(options.baseFromPreview === undefined
      ? []
      : ['--base-from-preview', options.baseFromPreview]),
  ];

  try {
    const signed = await signIn(options, deps, run.pin);

    if (!signed.ok) {
      fail(signed);

      return;
    }

    const prepared = await preparePush(deps);

    if (!prepared.ok) {
      fail(prepared);

      return;
    }

    const { deployable, issues, source } = prepared.value;

    if (issues.length > 0) {
      deps.writeStderr(`${formatValidationIssues(issues)}\n`);
    }

    if (source.notice !== undefined) {
      deps.writeStderr(`${source.notice}\n`);
    }

    const contextStep = await contextFor(signed.value, deployable.api_name, deps);

    if (!contextStep.ok) {
      fail(contextStep);

      return;
    }

    const context = contextStep.value;
    const planned = await planPush(
      context,
      prepared.value,
      {
        force: options.force === true,
        ...(options.baseFromPreview !== undefined && { baseFromPreview: options.baseFromPreview }),
      },
      deps,
    );

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;

    writeNotices(deps, plan.notices);

    const gate = headlessWriteGate(options, context.credentials.environment);

    if (!gate.ok) {
      fail(gate);

      return;
    }

    const templates = jsActionTemplatesOf(deployable.artifacts.js_action_templates);
    const skillWarnings = await agentSkillWarnings(deps);
    const withCheck = (
      jsCheck: JsActionsCheck,
    ): {
      jsNext: NextCommand[];
      warnings: string[];
      notices: string[];
      jsActions: Record<string, unknown>;
    } => {
      const jsNotices = jsActionsNotices(jsCheck);
      const jsNext = jsActionsNext(jsCheck, appArgv);

      writeNotices(deps, jsNotices);

      return {
        jsNext,
        warnings: [
          ...issues.map(formatIssueWarning),
          ...plan.warnings,
          ...jsActionsWarnings(jsCheck),
          ...skillWarnings,
        ],
        notices: [...plan.notices, ...jsNotices],
        jsActions: jsActionsJson(jsCheck, jsNext, appArgv),
      };
    };

    const planJson = {
      ...appJson(plan.summary),
      source: plan.source,
      thumbnail: plan.thumbnail,
      preview: plan.preview,
      base: plan.base,
      conflictMarkers: plan.conflictMarkers,
    };

    if (gate.value.kind === 'dry-run') {
      const jsCheck = await checkJsActions(context, { kind: 'version', templates });
      const { warnings, notices, jsActions } = withCheck(jsCheck);

      writeDryRun(
        output,
        gate.value,
        { action: 'push', ...planJson, jsActions, notices, warnings },
        apply(pushArgs, plan.summary.isProduction),
        lines(
          ...formatPushPlanLines(plan),
          ...formatJsActionsLines(jsCheck),
          ...warningLines(warnings),
        ),
      );

      return;
    }

    const applied = await applyPush(context, prepared.value, plan, deps);

    if (!applied.ok) {
      fail(applied);

      return;
    }

    const jsCheck = await checkPushedJsActions(context, templates);
    const { jsNext, warnings, notices, jsActions } = withCheck(jsCheck);
    const allWarnings = [...warnings, ...applied.value.warnings];
    const uploaded = { ...plan, source: applied.value.source };

    writeResult(
      output,
      {
        ok: true,
        applied: true,
        dryRun: false,
        action: 'push',
        ...planJson,
        jsActions,
        source: applied.value.source,
        previewVersion: applied.value.version,
        apiName: applied.value.apiName,
        sourcePackageId: applied.value.sourcePackageId,
        thumbnailId: applied.value.thumbnailId,
        remembered: applied.value.remembered,
        notices,
        warnings: allWarnings,
        next: [...jsNext, { step: 'publish', argv: appArgv(['publish']) }] satisfies AppNextStep[],
      },
      lines(
        pushedLine(deployable.name, applied.value),
        ...formatPushPlanLines(uploaded),
        ...formatJsActionsLines(jsCheck),
        ...warningLines(allWarnings),
      ),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

function formatConflictCheck(check: ConflictCheck, forced: boolean): string {
  const how =
    check.reason === 'base_unknown'
      ? "your preview's source doesn't say what it's based on"
      : `your preview's base ${versionLabel(check.baseLiveVersion)}, read from its source on the server`;

  return `Conflict check: ${check.conflict ? (forced ? 'conflict, overridden by --force' : 'conflict') : 'none'} (${how})`;
}

export const formatPublishPlanLines = (plan: AppPublishPlan): string[] => [
  ...formatAppSummaryLines(plan.summary),
  `Preview: last updated ${plan.previewUpdatedAt ?? 'unknown'}`,
  formatConflictCheck(plan.conflictCheck, plan.forced),
];

export const nextReleaseLine = (plan: AppPublishPlan): string =>
  `Publish: Live becomes the next release number (at least v${plan.nextReleaseAtLeast})`;

export const publishedLine = (plan: AppPublishPlan, applied: AppliedAppPublish): string =>
  `✓ Published Live v${applied.liveVersion} of ${plan.summary.name ?? plan.summary.baseApiName}`;

export async function runAppPublishHeadless(
  options: AppPublishOptions,
  deps: AppDeps,
): Promise<void> {
  const run = runner('appbuilder app publish', [], options, deps);
  const { output, fail, apply, appArgv } = run;
  const publishArgs = ['publish', ...(options.force === true ? ['--force'] : [])];

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const planned = await planPublish(
      context,
      {
        force: options.force === true,
        ...(options.expectPreview !== undefined && { expectPreview: options.expectPreview }),
      },
      deps,
    );

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const gate = headlessWriteGate(options, context.credentials.environment);

    if (!gate.ok) {
      fail(gate);

      return;
    }

    const planLines = formatPublishPlanLines(plan);
    const planWarnings = [...plan.warnings, ...(await agentSkillWarnings(deps))];
    const planJson = {
      ...appJson(plan.summary),
      previewUpdatedAt: plan.previewUpdatedAt,
      conflictCheck: plan.conflictCheck,
      forced: plan.forced,
    };

    if (gate.value.kind === 'dry-run') {
      const jsCheck = await checkJsActions(context, {
        kind: 'version',
        templates: jsActionTemplatesOf(plan.jsActionTemplates),
      });
      const jsNotices = jsActionsNotices(jsCheck);
      const warnings = [...planWarnings, ...jsActionsWarnings(jsCheck)];

      writeNotices(deps, jsNotices);
      writeDryRun(
        output,
        gate.value,
        {
          action: 'publish',
          ...planJson,
          nextReleaseAtLeast: plan.nextReleaseAtLeast,
          jsActions: jsActionsJson(jsCheck, jsActionsNext(jsCheck, appArgv), appArgv),
          notices: jsNotices,
          warnings,
        },
        apply(
          [...publishArgs, '--expect-preview', plan.previewSourcePackageId],
          plan.summary.isProduction,
        ),
        lines(
          ...planLines,
          nextReleaseLine(plan),
          ...formatJsActionsLines(jsCheck),
          ...warningLines(warnings),
        ),
      );

      return;
    }

    const applied = await applyPublish(context, plan, deps);

    if (!applied.ok) {
      fail(applied);

      return;
    }

    const jsCheck = await checkJsActions(context, {
      kind: 'live',
      version: applied.value.liveVersion,
    });
    const jsNotices = jsActionsNotices(jsCheck);
    const jsNext = jsActionsNext(jsCheck, appArgv);
    const warnings = [...planWarnings, ...applied.value.warnings, ...jsActionsWarnings(jsCheck)];

    writeNotices(deps, jsNotices);

    writeResult(
      output,
      {
        ok: true,
        applied: true,
        dryRun: false,
        action: 'publish',
        ...planJson,
        apiName: applied.value.apiName,
        liveVersion: applied.value.liveVersion,
        previousLiveVersion: applied.value.previousLiveVersion,
        remembered: applied.value.remembered,
        jsActions: jsActionsJson(jsCheck, jsNext, appArgv),
        notices: jsNotices,
        warnings,
        next: jsNext satisfies AppNextStep[],
      },
      lines(
        publishedLine(plan, applied.value),
        ...planLines,
        ...formatJsActionsLines(jsCheck),
        ...warningLines(warnings),
      ),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

export const pathList = (title: string, paths: string[]): string[] =>
  paths.length === 0
    ? []
    : [`${title} (${String(paths.length)}):`, ...paths.map((path) => `  ${path}`)];

export function formatMergeLists(lists: AppMergeLists): string[] {
  return [
    ...pathList('Written', lists.written),
    ...pathList('Deleted', lists.deleted),
    ...pathList('Conflicted', lists.conflicted),
    ...pathList('Edited here, deleted on Live (kept)', lists.deletedOnLive),
    ...pathList('Deleted here, changed on Live (restored)', lists.deletedLocally),
    ...pathList('Binary files changed on both sides (yours kept)', lists.binaryConflicts),
    ...pathList('On Live but excluded here (not written)', lists.ignoredIncoming),
  ];
}

export const targetLabel = (version: string, isLive: boolean): string =>
  isLive ? `Live v${version}` : `v${version}`;

export const conflictInstructions = (label: string): string =>
  `Resolve the conflict markers in the files above: the side marked <<<<<<< HEAD is your file and the side marked >>>>>>> live is ${label}. Then run \`appbuilder app push\` and \`appbuilder app publish\`.`;

export const FALLBACK_INSTRUCTIONS =
  'Merge it into this folder by hand and then record its base, or merge from the release this folder was copied from with --base <n>. Use --base only with the release it was really copied from: a wrong one drops the changes made since then.';

export function formatMergePlanLines(plan: AppMergePlan): string[] {
  const base = plan.baseVersion === undefined ? 'not recorded' : versionLabel(plan.baseVersion);
  const label = targetLabel(plan.targetVersion, plan.targetIsLive);

  switch (plan.kind) {
    case 'accept':
      return [
        `Base: ${base}`,
        `Record v${plan.targetVersion} as this folder's base without merging.`,
      ];
    case 'up_to_date':
      return [
        `Base: ${base}`,
        `This folder already includes v${plan.targetVersion}.`,
        ...pathList('On Live but excluded here (not written)', plan.ignoredIncoming),
      ];
    case 'merge':
      return [`Merge ${label} into this folder (base ${base}).`, ...formatMergeLists(plan.plan)];
    case 'fallback':
      return [
        `Base: ${base}`,
        `Can't merge automatically: ${plan.detail}`,
        `${label}'s source goes into ${plan.dir}.`,
      ];
  }
}

function mergePlanJson(plan: AppMergePlan): Record<string, unknown> {
  const common = {
    kind: plan.kind,
    targetVersion: plan.targetVersion,
    targetIsLive: plan.targetIsLive,
    baseVersion: plan.baseVersion ?? null,
    baseSource: plan.baseSource,
    notices: plan.notices,
  };

  switch (plan.kind) {
    case 'accept':
      return common;
    case 'up_to_date':
      return { ...common, ignoredIncoming: plan.ignoredIncoming };
    case 'merge': {
      const {
        written,
        deleted,
        conflicted,
        deletedOnLive,
        deletedLocally,
        binaryConflicts,
        ignoredIncoming,
      } = plan.plan;

      return {
        ...common,
        written,
        deleted,
        conflicted,
        deletedOnLive,
        deletedLocally,
        binaryConflicts,
        ignoredIncoming,
      };
    }

    case 'fallback':
      return { ...common, fallback: { reason: plan.reason, detail: plan.detail, dir: plan.dir } };
  }
}

function pinnedMergeArgs(plan: AppMergePlan): string[] {
  const unrecordedBase =
    (plan.baseSource === 'flag' || plan.baseSource === 'detected') &&
    typeof plan.baseVersion === 'string';

  return [
    'merge',
    '--release',
    plan.targetVersion,
    ...(unrecordedBase && typeof plan.baseVersion === 'string' ? ['--base', plan.baseVersion] : []),
    ...(plan.kind === 'accept' ? ['--accept-live-base'] : []),
  ];
}

function mergeNextSteps(result: AppliedAppMerge, appArgv: Runner['appArgv']): AppNextStep[] {
  if (result.status !== 'merged' && result.status !== 'conflicts' && result.status !== 'accepted') {
    return [];
  }

  return [
    ...(result.markedPaths.length === 0
      ? []
      : [{ step: 'resolve' as const, files: result.markedPaths, markers: MARKER_LABELS }]),
    { step: 'push', argv: appArgv(['push']) },
    { step: 'publish', argv: appArgv(['publish']) },
  ];
}

export function formatMergeOutcomeLines(plan: AppMergePlan, result: AppliedAppMerge): string[] {
  const { targetVersion } = result;
  const label = targetLabel(plan.targetVersion, plan.targetIsLive);

  switch (result.status) {
    case 'accepted':
      return [`✓ Recorded v${targetVersion} as this folder's base.`];
    case 'up_to_date':
      return [
        `✓ This folder already includes v${targetVersion}.`,
        ...pathList('On Live but excluded here (not written)', result.lists.ignoredIncoming),
      ];
    case 'merged':
      return [
        `✓ Merged ${label} into this folder.`,
        ...formatMergeLists(result.lists),
        'Run `appbuilder app push`, then `appbuilder app publish`.',
      ];
    case 'conflicts':
      return [
        `Merged ${label} into this folder with conflicts.`,
        ...formatMergeLists(result.lists),
        conflictInstructions(label),
      ];
    case 'fallback':
      return [
        ...(plan.kind === 'fallback' ? [`Can't merge automatically: ${plan.detail}`] : []),
        `${label}'s source is in ${result.extracted?.dir ?? ''}.`,
        ...pathList('Left out (safety list)', result.extracted?.skipped ?? []),
      ];
  }
}

export async function runAppMergeHeadless(
  options: AppMergeCommandOptions,
  deps: AppDeps,
): Promise<void> {
  const rerun = [
    ...(options.release === undefined ? [] : ['--release', options.release]),
    ...(options.base === undefined ? [] : ['--base', options.base]),
    ...(options.acceptLiveBase === true ? ['--accept-live-base'] : []),
  ];
  const run = runner('appbuilder app merge', rerun, options, deps);
  const { output, fail, runnable, appArgv, apply } = run;

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const planned = await planAppMerge(
      context,
      {
        ...(options.release === undefined ? {} : { version: options.release }),
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.acceptLiveBase === true ? { acceptLiveBase: true } : {}),
      },
      deps,
    );

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;

    writeNotices(deps, plan.notices);

    const gate = headlessWriteGate(
      { dryRun: options.dryRun === true, yes: options.yes === true, allowProduction: true },
      context.credentials.environment,
    );

    if (!gate.ok) {
      fail(gate);

      return;
    }

    const summaryLines = formatAppSummaryLines(plan.summary);
    const planWarnings = [...plan.warnings, ...(await agentSkillWarnings(deps))];
    const choices = plan.kind === 'fallback' ? runnable(plan.choices) : [];
    const planJson = {
      ...appJson(plan.summary),
      ...mergePlanJson(plan),
      ...(plan.kind === 'fallback' ? { choices } : {}),
    };

    if (gate.value.kind === 'dry-run') {
      writeDryRun(
        output,
        gate.value,
        { action: 'merge', ...planJson, warnings: planWarnings },
        apply(pinnedMergeArgs(plan), false),
        lines(...summaryLines, ...formatMergePlanLines(plan), ...warningLines(planWarnings)),
      );

      return;
    }

    const applied = await applyAppMerge(context, plan, deps);

    if (!applied.ok) {
      fail(applied);

      return;
    }

    const result = applied.value;
    const outcome = [
      ...formatMergeOutcomeLines(plan, result),
      ...(result.status === 'fallback' ? choiceLines(FALLBACK_INSTRUCTIONS, choices) : []),
    ];

    writeResult(
      output,
      {
        ok: true,
        applied: true,
        dryRun: false,
        action: 'merge',
        ...planJson,
        status: result.status,
        baseLiveVersion: result.baseLiveVersion ?? null,
        ...result.lists,
        ...(result.extracted === undefined ? {} : { extracted: result.extracted }),
        remembered: result.remembered,
        warnings: [...planWarnings, ...result.warnings],
        next: mergeNextSteps(result, appArgv),
      },
      lines(...summaryLines, ...outcome, ...warningLines([...planWarnings, ...result.warnings])),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

export const formatRollbackPlanLines = (plan: AppRollbackPlan): string[] => [
  ...formatAppSummaryLines(plan.summary),
  `Rollback: restore v${plan.version} as your preview`,
];

export const rolledBackLine = (plan: AppRollbackPlan): string =>
  `✓ Restored v${plan.version} as your preview of ${plan.summary.name ?? plan.summary.baseApiName}`;

export async function runAppRollbackHeadless(
  version: string,
  options: AppWriteOptions,
  deps: AppDeps,
): Promise<void> {
  const run = runner('appbuilder app rollback', [version], options, deps);
  const { output, fail, appArgv, apply } = run;

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const planned = await planRollback(context, version, deps);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const gate = headlessWriteGate(options, context.credentials.environment);

    if (!gate.ok) {
      fail(gate);

      return;
    }

    const planLines = formatRollbackPlanLines(plan);
    const planWarnings = [...plan.warnings, ...(await agentSkillWarnings(deps))];
    const planJson = { ...appJson(plan.summary), version: plan.version, preview: plan.preview };

    if (gate.value.kind === 'dry-run') {
      writeDryRun(
        output,
        gate.value,
        { action: 'rollback', ...planJson, warnings: planWarnings },
        apply(['rollback', version], plan.summary.isProduction),
        lines(...planLines, ...warningLines(planWarnings)),
      );

      return;
    }

    const applied = await applyRollback(context, plan, deps);

    if (!applied.ok) {
      fail(applied);

      return;
    }

    const warnings = [...planWarnings, ...applied.value.warnings];

    writeResult(
      output,
      {
        ok: true,
        applied: true,
        dryRun: false,
        action: 'rollback',
        ...planJson,
        apiName: applied.value.apiName,
        sourcePackageId: applied.value.sourcePackageId,
        remembered: applied.value.remembered,
        warnings,
        next: [{ step: 'publish', argv: appArgv(['publish']) }] satisfies AppNextStep[],
      },
      lines(rolledBackLine(plan), ...planLines, ...warningLines(warnings)),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

export const formatPullLines = (plan: AppPullPlan, applied: AppliedAppPull): string[] => {
  const name = plan.summary.name ?? plan.summary.baseApiName;
  const files = `(${String(applied.written.length)} files)`;

  return [
    plan.source === 'release'
      ? `✓ Extracted v${plan.version} of ${name} into ${applied.dir} ${files}`
      : `✓ Extracted your preview of ${name} into ${applied.dir} ${files}`,
    ...(applied.preview === undefined ? [] : [`Folder base: ${baseText(applied.preview.base)}`]),
    ...pathList('Left out (safety list)', applied.skipped),
  ];
};

const pullSourceJson = (plan: AppPullPlan, applied: AppliedAppPull): Record<string, unknown> =>
  plan.source === 'release'
    ? { version: plan.version }
    : {
        source: 'preview',
        preview: {
          updated: plan.updated,
          sourcePackageId: applied.preview?.sourcePackageId ?? null,
        },
        base: applied.preview?.base ?? null,
      };

export async function runAppPullHeadless(
  version: string | undefined,
  options: AppPullOptions,
  deps: AppDeps,
): Promise<void> {
  const target = pullTargetOf(version, options.preview === true);

  if (!target.ok) {
    runner('appbuilder app pull', [], options, deps).fail(target);

    return;
  }

  const rerun = [
    ...(target.value.kind === 'release' ? [target.value.version] : ['--preview']),
    ...(options.out === undefined ? [] : ['--out', options.out]),
  ];
  const run = runner('appbuilder app pull', rerun, options, deps);
  const { output, fail } = run;

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const planned = await planPull(context, target.value, options, deps);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const applied = await applyPull(context, plan, deps);

    if (!applied.ok) {
      fail(applied);

      return;
    }

    const { dir, written, skipped, remembered } = applied.value;
    const warnings = [
      ...plan.warnings,
      ...applied.value.warnings,
      ...(await agentSkillWarnings(deps)),
    ];

    writeResult(
      output,
      {
        ok: true,
        ...appJson(plan.summary),
        ...pullSourceJson(plan, applied.value),
        dir,
        written,
        skipped,
        remembered,
        warnings,
        next: [] satisfies AppNextStep[],
      },
      lines(...formatPullLines(plan, applied.value), ...warningLines(warnings)),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

export interface AppActionsLinkOptions extends AppWriteOptions {
  menu?: boolean;
}

export const formatActionsListLines = (summary: AppSummary, check: JsActionsCheck): string[] => [
  ...formatAppSummaryLines(summary),
  ...(check.actions.length === 0 ? ['No JS actions.'] : formatJsActionsLines(check)),
];

const menuText = (include: boolean | null): string =>
  include === true ? 'shown in its Perform Action menus' : 'not shown in its Perform Action menus';

const objectText = (plan: { object: { name: string; label: string } }): string =>
  `${plan.object.label} (${plan.object.name})`;

export function formatActionLinkPlanLines(plan: ActionLinkPlan): string[] {
  const action = plan.action.apiName;

  switch (plan.change) {
    case 'create':
      return [`Link ${action} to ${objectText(plan)}, ${menuText(plan.includePerformAction)}.`];
    case 'update':
      return [
        `Change ${action}'s link to ${objectText(plan)}: ${menuText(plan.includePerformAction)}.`,
      ];
    case 'up_to_date':
      return [
        `${action} is already linked to ${objectText(plan)}, ${menuText(plan.includePerformAction)}.`,
      ];
  }
}

export const formatActionUnlinkPlanLines = (plan: ActionUnlinkPlan): string[] => [
  `Unlink ${plan.action.apiName} from ${objectText(plan)}.`,
];

export const actionLinkedLine = (plan: ActionLinkPlan, status: ActionLinkStatus): string =>
  status === 'updated'
    ? `✓ Updated ${plan.action.apiName}'s link to ${plan.object.label}`
    : status === 'already_linked'
      ? `${plan.action.apiName} was already linked to ${plan.object.label}`
      : `✓ Linked ${plan.action.apiName} to ${plan.object.label}`;

export const actionUnlinkedLine = (plan: ActionUnlinkPlan): string =>
  `✓ Unlinked ${plan.action.apiName} from ${plan.object.label}`;

export function actionArguments(
  command: 'link' | 'unlink',
  args: { action: string | undefined; object: string | undefined },
): AppStep<{ action: string; object: string }> {
  const { action, object } = args;

  if (action !== undefined && object !== undefined) {
    return success({ action, object });
  }

  return failure<AppChoiceKind>(
    'usage_error',
    `Missing argument <${action === undefined ? 'action' : 'object'}>. Usage: appbuilder app actions ${command} <action> <object>. A headless run needs both; at a terminal, leave them out to pick them.`,
  );
}

const actionLinkJson = (plan: ActionLinkPlan): Record<string, unknown> => ({
  ...appJson(plan.summary),
  jsAction: {
    apiName: plan.action.apiName,
    name: plan.action.name,
    hintObjectName: plan.action.hintObjectName,
    inLive: plan.action.inLive,
  },
  object: plan.object,
  change: plan.change,
  includePerformAction: plan.includePerformAction,
  existing: plan.existing,
});

export async function runAppActionsListHeadless(
  options: AppCommandOptions,
  deps: AppDeps,
): Promise<void> {
  const run = runner('appbuilder app actions list', [], options, deps);
  const { output, fail, appArgv } = run;

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const planned = await planActionsList(context);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const { summary, check } = planned.value;
    const warnings = [...jsActionsWarnings(check), ...(await agentSkillWarnings(deps))];

    writeResult(
      output,
      {
        ok: true,
        ...appJson(summary),
        published: context.app !== null,
        status: check.status,
        actions: jsActionsListJson(check.actions, appArgv),
        warnings,
        next: jsActionsNext(check, appArgv).filter((step) => step.step !== 'actions'),
      },
      lines(...formatActionsListLines(summary, check), ...warningLines(warnings)),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

export async function runAppActionsLinkHeadless(
  actionArg: string | undefined,
  objectArg: string | undefined,
  options: AppActionsLinkOptions,
  deps: AppDeps,
): Promise<void> {
  const named = actionArguments('link', { action: actionArg, object: objectArg });

  if (!named.ok) {
    runner('appbuilder app actions link', [], options, deps).fail(named);

    return;
  }

  const { action, object } = named.value;

  const menuArgs = options.menu === undefined ? [] : [options.menu ? '--menu' : '--no-menu'];
  const run = runner('appbuilder app actions link', [action, object, ...menuArgs], options, deps);
  const { output, fail, appArgv, apply } = run;
  const choiceArgv = (candidate: BusinessObject): string[] => [
    'appbuilder',
    'app',
    'actions',
    'link',
    action,
    candidate.id,
    ...menuArgs,
  ];

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const planned = await planActionLink(
      context,
      { action, object, ...(options.menu === undefined ? {} : { menu: options.menu }) },
      choiceArgv,
    );

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const planLines = [...formatAppSummaryLines(plan.summary), ...formatActionLinkPlanLines(plan)];
    const skillWarnings = await agentSkillWarnings(deps);
    const planWarnings = [...plan.warnings, ...skillWarnings];

    writeNotices(deps, plan.notices);

    if (plan.change === 'up_to_date') {
      writeResult(
        output,
        {
          ok: true,
          applied: false,
          dryRun: false,
          action: 'actions link',
          ...actionLinkJson(plan),
          status: 'up_to_date',
          notices: plan.notices,
          warnings: planWarnings,
          next: [] satisfies NextCommand[],
        },
        lines(...planLines, ...warningLines(planWarnings)),
      );

      return;
    }

    const gate = headlessWriteGate(options, context.credentials.environment);

    if (!gate.ok) {
      fail(gate);

      return;
    }

    if (gate.value.kind === 'dry-run') {
      writeDryRun(
        output,
        gate.value,
        {
          action: 'actions link',
          ...actionLinkJson(plan),
          notices: plan.notices,
          warnings: planWarnings,
        },
        apply(
          [
            'actions',
            'link',
            plan.action.apiName,
            plan.object.id,
            plan.includePerformAction === true ? '--menu' : '--no-menu',
          ],
          plan.summary.isProduction,
        ),
        lines(...planLines, ...warningLines(planWarnings)),
      );

      return;
    }

    const applied = await applyActionLink(context, plan);

    if (!applied.ok) {
      fail(applied);

      return;
    }

    const warnings = [
      ...(applied.value.status === 'already_linked' ? skillWarnings : planWarnings),
      ...applied.value.warnings,
    ];
    const done = actionLinkedLine(plan, applied.value.status);

    writeResult(
      output,
      {
        ok: true,
        applied: applied.value.status !== 'already_linked',
        dryRun: false,
        action: 'actions link',
        ...actionLinkJson(plan),
        status: applied.value.status,
        notices: plan.notices,
        warnings,
        next: [{ step: 'actions', argv: appArgv(['actions', 'list']) }] satisfies NextCommand[],
      },
      lines(done, ...planLines, ...warningLines(warnings)),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

export async function runAppActionsUnlinkHeadless(
  actionArg: string | undefined,
  objectArg: string | undefined,
  options: AppWriteOptions,
  deps: AppDeps,
): Promise<void> {
  const named = actionArguments('unlink', { action: actionArg, object: objectArg });

  if (!named.ok) {
    runner('appbuilder app actions unlink', [], options, deps).fail(named);

    return;
  }

  const { action, object } = named.value;

  const run = runner('appbuilder app actions unlink', [action, object], options, deps);
  const { output, fail, appArgv, apply } = run;
  const choiceArgv = (candidate: BusinessObject): string[] => [
    'appbuilder',
    'app',
    'actions',
    'unlink',
    action,
    candidate.id,
  ];

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const planned = await planActionUnlink(context, { action, object }, choiceArgv);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const gate = headlessWriteGate(options, context.credentials.environment);

    if (!gate.ok) {
      fail(gate);

      return;
    }

    const planLines = [
      ...formatAppSummaryLines(plan.summary),
      ...formatActionUnlinkPlanLines(plan),
    ];
    const warnings = [...plan.warnings, ...(await agentSkillWarnings(deps))];
    const planJson = {
      ...appJson(plan.summary),
      jsAction: {
        apiName: plan.action.apiName,
        name: plan.action.name,
        hintObjectName: plan.action.hintObjectName,
        inLive: plan.action.inLive,
      },
      object: plan.object,
      associationId: plan.associationId,
      includePerformAction: plan.includePerformAction,
    };

    if (gate.value.kind === 'dry-run') {
      writeDryRun(
        output,
        gate.value,
        { action: 'actions unlink', ...planJson, warnings },
        apply(
          ['actions', 'unlink', plan.action.apiName, plan.object.id],
          plan.summary.isProduction,
        ),
        lines(...planLines, ...warningLines(warnings)),
      );

      return;
    }

    const applied = await applyActionUnlink(context, plan);

    if (!applied.ok) {
      fail(applied);

      return;
    }

    writeResult(
      output,
      {
        ok: true,
        applied: true,
        dryRun: false,
        action: 'actions unlink',
        ...planJson,
        status: applied.value.status,
        warnings,
        next: [{ step: 'actions', argv: appArgv(['actions', 'list']) }] satisfies NextCommand[],
      },
      lines(actionUnlinkedLine(plan), ...planLines, ...warningLines(warnings)),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}

export interface AppPreviewDeleteOptions extends AppWriteOptions {
  owner?: string;
  expectUpdated?: string;
  deleteApp?: boolean;
}

export function formatPreviewDeletePlanLines(plan: AppPreviewDeletePlan): string[] {
  const { owner, preview } = plan;

  return [
    ...formatAppSummaryLines(plan.summary),
    `Preview: ${owner.fullName ?? owner.id} (${owner.yours ? 'yours' : owner.id}), last updated ${preview.updated ?? 'unknown'}`,
    ...(preview.activeUsersCount === null
      ? []
      : [`Active users: ${String(preview.activeUsersCount)}`]),
    ...(preview.installedCount === null ? [] : [`Installs: ${String(preview.installedCount)}`]),
    plan.deletesApp ? 'Delete: this preview, and with it the app' : 'Delete: this preview',
  ];
}

export const previewDeletedLines = (
  plan: AppPreviewDeletePlan,
  applied: AppliedPreviewDelete,
): string[] => {
  const appName = plan.summary.name ?? plan.summary.baseApiName;

  return [
    `✓ Deleted ${plan.owner.yours ? 'your' : `${plan.owner.fullName ?? plan.owner.id}'s`} preview of ${appName}`,
    ...(applied.appDeleted === true
      ? [`${appName} had no other version, so it was deleted from this business.`]
      : []),
    ...(plan.deletesApp && applied.appDeleted === false
      ? [`${appName} has another version now, so it wasn't deleted.`]
      : []),
  ];
};

const previewChangedNext = (
  failed: AppFailure,
  owner: string,
  appArgv: Runner['appArgv'],
): AppFailure =>
  failed.code === 'preview_changed'
    ? {
        ...failed,
        next: [{ step: 'preview delete', argv: appArgv(['preview', 'delete', '--owner', owner]) }],
      }
    : failed;

export const UNPINNED_PREVIEW_NOTICE =
  "Kizen reports no last update for this preview, so this dry run can't be pinned to it and has no applyArgv: it can't be applied from this dry run.";

const previewDeleteJson = (plan: AppPreviewDeletePlan): Record<string, unknown> => ({
  ...appJson(plan.summary),
  owner: plan.owner,
  preview: plan.preview,
  deletesApp: plan.deletesApp,
});

export async function runAppPreviewDeleteHeadless(
  options: AppPreviewDeleteOptions,
  deps: AppDeps,
): Promise<void> {
  const rerun = options.owner === undefined ? [] : ['--owner', options.owner];
  const run = runner('appbuilder app preview delete', rerun, options, deps);
  const { output, fail, appArgv, apply } = run;

  try {
    const context = await openContext(options, deps, run);

    if (context === null) {
      return;
    }

    const owner = (options.owner ?? context.credentials.userId).trim();
    const planned = planPreviewDelete(context, {
      ...(options.owner !== undefined && { owner: options.owner }),
      ...(options.expectUpdated !== undefined && { expectUpdated: options.expectUpdated }),
    });

    if (!planned.ok) {
      fail(previewChangedNext(planned, owner, appArgv));

      return;
    }

    const plan = planned.value;
    const gate = headlessWriteGate(options, context.credentials.environment);

    if (!gate.ok) {
      fail(gate);

      return;
    }

    const planLines = formatPreviewDeletePlanLines(plan);
    const planWarnings = [...plan.warnings, ...(await agentSkillWarnings(deps))];

    if (gate.value.kind === 'dry-run') {
      const { updated } = plan.preview;
      const notices = updated === null ? [UNPINNED_PREVIEW_NOTICE] : [];

      writeNotices(deps, notices);
      writeDryRun(
        output,
        gate.value,
        { action: 'preview delete', ...previewDeleteJson(plan), notices, warnings: planWarnings },
        updated === null
          ? null
          : apply(
              [
                'preview',
                'delete',
                '--owner',
                plan.owner.id,
                '--expect-updated',
                updated,
                ...(plan.deletesApp ? ['--delete-app'] : []),
              ],
              plan.summary.isProduction,
            ),
        lines(...planLines, ...warningLines(planWarnings)),
      );

      return;
    }

    const consent = requireDeleteAppConsent(plan, options.deleteApp === true);

    if (consent !== null) {
      fail(previewChangedNext(consent, plan.owner.id, appArgv));

      return;
    }

    const applied = await applyPreviewDelete(context, plan, deps);

    if (!applied.ok) {
      fail(previewChangedNext(applied, plan.owner.id, appArgv));

      return;
    }

    const outcome = deletedPreviewPlan(plan, applied.value);
    const warnings = [
      ...outcome.warnings,
      ...planWarnings.slice(plan.warnings.length),
      ...applied.value.warnings,
    ];

    writeResult(
      output,
      {
        ok: true,
        applied: true,
        dryRun: false,
        action: 'preview delete',
        ...previewDeleteJson(outcome),
        status: applied.value.status,
        appDeleted: applied.value.appDeleted,
        remembered: applied.value.remembered,
        warnings,
        next: (plan.owner.yours
          ? [{ step: 'push', argv: appArgv(['push']) }]
          : []) satisfies AppNextStep[],
      },
      lines(
        ...previewDeletedLines(plan, applied.value),
        ...formatPreviewDeletePlanLines(outcome),
        ...warningLines(warnings),
      ),
    );
  } catch (error) {
    fail(appFailure(error));
  }
}
