import {
  actionLinkPlanOf,
  actionUnlinkPlanOf,
  applyActionLink,
  applyActionUnlink,
  checkJsActions,
  checkPushedJsActions,
  findAction,
  jsActionsNextArgs,
  jsActionsNotices,
  jsActionsWarnings,
  jsActionTemplatesOf,
  planActionsList,
  readActionChoices,
  resolveObject,
  UNLISTED_UNLINK_HINT,
  type ActionChoices,
  type JsActionInfo,
  type JsActionsCheck,
} from '../lib/appActions.js';
import {
  applyAppMerge,
  applyPreviewDelete,
  applyPublish,
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
  recordedFolderBase,
  type AppContext,
  type AppDeps,
  type AppFailure,
  type AppMergeOptions,
  type ApplyControl,
  type AppStep,
  type PreparedPush,
  type ResolveFolderBaseOptions,
} from '../lib/appFlow.js';
import {
  actionLinkedLine,
  actionUnlinkedLine,
  FALLBACK_INSTRUCTIONS,
  formatActionLinkPlanLines,
  formatActionsListLines,
  formatActionUnlinkPlanLines,
  formatAppSummaryLines,
  formatJsActionsLines,
  formatMergeOutcomeLines,
  formatMergePlanLines,
  formatPreviewDeletePlanLines,
  formatPublishPlanLines,
  formatPullLines,
  formatPushPlanLines,
  formatRollbackPlanLines,
  formatVersionsLines,
  nextReleaseLine,
  previewDeletedLines,
  publishedLine,
  pushedLine,
  rolledBackLine,
  targetLabel,
  type AppActionsLinkOptions,
  type AppCommandOptions,
  type AppMergeCommandOptions,
  type AppPreviewDeleteOptions,
  type AppPublishOptions,
  type AppPullOptions,
  type AppPushOptions,
  type AppWriteOptions,
} from '../lib/appHeadless.js';
import type { BusinessObject } from '../lib/businessApps.js';
import {
  credentialArgs,
  warningLines,
  success,
  type CommandAccount,
  type CommandChoice,
  type WriteGateFlags,
} from '../lib/commandCore.js';
import type { KizenClient } from '../lib/kizenTypes.js';
import { quoteArg } from '../lib/shellArg.js';
import {
  addNotices,
  createSessionStep,
  DRY_RUN_TITLE,
  forPerson,
  writeDecision,
  type EnvironmentSelectPhase,
  type Session,
  type SessionPhase,
  type Setter,
} from './commandSession.js';

/**
 * The interactive `appbuilder app …` flow behind AppUI, free of ink so it can be tested without a
 * TTY. It drives the same appFlow steps as the headless runners and says what they say (the
 * appHeadless formatters); the differences are that it asks before writing, and answers a
 * decision (`base_required`, `publish_conflict`, a merge fallback) with a picker that runs the
 * chosen step here rather than printing a command.
 */

/** One `appbuilder app` subcommand and its parsed options. */
export type AppRequest =
  | { command: 'versions'; options: AppCommandOptions }
  | { command: 'push'; options: AppPushOptions }
  | { command: 'publish'; options: AppPublishOptions }
  | { command: 'merge'; options: AppMergeCommandOptions }
  | { command: 'rollback'; version: string; options: AppWriteOptions }
  | { command: 'pull'; version: string; options: AppPullOptions }
  | { command: 'actions list'; options: AppCommandOptions }
  /** Without `action` or `object`, the flow picks them (and the menu setting). */
  | { command: 'actions link'; action?: string; object?: string; options: AppActionsLinkOptions }
  | { command: 'actions unlink'; action?: string; object?: string; options: AppWriteOptions }
  | { command: 'preview delete'; options: AppPreviewDeleteOptions };

/** A finished step's screen. */
export interface AppOutcome {
  title: string;
  /** `success`: a ✓ line; `warning`: the step stopped short (a dry run, conflicts, a fallback). */
  tone: 'success' | 'warning';
  lines: string[];
  warnings: string[];
  /** The command to run next, as text, when the lines don't already say it. */
  next: string | null;
}

export interface ConfirmPhase {
  type: 'confirm';
  lines: string[];
  warnings: string[];
  /** Production (go/fmo) gets the PRODUCTION banner and the strict prompt. */
  isProduction: boolean;
  /** The strict prompt (`productionPrompt`, only `y` accepts) off production too. */
  strict?: boolean;
  prompt: string;
  productionPrompt: string;
  apply: () => Promise<void>;
}

export interface ReportPhase {
  type: 'report';
  lines: string[];
  warnings: string[];
}

export interface DonePhase {
  type: 'done';
  outcome: AppOutcome;
}

/** A final screen: a read-only report, or a finished step. */
export type FinalPhase = ReportPhase | DonePhase;

export interface ChoosePhase {
  type: 'choose';
  title: string;
  /** Shown above the choices; empty for none. */
  message: string;
  lines: string[];
  choices: CommandChoice[];
  run: (choice: CommandChoice) => Promise<void>;
  /** What Esc ends on: this final screen (exit 0), or null to cancel (exit 1). */
  dismissed: FinalPhase | null;
  /** A finished step's screen, shown above a picker of what to do next. */
  above?: FinalPhase;
  /** The choice (by value) the cursor starts on. */
  initial?: string;
  /** Typing filters the choices. */
  searchable?: boolean;
}

export type AppPhase =
  | SessionPhase<AppCommandOptions>
  | ReportPhase
  | ConfirmPhase
  | ChoosePhase
  | DonePhase;

export interface AppFlow {
  start: () => void;
  pickEnvironment: (
    phase: EnvironmentSelectPhase<AppCommandOptions>,
    choice: CommandChoice,
  ) => void;
  accept: (phase: ConfirmPhase) => void;
  choose: (phase: ChoosePhase, choice: CommandChoice) => void;
  /** Esc on a picker. */
  dismiss: (phase: ChoosePhase) => void;
  cancel: () => void;
  /** Ctrl+C: no further phase or write (`SessionStep.abort`). */
  abort: () => void;
}

/** Final phases: the UI exits on these. */
export const isFinalAppPhase = (phase: AppPhase): boolean =>
  phase.type === 'done' || phase.type === 'report' || phase.type === 'error';

interface Signed {
  credentials: CommandAccount;
  client: KizenClient;
}

type WriteFlags = Required<WriteGateFlags> & { force: boolean };

function writeFlagsOf(request: AppRequest): WriteFlags {
  const none: WriteFlags = { dryRun: false, yes: false, allowProduction: false, force: false };

  switch (request.command) {
    case 'versions':
    case 'pull':
    case 'actions list':
      return none;
    case 'merge':
      return {
        ...none,
        dryRun: request.options.dryRun === true,
        yes: request.options.yes === true,
      };
    case 'push':
    case 'publish':
      return {
        dryRun: request.options.dryRun === true,
        yes: request.options.yes === true,
        allowProduction: request.options.allowProduction === true,
        force: request.options.force === true,
      };
    case 'rollback':
    case 'actions link':
    case 'actions unlink':
    case 'preview delete':
      return {
        ...none,
        dryRun: request.options.dryRun === true,
        yes: request.options.yes === true,
        allowProduction: request.options.allowProduction === true,
      };
  }
}

/** How a push takes its base: `--base-from-preview`, or (empty) as it resolves on its own. */
type PushBaseOptions = Pick<ResolveFolderBaseOptions, 'baseFromPreview'>;

/** A write a picked "link JS actions now" makes: never a dry run, and always asked first. */
const ASK_FIRST: Required<WriteGateFlags> = { dryRun: false, yes: false, allowProduction: false };

/** A picker choice as the step it runs here: the command its `argv` prints, minus the shell. */
export type ChoiceStep =
  /** `baseFromPreview`: the push takes your preview's base (`--base-from-preview <id>`). */
  | { command: 'push'; baseFromPreview?: string }
  | { command: 'merge'; options: AppMergeOptions }
  | { command: 'actions link' };

export function choiceStep(choice: CommandChoice): ChoiceStep | null {
  const argv = choice.argv ?? [];

  if (argv[0] !== 'appbuilder' || argv[1] !== 'app') {
    return null;
  }

  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);

    return index === -1 ? undefined : argv[index + 1];
  };

  const release = value('--release');
  const base = value('--base');

  if (argv[2] === 'push') {
    const baseFromPreview = value('--base-from-preview');

    return { command: 'push', ...(baseFromPreview !== undefined && { baseFromPreview }) };
  }

  if (argv[2] === 'actions' && argv[3] === 'link' && argv.length === 4) {
    return { command: 'actions link' };
  }

  if (argv[2] === 'merge') {
    return {
      command: 'merge',
      options: {
        ...(release !== undefined && { version: release }),
        ...(base !== undefined && { base }),
        ...(argv.includes('--accept-live-base') && { acceptLiveBase: true }),
      },
    };
  }

  return null;
}

/**
 * A step's message for a person at the terminal: without the advice to pass --force, which is
 * for an agent relaying the user's explicit wish. The picker never offers --force; the user passes
 * it on the command line.
 */
export const withoutForceAdvice = (message: string): string =>
  message.replace(/ Only if the user explicitly wants[^:]*: pass --force\./g, '');

const EXIT_CHOICE: CommandChoice = { value: 'exit', label: 'Exit without publishing', args: [] };

/** `publish_conflict`'s way on: merge Live into this folder (shown before it writes). */
const MERGE_LIVE_CHOICE: CommandChoice = {
  value: 'merge',
  label: 'Merge Live into this folder',
  args: [],
  argv: ['appbuilder', 'app', 'merge'],
};

/** `publish_conflict` with an unknown base: push this folder (shown before it writes), then publish. */
const PUSH_FOLDER_CHOICE: CommandChoice = {
  value: 'push',
  label: 'Push this folder as your preview',
  args: [],
  argv: ['appbuilder', 'app', 'push'],
};

/** After a step whose JS action check found actions that may need linking: link them here. */
const LINK_ACTIONS_CHOICE: CommandChoice = {
  value: 'link-actions',
  label: 'Link JS actions now',
  args: [],
  argv: ['appbuilder', 'app', 'actions', 'link'],
};

const FINISH_CHOICE: CommandChoice = { value: 'finish', label: 'Done', args: [] };

/** A picker's choice per object, by id; the label tells apart objects with one display name. */
const objectChoice = (object: BusinessObject): CommandChoice => ({
  value: object.id,
  label: `${object.objectName} (${object.name})`,
  args: [],
});

const ACTION_STATUS_TEXT = {
  linked: 'linked',
  unlinked: 'not linked',
  unknown: "not in Live, links can't be listed",
} as const;

const actionChoice = (action: JsActionInfo): CommandChoice => ({
  value: action.apiName,
  label: `${action.apiName} (${action.name}): ${ACTION_STATUS_TEXT[action.status]}`,
  args: [],
});

/**
 * The objects `arg` may name: every object when it's left out, the one it names, or (when several
 * match) those, for a picker. `not_found` when it names none.
 */
function objectCandidates(
  objects: readonly BusinessObject[],
  arg: string | undefined,
): AppStep<BusinessObject[]> {
  if (arg === undefined) {
    return success([...objects]);
  }

  const resolved = resolveObject(objects, arg, () => []);

  if (resolved.ok) {
    return success([resolved.value]);
  }

  if (resolved.code === 'needs_choice') {
    const ids = new Set((resolved.choices ?? []).map((choice) => choice.value));

    return success(objects.filter((object) => ids.has(object.id)));
  }

  return resolved;
}

/** `actions link` / `unlink`'s arguments; a missing one is picked. */
interface ActionArgs {
  action?: string;
  object?: string;
}

const MERGE_MARKER_NOTE = (label: string): string =>
  `Conflicted files get git conflict markers: <<<<<<< HEAD is your file and >>>>>>> live is ${label}.`;

/** The interactive app flow; exported for tests. */
export function createAppFlow(
  request: AppRequest,
  deps: AppDeps,
  showPhase: Setter<AppPhase>,
  showSession: Setter<Session>,
): AppFlow {
  const flags = writeFlagsOf(request);
  // `--expect-preview`: publish only the preview a dry run reviewed.
  const expectPreview = request.command === 'publish' ? request.options.expectPreview : undefined;
  let signed: Signed | null = null;

  const session = createSessionStep<AppCommandOptions>({
    deps,
    setPhase: showPhase,
    setSession: showSession,
    toView: appFailure,
    // `not_signed_in` names the login command to run, not an agent's instructions.
    present: forPerson,
    next: async (_options, resolved) => {
      signed = { credentials: resolved.credentials, client: resolved.client };
      await begin(signed);
    },
  });

  const { fail } = session;
  // After Ctrl+C the flow shows nothing more, and `writable` stops every write before it starts.
  const setPhase = session.whileRunning(showPhase);
  const setSession = session.whileRunning(showSession);
  const writable = (): boolean => !session.isAborted();
  // The same check inside each apply, right before its server or file write.
  const control: ApplyControl = { isAborted: session.isAborted };

  const notice = (lines: readonly string[]): void => {
    setSession(addNotices(lines));
  };

  const loading = (label: string): void => {
    setPhase({ type: 'loading', label });
  };

  const done = (outcome: AppOutcome): void => {
    setPhase({ type: 'done', outcome });
  };

  /**
   * Ends a step on `screen`. When its JS action check found actions that may need linking (as
   * headless puts them in `next`), offers linking them here first; Esc or "Done" ends on `screen`.
   */
  const finish = (context: AppContext, screen: FinalPhase, check: JsActionsCheck): void => {
    if (jsActionsNextArgs(check).length === 0) {
      setPhase(screen);

      return;
    }

    setPhase({
      type: 'choose',
      title: 'What next?',
      message: '',
      lines: [],
      above: screen,
      choices: [LINK_ACTIONS_CHOICE, FINISH_CHOICE],
      run: async (choice) => {
        if (choice.value === FINISH_CHOICE.value) {
          setPhase(screen);

          return;
        }

        await runChoice(context, choice, null);
      },
      dismissed: screen,
    });
  };

  const cancel = (): void => {
    fail({ message: 'Cancelled.' });
  };

  /** `appbuilder app <args>` with the flags this run was given, for a "next" hint. */
  const nextCommand = (args: string[]): string =>
    ['appbuilder', 'app', ...args, ...credentialArgs(request.options, deps.processEnv)]
      .map(quoteArg)
      .join(' ');

  const open = async (account: Signed, baseApiName: string): Promise<AppContext | null> => {
    const step = await loadAppContext({ ...account, baseApiName }, deps);

    if (!step.ok) {
      fail(step);

      return null;
    }

    notice(step.value.notices);

    return step.value;
  };

  /** The app again after a step changed it or this folder's state (its notices already shown). */
  const reload = async (context: AppContext): Promise<AppContext | null> => {
    if (signed === null) {
      return null;
    }

    loading('Loading the app…');

    const step = await loadAppContext({ ...signed, baseApiName: context.baseApiName }, deps);

    if (!step.ok) {
      fail(step);

      return null;
    }

    return step.value;
  };

  /** Shows a planned write and asks (or applies, or stops at a dry run), as `writeDecision` says. */
  const write = async (
    context: AppContext,
    view: Omit<ConfirmPhase, 'type' | 'apply'>,
    writeFlags: WriteGateFlags,
    apply: () => Promise<void>,
  ): Promise<void> => {
    switch (writeDecision(writeFlags, context.credentials.environment)) {
      case 'dry-run':
        done({
          title: DRY_RUN_TITLE,
          tone: 'warning',
          lines: view.lines,
          warnings: view.warnings,
          next: null,
        });

        return;
      case 'apply':
        await apply();

        return;
      case 'confirm':
        setPhase({ type: 'confirm', ...view, apply });
    }
  };

  // -------------------------------------------------------------------------------------------
  // decisions: a picker whose choices run here

  /**
   * A decision a step stopped for: `base_required` offers its choices, `publish_conflict` offers
   * merging Live (never --force). `resume` re-runs the command that stopped, once an accept (or a
   * push from a publish) has answered it. A push that stopped passes `afterPush`: a picked push
   * (continuing your preview) is that push, so what follows it is what followed the push.
   */
  const stopped = (
    context: AppContext,
    failure: AppFailure,
    resume: () => Promise<void>,
    afterPush?: (() => Promise<void>) | null,
  ): void => {
    if (failure.code === 'base_required' && failure.choices && failure.choices.length > 0) {
      setPhase({
        type: 'choose',
        title: 'Choose how to go on',
        message: withoutForceAdvice(failure.message),
        lines: [],
        choices: failure.choices,
        run: (choice) => runChoice(context, choice, resume, afterPush),
        dismissed: null,
      });

      return;
    }

    // A preview pushed again since this publish was planned: nothing to merge; say so and stop.
    if (failure.code === 'publish_conflict' && failure.conflict?.reason !== 'preview_replaced') {
      const { message } = failure;
      // A preview whose base is unknown is answered by pushing this folder, then publishing.
      const unknown = failure.conflict?.reason === 'base_unknown';

      setPhase({
        type: 'choose',
        title: 'What next?',
        message: withoutForceAdvice(message),
        lines: [],
        choices: [unknown ? PUSH_FOLDER_CHOICE : MERGE_LIVE_CHOICE, EXIT_CHOICE],
        run: async (choice) => {
          if (choice.value === EXIT_CHOICE.value) {
            fail({ message });

            return;
          }

          await runChoice(context, choice, unknown ? resume : null);
        },
        dismissed: null,
      });

      return;
    }

    fail(failure);
  };

  /**
   * Runs a picked choice's step. An accept (or a push) then resumes the command that stopped; a
   * push picked where a push stopped is followed by `afterPush` instead.
   */
  const runChoice = async (
    context: AppContext,
    choice: CommandChoice,
    resume: (() => Promise<void>) | null,
    afterPush?: (() => Promise<void>) | null,
  ): Promise<void> => {
    const step = choiceStep(choice);

    if (step === null) {
      fail({ message: `Can't run "${choice.label}" here.` });

      return;
    }

    // The app as it is now: a conflict found just before publishing means Live moved since the
    // context was loaded, and a merge of "Live" must merge that one.
    const fresh = await reload(context);

    if (fresh === null) {
      return;
    }

    if (step.command === 'push') {
      await pushFolder(
        fresh,
        afterPush === undefined ? resume : afterPush,
        step.baseFromPreview === undefined ? {} : { baseFromPreview: step.baseFromPreview },
      );

      return;
    }

    if (step.command === 'actions link') {
      await linkAction(fresh, {}, ASK_FIRST);

      return;
    }

    // Picking "already contains" is the go-ahead for recording it; a merge still shows its plan.
    await merge(fresh, step.options, step.options.acceptLiveBase === true ? resume : null);
  };

  // -------------------------------------------------------------------------------------------
  // push

  const push = async (
    context: AppContext,
    prepared: PreparedPush,
    then: (() => Promise<void>) | null,
    base: PushBaseOptions,
  ): Promise<void> => {
    if (!writable()) {
      return;
    }

    loading('Checking the push…');

    const planned = await planPush(context, prepared, { force: flags.force, ...base }, deps);

    if (!planned.ok) {
      stopped(
        context,
        planned,
        async () => {
          const fresh = await reload(context);

          if (fresh !== null) {
            await push(fresh, prepared, then, {});
          }
        },
        then,
      );

      return;
    }

    const plan = planned.value;
    const templates = jsActionTemplatesOf(prepared.deployable.artifacts.js_action_templates);
    // Push leaves Live alone, so the actions are checked against the app as it is.
    const check = await checkJsActions(context, { kind: 'version', templates });
    const lines = [...formatPushPlanLines(plan), ...formatJsActionsLines(check)];
    const planWarnings = [...plan.warnings, ...jsActionsWarnings(check)];

    notice([...plan.notices, ...jsActionsNotices(check)]);

    await write(
      context,
      {
        lines,
        warnings: planWarnings,
        isProduction: plan.summary.isProduction,
        prompt: 'Push? (Y/n)',
        productionPrompt: 'Type y to push to production (y/N)',
      },
      flags,
      async () => {
        if (!writable()) {
          return;
        }

        loading(`Saving your preview of ${plan.appName}…`);

        const applied = await applyPush(context, prepared, plan, deps, control);

        if (!applied.ok) {
          fail(applied);

          return;
        }

        const title = pushedLine(plan.appName, applied.value);

        if (then !== null) {
          notice([title, ...warningLines([...planWarnings, ...applied.value.warnings])]);
          await then();

          return;
        }

        loading('Checking the JS actions…');

        // Checked against the app as the push left it: a first push installs it.
        const pushedCheck = await checkPushedJsActions(context, templates);

        notice(jsActionsNotices(pushedCheck));
        finish(
          context,
          {
            type: 'done',
            outcome: {
              title,
              tone: 'success',
              lines: [...formatPushPlanLines(plan), ...formatJsActionsLines(pushedCheck)],
              warnings: [
                ...plan.warnings,
                ...jsActionsWarnings(pushedCheck),
                ...applied.value.warnings,
              ],
              next: nextCommand(['publish']),
            },
          },
          pushedCheck,
        );
      },
    );
  };

  /** Packages this folder, then plans its push into `context`'s app. */
  const pushFolder = async (
    context: AppContext | Signed,
    then: (() => Promise<void>) | null,
    base: PushBaseOptions,
  ): Promise<void> => {
    if (!writable()) {
      return;
    }

    loading('Packaging the app…');

    const prepared = await preparePush(deps);

    if (!prepared.ok) {
      fail(prepared);

      return;
    }

    const { issues, source, deployable } = prepared.value;

    setSession((current) => ({ ...current, warnings: issues }));
    notice(source.notice === undefined ? [] : [source.notice]);

    const target = 'api' in context ? context : await open(context, deployable.api_name);

    if (target !== null) {
      await push(target, prepared.value, then, base);
    }
  };

  // -------------------------------------------------------------------------------------------
  // publish

  const publish = async (context: AppContext): Promise<void> => {
    if (!writable()) {
      return;
    }

    loading('Checking for conflicts…');

    const resume = async (): Promise<void> => {
      const fresh = await reload(context);

      if (fresh !== null) {
        await publish(fresh);
      }
    };

    const planned = await planPublish(
      context,
      { force: flags.force, ...(expectPreview !== undefined && { expectPreview }) },
      deps,
    );

    if (!planned.ok) {
      stopped(context, planned, resume);

      return;
    }

    const plan = planned.value;
    const lines = formatPublishPlanLines(plan);
    // The preview's actions, against the current Live version's links.
    const previewCheck = await checkJsActions(context, {
      kind: 'version',
      templates: jsActionTemplatesOf(plan.jsActionTemplates),
    });

    notice(jsActionsNotices(previewCheck));

    await write(
      context,
      {
        lines: [...lines, nextReleaseLine(plan), ...formatJsActionsLines(previewCheck)],
        warnings: [...plan.warnings, ...jsActionsWarnings(previewCheck)],
        isProduction: plan.summary.isProduction,
        prompt: 'Publish? (Y/n)',
        productionPrompt: 'Type y to publish to production (y/N)',
      },
      flags,
      async () => {
        if (!writable()) {
          return;
        }

        loading('Publishing…');

        const applied = await applyPublish(context, plan, deps, control);

        if (!applied.ok) {
          // Live moved, or the preview was replaced, since the plan: the same decision again.
          stopped(context, applied, resume);

          return;
        }

        // What was published is Live now, so every one of its actions' links can be listed.
        const check = await checkJsActions(context, {
          kind: 'live',
          version: applied.value.liveVersion,
        });

        notice(jsActionsNotices(check));
        finish(
          context,
          {
            type: 'done',
            outcome: {
              title: publishedLine(plan, applied.value),
              tone: 'success',
              lines: [...lines, ...formatJsActionsLines(check)],
              warnings: [...plan.warnings, ...applied.value.warnings, ...jsActionsWarnings(check)],
              next: null,
            },
          },
          check,
        );
      },
    );
  };

  // -------------------------------------------------------------------------------------------
  // merge

  const merge = async (
    context: AppContext,
    options: AppMergeOptions,
    then: (() => Promise<void>) | null,
  ): Promise<void> => {
    if (!writable()) {
      return;
    }

    loading('Planning the merge…');

    const planned = await planAppMerge(context, options, deps);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const label = targetLabel(plan.targetVersion, plan.targetIsLive);
    const marked = plan.kind === 'merge' && plan.plan.conflicted.length > 0;

    notice(plan.notices);

    const apply = async (): Promise<void> => {
      if (!writable()) {
        return;
      }

      loading(
        plan.kind === 'fallback'
          ? `Extracting ${label}…`
          : plan.kind === 'merge'
            ? 'Merging…'
            : 'Recording the base…',
      );

      const applied = await applyAppMerge(context, plan, deps, control);

      if (!applied.ok) {
        fail(applied);

        return;
      }

      const result = applied.value;
      const [title = '', ...rest] = formatMergeOutcomeLines(plan, result);
      const warnings = [...plan.warnings, ...result.warnings];
      const recorded = result.status === 'accepted' || result.status === 'up_to_date';

      if (then !== null && recorded) {
        notice([title, ...warningLines(warnings)]);
        await then();

        return;
      }

      const outcome: AppOutcome = {
        title,
        tone: result.status === 'conflicts' || result.status === 'fallback' ? 'warning' : 'success',
        lines: rest,
        warnings,
        next: result.status === 'accepted' ? nextCommand(['push']) : null,
      };

      if (result.status === 'fallback' && plan.kind === 'fallback') {
        // Merged by hand, or from the release this folder was copied from: picked here; Esc
        // leaves it extracted.
        setPhase({
          type: 'choose',
          title: 'Choose how to go on',
          message: FALLBACK_INSTRUCTIONS,
          lines: [title, ...rest],
          choices: plan.choices,
          run: (choice) => runChoice(context, choice, null),
          dismissed: { type: 'done', outcome },
        });

        return;
      }

      done(outcome);
    };

    // Nothing to write: say so without asking.
    if (plan.kind === 'up_to_date' && !plan.advancesBase) {
      await apply();

      return;
    }

    await write(
      context,
      {
        lines: [
          ...formatAppSummaryLines(plan.summary),
          ...formatMergePlanLines(plan),
          ...(marked ? [MERGE_MARKER_NOTE(label)] : []),
        ],
        warnings: plan.warnings,
        // Only local files change.
        isProduction: false,
        prompt:
          plan.kind === 'merge'
            ? 'Merge? (Y/n)'
            : plan.kind === 'fallback'
              ? 'Extract it? (Y/n)'
              : 'Record it? (Y/n)',
        productionPrompt: '',
      },
      // A picked accept was the go-ahead; production needs no flag for local files.
      {
        dryRun: flags.dryRun,
        yes: flags.yes || (then !== null && plan.kind === 'accept'),
        allowProduction: true,
      },
      apply,
    );
  };

  // -------------------------------------------------------------------------------------------
  // rollback, pull, versions

  const rollback = async (context: AppContext, version: string): Promise<void> => {
    if (!writable()) {
      return;
    }

    loading(`Preparing v${version}…`);

    const planned = await planRollback(context, version, deps);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const lines = formatRollbackPlanLines(plan);

    await write(
      context,
      {
        lines,
        warnings: plan.warnings,
        isProduction: plan.summary.isProduction,
        prompt: 'Restore it? (Y/n)',
        productionPrompt: 'Type y to restore it on production (y/N)',
      },
      flags,
      async () => {
        if (!writable()) {
          return;
        }

        loading(`Restoring v${plan.version}…`);

        const applied = await applyRollback(context, plan, deps, control);

        if (!applied.ok) {
          fail(applied);

          return;
        }

        done({
          title: rolledBackLine(plan),
          tone: 'success',
          lines,
          warnings: [...plan.warnings, ...applied.value.warnings],
          next: nextCommand(['publish']),
        });
      },
    );
  };

  /** Writes only into a new folder, so it doesn't ask. */
  const pull = async (context: AppContext, version: string, out?: string): Promise<void> => {
    if (!writable()) {
      return;
    }

    loading(`Downloading v${version}…`);

    const planned = await planPull(context, version, out === undefined ? {} : { out }, deps);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;

    if (!writable()) {
      return;
    }

    const applied = await applyPull(context, plan, deps, control);

    if (!applied.ok) {
      fail(applied);

      return;
    }

    const [title = '', ...lines] = formatPullLines(plan, applied.value);

    done({
      title,
      tone: 'success',
      lines,
      warnings: [...plan.warnings, ...applied.value.warnings],
      next: null,
    });
  };

  // -------------------------------------------------------------------------------------------
  // actions

  const listActions = async (context: AppContext): Promise<void> => {
    loading('Reading the JS actions…');

    const planned = await planActionsList(context);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const { summary, check } = planned.value;

    setPhase({
      type: 'report',
      lines: formatActionsListLines(summary, check),
      warnings: jsActionsWarnings(check),
    });
  };

  /** The app's actions and the objects, read once for the pickers and the plan. */
  const readChoices = async (context: AppContext): Promise<ActionChoices | null> => {
    loading('Reading the JS actions…');

    const read = await readActionChoices(context);

    if (!read.ok) {
      fail(read);

      return null;
    }

    return read.value;
  };

  /** A picker whose Esc cancels. */
  const pickOne = (
    view: Pick<ChoosePhase, 'title' | 'choices'> & { initial?: string; searchable?: boolean },
    run: (choice: CommandChoice) => Promise<void>,
  ): void => {
    setPhase({ type: 'choose', message: '', lines: [], ...view, run, dismissed: null });
  };

  /** `then` with one of `candidates`: the only one when `named` (an argument named it), else picked. */
  const withObject = async (
    action: JsActionInfo,
    candidates: BusinessObject[],
    named: boolean,
    then: (object: BusinessObject) => Promise<void>,
  ): Promise<void> => {
    const [only] = candidates;

    if (named && only !== undefined && candidates.length === 1) {
      await then(only);

      return;
    }

    if (only === undefined) {
      fail({ message: "There's no object on this business that you can see." });

      return;
    }

    // The action's hint object starts highlighted.
    const hint =
      action.hintObjectName === null
        ? null
        : resolveObject(candidates, action.hintObjectName, () => []);

    pickOne(
      {
        title: `Object for ${action.apiName}`,
        choices: candidates.map(objectChoice),
        ...(hint?.ok === true && { initial: hint.value.id }),
        searchable: true,
      },
      async (choice) => {
        const object = candidates.find((candidate) => candidate.id === choice.value);

        if (object !== undefined) {
          await then(object);
        }
      },
    );
  };

  /**
   * Links an action to an object. Without `action` or `object` it picks them, then the menu
   * setting (unless `menu` says it); with both, it plans what they name, as headless does.
   */
  const linkAction = async (
    context: AppContext,
    args: ActionArgs & { menu?: boolean },
    writeFlags: WriteGateFlags,
  ): Promise<void> => {
    if (!writable()) {
      return;
    }

    const choices = await readChoices(context);

    if (choices === null) {
      return;
    }

    const candidates = objectCandidates(choices.objects, args.object);

    if (!candidates.ok) {
      fail(candidates);

      return;
    }

    const picking = args.action === undefined || args.object === undefined;

    const plan = async (action: JsActionInfo, object: BusinessObject): Promise<void> => {
      if (args.menu !== undefined || !picking) {
        await planLink(context, choices, action, object, args.menu, writeFlags);

        return;
      }

      const listed = action.links.find((link) => link.objectId === object.id);

      pickOne(
        {
          title: `Show ${action.apiName} in the Perform Action menus of ${object.objectName}?`,
          choices: [
            { value: 'no', label: 'No', args: [] },
            { value: 'yes', label: 'Yes', args: [] },
          ],
          initial: listed?.includePerformAction === true ? 'yes' : 'no',
        },
        (choice) => planLink(context, choices, action, object, choice.value === 'yes', writeFlags),
      );
    };

    const withAction = (action: JsActionInfo): Promise<void> =>
      withObject(action, candidates.value, args.object !== undefined, (object) =>
        plan(action, object),
      );

    if (args.action !== undefined) {
      const found = findAction(context, choices, args.action);

      if (!found.ok) {
        fail(found);

        return;
      }

      await withAction(found.value);

      return;
    }

    const { actions } = choices.check;

    if (actions.length === 0) {
      fail({ message: `${context.baseApiName} has no JS actions to link.` });

      return;
    }

    // The first one that may need linking starts highlighted.
    const pending = actions.find((action) => action.status !== 'linked');

    pickOne(
      {
        title: 'JS action to link',
        choices: actions.map(actionChoice),
        ...(pending !== undefined && { initial: pending.apiName }),
        searchable: true,
      },
      async (choice) => {
        const action = actions.find((candidate) => candidate.apiName === choice.value);

        if (action !== undefined) {
          await withAction(action);
        }
      },
    );
  };

  const planLink = async (
    context: AppContext,
    choices: ActionChoices,
    action: JsActionInfo,
    object: BusinessObject,
    menu: boolean | undefined,
    writeFlags: WriteGateFlags,
  ): Promise<void> => {
    if (!writable()) {
      return;
    }

    const plan = actionLinkPlanOf(context, choices, action, object, {
      ...(menu !== undefined && { menu }),
    });
    const lines = [...formatAppSummaryLines(plan.summary), ...formatActionLinkPlanLines(plan)];

    notice(plan.notices);

    // Nothing to write, so nothing to ask.
    if (plan.change === 'up_to_date') {
      done({ title: 'Nothing to change.', tone: 'success', lines, warnings: [], next: null });

      return;
    }

    const creating = plan.change === 'create';

    await write(
      context,
      {
        lines,
        warnings: plan.warnings,
        isProduction: plan.summary.isProduction,
        prompt: creating ? 'Link it? (Y/n)' : 'Change it? (Y/n)',
        productionPrompt: creating
          ? 'Type y to link it on production (y/N)'
          : 'Type y to change it on production (y/N)',
      },
      writeFlags,
      async () => {
        if (!writable()) {
          return;
        }

        loading(creating ? 'Linking…' : 'Changing the link…');

        const applied = await applyActionLink(context, plan, control);

        if (!applied.ok) {
          fail(applied);

          return;
        }

        done({
          title: actionLinkedLine(plan, applied.value.status),
          tone: applied.value.status === 'already_linked' ? 'warning' : 'success',
          lines,
          // Nothing changed when the server already had the link: no Live warning then.
          warnings: [
            ...(applied.value.status === 'already_linked' ? [] : plan.warnings),
            ...applied.value.warnings,
          ],
          next: nextCommand(['actions', 'list']),
        });
      },
    );
  };

  /**
   * Removes a link. Without `action` or `object` it picks one of the listed links (of `action`,
   * or to `object`, when one is given); with both, it plans what they name, as headless does.
   */
  const unlinkAction = async (
    context: AppContext,
    args: ActionArgs,
    writeFlags: WriteGateFlags,
  ): Promise<void> => {
    if (!writable()) {
      return;
    }

    const choices = await readChoices(context);

    if (choices === null) {
      return;
    }

    const candidates = objectCandidates(choices.objects, args.object);

    if (!candidates.ok) {
      fail(candidates);

      return;
    }

    const named = args.action === undefined ? null : findAction(context, choices, args.action);

    if (named !== null && !named.ok) {
      fail(named);

      return;
    }

    if (named !== null && args.object !== undefined) {
      await withObject(named.value, candidates.value, true, (object) =>
        planUnlink(context, choices, named.value, object, writeFlags),
      );

      return;
    }

    const ids = new Set(candidates.value.map((object) => object.id));
    const links = (named === null ? choices.check.actions : [named.value]).flatMap((action) =>
      action.links.filter((link) => ids.has(link.objectId)).map((link) => ({ action, link })),
    );

    if (links.length === 0) {
      fail(
        named === null
          ? { message: `${context.baseApiName} has no listed JS action links to remove.` }
          : {
              message: `${named.value.apiName} isn't linked to any object.`,
              ...(!named.value.inLive && { hint: UNLISTED_UNLINK_HINT(named.value.apiName) }),
            },
      );

      return;
    }

    pickOne(
      {
        title: 'Link to remove',
        choices: links.map(({ action, link }) => ({
          value: link.id,
          label: `${action.apiName} → ${link.label} (${link.objectName})`,
          args: [],
        })),
        searchable: true,
      },
      async (choice) => {
        const picked = links.find(({ link }) => link.id === choice.value);

        if (picked === undefined) {
          return;
        }

        const { action, link } = picked;
        // An object the user can't list any more is still the one the link names.
        const object = choices.objects.find((candidate) => candidate.id === link.objectId) ?? {
          id: link.objectId,
          name: link.objectName,
          objectName: link.label,
          entityName: null,
        };

        await planUnlink(context, choices, action, object, writeFlags);
      },
    );
  };

  const planUnlink = async (
    context: AppContext,
    choices: ActionChoices,
    action: JsActionInfo,
    object: BusinessObject,
    writeFlags: WriteGateFlags,
  ): Promise<void> => {
    if (!writable()) {
      return;
    }

    const planned = actionUnlinkPlanOf(context, choices, action, object);

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const lines = [...formatAppSummaryLines(plan.summary), ...formatActionUnlinkPlanLines(plan)];

    await write(
      context,
      {
        lines,
        warnings: plan.warnings,
        isProduction: plan.summary.isProduction,
        prompt: 'Unlink it? (Y/n)',
        productionPrompt: 'Type y to unlink it on production (y/N)',
      },
      writeFlags,
      async () => {
        if (!writable()) {
          return;
        }

        loading('Unlinking…');

        const applied = await applyActionUnlink(context, plan, control);

        if (!applied.ok) {
          fail(applied);

          return;
        }

        done({
          title: actionUnlinkedLine(plan),
          tone: 'success',
          lines,
          warnings: plan.warnings,
          next: nextCommand(['actions', 'list']),
        });
      },
    );
  };

  // -------------------------------------------------------------------------------------------
  // preview

  /** Deletes your preview, or `owner`'s, after showing what that does. */
  const deletePreview = async (
    context: AppContext,
    options: AppPreviewDeleteOptions,
  ): Promise<void> => {
    if (!writable()) {
      return;
    }

    const planned = planPreviewDelete(context, {
      ...(options.owner !== undefined && { owner: options.owner }),
      ...(options.expectUpdated !== undefined && { expectUpdated: options.expectUpdated }),
    });

    if (!planned.ok) {
      fail(planned);

      return;
    }

    const plan = planned.value;
    const lines = formatPreviewDeletePlanLines(plan);

    await write(
      context,
      {
        lines,
        warnings: plan.warnings,
        isProduction: plan.summary.isProduction,
        // Deleting a whole app takes a typed y everywhere, so Enter by habit can't do it.
        strict: plan.deletesApp,
        prompt: 'Delete it? (Y/n)',
        productionPrompt: plan.deletesApp
          ? `Type y to delete the preview and the whole app${plan.summary.isProduction ? ' on production' : ''} (y/N)`
          : 'Type y to delete it on production (y/N)',
      },
      // --yes doesn't cover deleting the whole app: that's asked, unless --delete-app said it.
      plan.deletesApp && options.deleteApp !== true ? { ...flags, yes: false } : flags,
      async () => {
        if (!writable()) {
          return;
        }

        loading('Deleting the preview…');

        const applied = await applyPreviewDelete(context, plan, deps, control);

        if (!applied.ok) {
          fail(applied);

          return;
        }

        const [title = '', ...deleted] = previewDeletedLines(plan, applied.value);
        const outcome = deletedPreviewPlan(plan, applied.value);

        done({
          title,
          tone: 'success',
          lines: [...deleted, ...formatPreviewDeletePlanLines(outcome)],
          warnings: [...outcome.warnings, ...applied.value.warnings],
          // Your preview is gone: pushing this folder makes a new one.
          next: plan.owner.yours ? nextCommand(['push']) : null,
        });
      },
    );
  };

  const begin = async (account: Signed): Promise<void> => {
    if (request.command === 'push') {
      const { baseFromPreview } = request.options;

      await pushFolder(account, null, baseFromPreview === undefined ? {} : { baseFromPreview });

      return;
    }

    loading('Loading the app…');

    let baseApiName: string;

    try {
      baseApiName = await deps.readManifestApiName(deps.cwd);
    } catch (error) {
      fail(appFailure(error));

      return;
    }

    const context = await open(account, baseApiName);

    if (context === null) {
      return;
    }

    switch (request.command) {
      case 'versions': {
        const folderBase = await recordedFolderBase(context);

        if (!folderBase.ok) {
          fail(folderBase);

          return;
        }

        const report = describeVersions(context, folderBase.value);
        // Never fails versions: a failed check is a notice.
        const check = await checkJsActions(context, { kind: 'app' });

        notice(jsActionsNotices(check));
        finish(
          context,
          {
            type: 'report',
            lines: [...formatVersionsLines(report), ...formatJsActionsLines(check)],
            warnings: [...report.warnings, ...jsActionsWarnings(check)],
          },
          check,
        );

        return;
      }

      case 'publish':
        await publish(context);

        return;
      case 'merge':
        await merge(
          context,
          {
            ...(request.options.release !== undefined && { version: request.options.release }),
            ...(request.options.base !== undefined && { base: request.options.base }),
            ...(request.options.acceptLiveBase === true && { acceptLiveBase: true }),
          },
          null,
        );

        return;
      case 'rollback':
        await rollback(context, request.version);

        return;
      case 'pull':
        await pull(context, request.version, request.options.out);

        return;
      case 'actions list':
        await listActions(context);

        return;
      case 'actions link':
        await linkAction(
          context,
          {
            ...(request.action !== undefined && { action: request.action }),
            ...(request.object !== undefined && { object: request.object }),
            ...(request.options.menu !== undefined && { menu: request.options.menu }),
          },
          flags,
        );

        return;
      case 'actions unlink':
        await unlinkAction(
          context,
          {
            ...(request.action !== undefined && { action: request.action }),
            ...(request.object !== undefined && { object: request.object }),
          },
          flags,
        );

        return;
      case 'preview delete':
        await deletePreview(context, request.options);
    }
  };

  const { guard } = session;

  return {
    start: () => {
      guard(() => session.load(request.options));
    },
    pickEnvironment: (phase, choice) => {
      guard(() => session.pickEnvironment(phase, choice));
    },
    accept: (phase) => {
      guard(phase.apply);
    },
    choose: (phase, choice) => {
      guard(() => phase.run(choice));
    },
    dismiss: (phase) => {
      if (phase.dismissed === null) {
        cancel();
      } else {
        setPhase(phase.dismissed);
      }
    },
    cancel,
    abort: session.abort,
  };
}
