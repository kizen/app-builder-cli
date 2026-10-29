import { useEffect, useState, type FC, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { warningLines, type ResolvedCredentials } from '../lib/commandCore.js';
import { type Surface } from '../lib/kizenTypes.js';
import { surfaceToDashboardType } from '../lib/pushBlock.js';
import {
  applyPlan,
  buildBrowserRefresh,
  buildPlan,
  buildTargetChoices,
  formatSummaryLines,
  listPushableObjects,
  loadPushContext,
  matchContextTarget,
  resolveBlock,
  resolveTarget,
  toTargetRow,
  type AppliedPush,
  type PushChoice,
  type PushCommandOptions,
  type PushContext,
  type PushDeps,
  type PushPlan,
  type ResolvedBlock,
  type ResolvedTarget,
  type TargetCustomObject,
  type TargetRow,
} from '../lib/pushHeadless.js';
import { ChoiceList, pick } from './ChoiceList.js';
import {
  createSessionStep,
  DRY_RUN_TITLE,
  EMPTY_SESSION,
  LOADING_CREDENTIALS,
  writeDecision,
  type EnvironmentSelectPhase,
  type Session,
  type Setter,
} from './commandSession.js';
import { ConfirmPrompt, ProductionConfirm } from './ConfirmPrompt.js';
import { ErrorFrame, type ErrorView } from './ErrorFrame.js';
import { Lines } from './Lines.js';
import { SelectList, type SelectItem } from './SelectList.js';
import { SessionFrame, useCommandExit } from './SessionFrame.js';
import { Working } from './Working.js';

export interface PushUIProps {
  apiName?: string;
  options: PushCommandOptions;
  deps: PushDeps;
}

interface Resolving {
  options: PushCommandOptions;
  context: PushContext;
}

type Phase =
  | { type: 'loading'; label: string }
  | EnvironmentSelectPhase<PushCommandOptions>
  | { type: 'packaging' }
  | {
      type: 'block-select';
      options: PushCommandOptions;
      resolved: ResolvedCredentials;
      choices: PushChoice[];
    }
  | ({ type: 'surface-select' } & Resolving)
  | ({ type: 'object-select'; objects: TargetCustomObject[]; back: Phase } & Resolving)
  | ({
      type: 'dashboard-select';
      surface: Surface;
      objectId: string | null;
      title: string;
      rows: TargetRow[];
      back: Phase;
    } & Resolving)
  | ({
      type: 'target-select';
      dashboardId: string;
      title: string;
      message: string | null;
      choices: PushChoice[];
      matchedId: string | null;
      back: Phase | null;
    } & Resolving)
  | ({ type: 'confirm'; kind: 'drift'; message: string; target: ResolvedTarget } & Resolving)
  | ({ type: 'confirm'; kind: 'push'; plan: PushPlan } & Resolving)
  | { type: 'applying'; plan: PushPlan }
  | { type: 'done'; plan: PushPlan; applied: AppliedPush | null }
  | { type: 'error'; view: ErrorView };

const SURFACE_ITEMS: readonly (SelectItem & { key: Surface })[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'homepage', label: 'Homepage' },
  { key: 'chart_group', label: 'Chart group' },
];

const SURFACE_NOUNS: Record<Surface, string> = {
  dashboard: 'dashboard',
  homepage: 'homepage',
  chart_group: 'chart group',
};

const BACK_HINT = '↑/↓ to move, Enter to select, Esc to go back';

const DRIFT_WARNING =
  'The block was edited in Kizen since your last push. Overwriting discards those edits.';

const isCreateChoice = (choice: PushChoice): boolean => choice.args.includes('--create');

function orderTargetChoices(choices: PushChoice[], matchedId: string | null): PushChoice[] {
  const matched = choices.filter((choice) => choice.value === matchedId);
  const creates = choices.filter(isCreateChoice);
  const rest = choices.filter((choice) => choice.value !== matchedId && !isCreateChoice(choice));

  return matched.length > 0 ? [...matched, ...rest, ...creates] : [...creates, ...rest];
}

function targetItem(choice: PushChoice, matchedId: string | null): SelectItem {
  if (isCreateChoice(choice)) {
    return { key: choice.value, label: choice.label };
  }

  if (choice.value === matchedId) {
    return { key: choice.value, label: `Update "${choice.label}" (last pushed here)` };
  }

  const description = choice.isFromThisPlugin ? 'pushed from this plugin' : choice.pushKey;

  return {
    key: choice.value,
    label: `Update "${choice.label}"`,
    ...(description ? { description } : {}),
  };
}

function dashboardItem(row: TargetRow): SelectItem {
  const label =
    row.dashletsCount === null ? row.name : `${row.name} (${String(row.dashletsCount)} dashlets)`;

  if (row.canEdit === false) {
    return { key: row.id, label, description: 'no edit access', disabled: true };
  }

  const description = [row.employeeAccess, row.hidden ? 'hidden' : null]
    .filter((part) => part !== null && part !== '')
    .join(' · ');

  return { key: row.id, label, ...(description === '' ? {} : { description }) };
}

function withTarget(
  options: PushCommandOptions,
  dashboardId: string,
  choice: PushChoice,
): PushCommandOptions {
  const next: PushCommandOptions = { ...options, dashboard: dashboardId };

  delete next.dashlet;
  delete next.create;

  return isCreateChoice(choice) ? { ...next, create: true } : { ...next, dashlet: choice.value };
}

/** The push flow behind PushUI's phases; exported for tests. */
export function createPushFlow(
  apiName: string | undefined,
  deps: PushDeps,
  showPhase: Setter<Phase>,
  showSession: Setter<Session>,
): {
  start: (options: PushCommandOptions) => void;
  pickEnvironment: (
    phase: Extract<Phase, { type: 'environment-select' }>,
    choice: PushChoice,
  ) => void;
  pickBlock: (phase: Extract<Phase, { type: 'block-select' }>, choice: PushChoice) => void;
  pickSurface: (phase: Extract<Phase, { type: 'surface-select' }>, surface: Surface) => void;
  pickObject: (
    phase: Extract<Phase, { type: 'object-select' }>,
    object: TargetCustomObject,
  ) => void;
  pickDashboard: (phase: Extract<Phase, { type: 'dashboard-select' }>, row: TargetRow) => void;
  pickTarget: (phase: Extract<Phase, { type: 'target-select' }>, choice: PushChoice) => void;
  acceptDrift: (phase: Extract<Phase, { type: 'confirm'; kind: 'drift' }>) => void;
  acceptPush: (phase: Extract<Phase, { type: 'confirm'; kind: 'push' }>) => void;
  cancel: () => void;
  /** Ctrl+C: no further phase or write (`SessionStep.abort`). */
  abort: () => void;
} {
  // The account step every signed-in command shares; it continues with `packageBlock`.
  const session = createSessionStep<PushCommandOptions>({
    deps,
    setPhase: showPhase,
    setSession: showSession,
    next: (options, resolved) => packageBlock(options, resolved, apiName),
  });
  const { fail, guard } = session;
  // After Ctrl+C the flow shows nothing more.
  const setPhase = session.whileRunning(showPhase);
  const setSession = session.whileRunning(showSession);

  const apply = async (context: PushContext, plan: PushPlan): Promise<void> => {
    // Ctrl+C before the write starts it never starts.
    if (session.isAborted()) {
      return;
    }

    setPhase({ type: 'applying', plan });

    const step = await applyPlan(context, plan, deps);

    if (!step.ok) {
      fail(step);

      return;
    }

    setPhase({ type: 'done', plan, applied: step.value });
  };

  const plan = async (
    context: PushContext,
    target: ResolvedTarget,
    options: PushCommandOptions,
  ): Promise<void> => {
    setPhase({ type: 'loading', label: 'Preparing the push…' });

    const step = await buildPlan(context, target, options, deps);

    if (!step.ok) {
      if (step.code === 'drift_detected') {
        setPhase({
          type: 'confirm',
          kind: 'drift',
          message: step.message,
          target,
          options,
          context,
        });

        return;
      }

      fail(step);

      return;
    }

    switch (writeDecision(options, context.credentials.environment)) {
      case 'dry-run':
        setPhase({ type: 'done', plan: step.value, applied: null });

        return;
      case 'apply':
        await apply(context, step.value);

        return;
      case 'confirm':
        setPhase({ type: 'confirm', kind: 'push', plan: step.value, options, context });
    }
  };

  const resolve = async (
    context: PushContext,
    options: PushCommandOptions,
    back: Phase | null,
  ): Promise<void> => {
    setPhase({ type: 'loading', label: 'Resolving the target…' });

    const step = await resolveTarget(context, options);

    if (step.ok) {
      await plan(context, step.value, options);

      return;
    }

    const dashboardId = options.dashboard ?? context.entry?.dashboardId;
    const pickable =
      (step.code === 'needs_choice' && step.choice === 'target') ||
      step.code === 'remembered_target_missing';

    if (pickable && step.choices && step.choices.length > 0 && dashboardId !== undefined) {
      setPhase({
        type: 'target-select',
        dashboardId,
        title: 'Choose a block to update, or create a new one',
        message: step.message,
        choices: orderTargetChoices(step.choices, null),
        matchedId: null,
        back,
        options,
        context,
      });

      return;
    }

    fail(step);
  };

  const prepare = async (
    options: PushCommandOptions,
    { credentials, client }: ResolvedCredentials,
    block: ResolvedBlock,
  ): Promise<void> => {
    // --forget rewrites the push map here.
    if (session.isAborted()) {
      return;
    }

    const { context, forgotten } = await loadPushContext(
      {
        client,
        credentials,
        block,
        forget: options.forget === true,
      },
      deps,
    );

    if (forgotten) {
      setSession((current) => ({
        ...current,
        notices: [...current.notices, `Forgot the remembered target for ${block.block.api_name}.`],
      }));
    }

    if (options.dashboard !== undefined || context.entry) {
      await resolve(context, options, null);

      return;
    }

    setPhase({ type: 'surface-select', options, context });
  };

  const packageBlock = async (
    options: PushCommandOptions,
    resolved: ResolvedCredentials,
    name: string | undefined,
  ): Promise<void> => {
    setPhase({ type: 'packaging' });

    const step = await resolveBlock(name, deps);

    if (!step.ok) {
      if (step.choice === 'block' && step.choices) {
        setPhase({ type: 'block-select', options, resolved, choices: step.choices });

        return;
      }

      fail(step);

      return;
    }

    setSession((current) => ({ ...current, warnings: step.value.warnings }));
    await prepare(options, resolved, step.value);
  };

  const listDashboards = async (
    { options, context }: Resolving,
    surface: Surface,
    object: TargetCustomObject | null,
    back: Phase,
  ): Promise<void> => {
    const noun = SURFACE_NOUNS[surface];

    setPhase({ type: 'loading', label: `Loading ${noun}s…` });

    const summaries = await context.client.listDashboards(
      surfaceToDashboardType(surface),
      object?.id,
    );
    const rows = summaries.map((summary) => toTargetRow(summary, surface));
    const { environment, businessId } = context.credentials;

    if (rows.length === 0) {
      fail({
        message: `No ${noun}s found${object ? ` on ${object.objectName}` : ''} for business ${businessId} (${environment}).`,
      });

      return;
    }

    setPhase({
      type: 'dashboard-select',
      surface,
      objectId: object?.id ?? null,
      title: object ? `Choose a chart group on ${object.objectName}` : `Choose a ${noun}`,
      rows,
      back,
      options,
      context,
    });
  };

  return {
    start: (options) => {
      guard(() => session.load(options));
    },
    pickEnvironment: (phase, choice) => {
      guard(() => session.pickEnvironment(phase, choice));
    },
    pickBlock: (phase, choice) => {
      guard(() => packageBlock(phase.options, phase.resolved, choice.value));
    },
    pickSurface: (phase, surface) => {
      guard(async () => {
        if (surface !== 'chart_group') {
          await listDashboards(phase, surface, null, phase);

          return;
        }

        setPhase({ type: 'loading', label: 'Loading custom objects…' });

        const objects = await listPushableObjects(phase.context.client);

        if (objects.length === 0) {
          fail({ message: 'No custom objects found, so there are no chart groups to push to.' });

          return;
        }

        setPhase({
          type: 'object-select',
          objects,
          back: phase,
          options: phase.options,
          context: phase.context,
        });
      });
    },
    pickObject: (phase, object) => {
      guard(() => listDashboards(phase, 'chart_group', object, phase));
    },
    pickDashboard: (phase, row) => {
      guard(async () => {
        const { context } = phase;
        const options: PushCommandOptions = { ...phase.options, dashboard: row.id };

        if (options.dashlet !== undefined || options.create) {
          await resolve(context, options, phase);

          return;
        }

        setPhase({ type: 'loading', label: `Loading "${row.name}"…` });

        const dashboard = await context.client.getDashboard(row.id);
        const match = matchContextTarget(context, dashboard);
        const matchedId = match.kind === 'map' || match.kind === 'name' ? match.dashlet.id : null;

        setPhase({
          type: 'target-select',
          dashboardId: dashboard.id,
          title: `Choose what to push to on "${dashboard.name}"`,
          message: null,
          choices: orderTargetChoices(buildTargetChoices(dashboard, context.block), matchedId),
          matchedId,
          back: phase,
          options,
          context,
        });
      });
    },
    pickTarget: (phase, choice) => {
      guard(() =>
        resolve(phase.context, withTarget(phase.options, phase.dashboardId, choice), phase),
      );
    },
    acceptDrift: (phase) => {
      guard(() => plan(phase.context, phase.target, { ...phase.options, force: true }));
    },
    acceptPush: (phase) => {
      guard(() => apply(phase.context, phase.plan));
    },
    cancel: () => {
      fail({ message: 'Cancelled.' });
    },
    abort: session.abort,
  };
}

const PlanSummary: FC<{ plan: PushPlan }> = ({ plan }) => (
  <Box flexDirection="column">
    <Lines lines={formatSummaryLines(plan.summary)} />
    <Text>URL: {plan.url}</Text>
  </Box>
);

const DoneFrame: FC<{ plan: PushPlan; applied: AppliedPush | null }> = ({ plan, applied }) => {
  const refresh = buildBrowserRefresh(plan.dashboard.id);

  if (applied === null) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="yellow">{DRY_RUN_TITLE}</Text>
        <PlanSummary plan={plan} />
        {plan.warnings.length > 0 && <Lines lines={warningLines(plan.warnings)} color="yellow" />}
        <Box flexDirection="column">
          <Text bold>
            {plan.method} {plan.path}
          </Text>
          <Text>{JSON.stringify(plan.body, null, 2)}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text color="green">✓</Text>
        <Text bold>
          {plan.action === 'create' ? 'Created' : 'Updated'} {plan.summary.blockName} on "
          {plan.dashboard.name}"
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text>URL: {plan.url}</Text>
        {refresh && <Text dimColor>Refresh an open tab: {refresh.script}</Text>}
      </Box>
      {applied.warnings.length > 0 && (
        <Lines lines={warningLines(applied.warnings)} color="yellow" />
      )}
    </Box>
  );
};

export const PushUI: FC<PushUIProps> = ({ apiName, options, deps }) => {
  const [phase, setPhase] = useState<Phase>({ type: 'loading', label: LOADING_CREDENTIALS });
  const [session, setSession] = useState<Session>(EMPTY_SESSION);
  const [flow] = useState(() => createPushFlow(apiName, deps, setPhase, setSession));
  const [initialOptions] = useState(options);

  useEffect(() => {
    flow.start(initialOptions);
  }, [flow, initialOptions]);

  useCommandExit(phase.type === 'done' || phase.type === 'error', deps.setExitCode, flow.abort);

  const frame = (children: ReactNode): ReactNode => (
    <SessionFrame session={session}>{children}</SessionFrame>
  );

  switch (phase.type) {
    case 'loading':
      return frame(<Working label={phase.label} />);
    case 'packaging':
      return frame(<Working label="Packaging blocks…" />);
    case 'applying':
      return frame(
        <Working
          label={`Pushing ${phase.plan.summary.blockName} to "${phase.plan.dashboard.name}"…`}
        />,
      );
    case 'environment-select':
      return frame(
        <ChoiceList
          key="environment"
          title="Environment"
          choices={phase.choices}
          onPick={(choice) => {
            flow.pickEnvironment(phase, choice);
          }}
          onCancel={flow.cancel}
        />,
      );
    case 'block-select':
      return frame(
        <ChoiceList
          key="block"
          title="Block to push"
          choices={phase.choices}
          onPick={(choice) => {
            flow.pickBlock(phase, choice);
          }}
          onCancel={flow.cancel}
        />,
      );
    case 'surface-select':
      return frame(
        <SelectList
          key="surface"
          title="Where should the block go?"
          items={SURFACE_ITEMS}
          onSelect={pick(SURFACE_ITEMS, (item) => {
            flow.pickSurface(phase, item.key);
          })}
          onCancel={flow.cancel}
        />,
      );
    case 'object-select':
      return frame(
        <SelectList
          key="object"
          title="Custom object"
          items={phase.objects.map((object) => ({ key: object.id, label: object.objectName }))}
          onSelect={pick(phase.objects, (object) => {
            flow.pickObject(phase, object);
          })}
          onCancel={() => {
            setPhase(phase.back);
          }}
          hint={BACK_HINT}
        />,
      );
    case 'dashboard-select':
      return frame(
        <SelectList
          key={`dashboards-${phase.surface}-${phase.objectId ?? ''}`}
          title={phase.title}
          items={phase.rows.map(dashboardItem)}
          onSelect={pick(phase.rows, (row) => {
            flow.pickDashboard(phase, row);
          })}
          onCancel={() => {
            setPhase(phase.back);
          }}
          hint={BACK_HINT}
        />,
      );
    case 'target-select': {
      const { back } = phase;

      return frame(
        <>
          {phase.message !== null && <Text color="yellow">{phase.message}</Text>}
          <SelectList
            key={`targets-${phase.dashboardId}`}
            title={phase.title}
            items={phase.choices.map((choice) => targetItem(choice, phase.matchedId))}
            onSelect={pick(phase.choices, (choice) => {
              flow.pickTarget(phase, choice);
            })}
            onCancel={
              back
                ? () => {
                    setPhase(back);
                  }
                : flow.cancel
            }
            {...(back && { hint: BACK_HINT })}
          />
        </>,
      );
    }

    case 'confirm':
      if (phase.kind === 'drift') {
        return frame(
          <Box flexDirection="column" gap={1}>
            <Text color="yellow">{DRIFT_WARNING}</Text>
            <Text dimColor>{phase.message}</Text>
            <ConfirmPrompt
              key="drift"
              prompt="Type y to overwrite (y/N)"
              strict
              onAccept={() => {
                flow.acceptDrift(phase);
              }}
              onCancel={flow.cancel}
            />
          </Box>,
        );
      }

      return frame(
        <Box flexDirection="column" gap={1}>
          <PlanSummary plan={phase.plan} />
          {phase.plan.warnings.length > 0 && (
            <Lines lines={warningLines(phase.plan.warnings)} color="yellow" />
          )}
          <ProductionConfirm
            key="push"
            isProduction={phase.plan.summary.isProduction}
            prompt="Push? (Y/n)"
            productionPrompt="Type y to push to production (y/N)"
            onAccept={() => {
              flow.acceptPush(phase);
            }}
            onCancel={flow.cancel}
          />
        </Box>,
      );
    case 'done':
      return frame(<DoneFrame plan={phase.plan} applied={phase.applied} />);
    case 'error':
      return frame(<ErrorFrame view={phase.view} />);
  }
};
