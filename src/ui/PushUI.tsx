import {
  useEffect,
  useState,
  type Dispatch,
  type FC,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { type ValidationIssue } from '@kizenapps/packager';
import { type Credentials } from '../lib/credentials.js';
import { formatValidationIssues } from '../lib/formatValidationIssues.js';
import { type Surface } from '../lib/kizenTypes.js';
import { surfaceToDashboardType } from '../lib/pushBlock.js';
import {
  apiFailure,
  applyPlan,
  buildBrowserRefresh,
  buildPlan,
  buildTargetChoices,
  formatSummaryLines,
  headlessWriteGate,
  listPushableObjects,
  loadPushContext,
  matchContextTarget,
  resolveBlock,
  resolveCredentials,
  resolveTarget,
  toTargetRow,
  warningLines,
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
import { AppHeader } from './AppHeader.js';
import { SelectList, type SelectItem } from './SelectList.js';
import { Spinner } from './Spinner.js';

export interface PushUIProps {
  apiName?: string;
  options: PushCommandOptions;
  deps: PushDeps;
}

interface ErrorView {
  message: string;
  hint?: string;
  choices?: PushChoice[];
  issues?: ValidationIssue[];
}

interface Session {
  credentials: Credentials | null;
  warnings: ValidationIssue[];
  notices: string[];
}

interface Resolving {
  options: PushCommandOptions;
  context: PushContext;
}

type Phase =
  | { type: 'loading'; label: string }
  | { type: 'profile-select'; options: PushCommandOptions; choices: PushChoice[] }
  | { type: 'packaging' }
  | {
      type: 'block-select';
      options: PushCommandOptions;
      credentials: Credentials;
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

type Setter<T> = Dispatch<SetStateAction<T>>;

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

// A SelectList onSelect that hands the picked element of `list` to `fn`.
function pick<T>(
  list: readonly T[],
  fn: (value: T) => void,
): (item: SelectItem, index: number) => void {
  return (_item, index) => {
    const value = list[index];

    if (value !== undefined) {
      fn(value);
    }
  };
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

function createPushFlow(
  apiName: string | undefined,
  deps: PushDeps,
  setPhase: Setter<Phase>,
  setSession: Setter<Session>,
): {
  start: (options: PushCommandOptions) => void;
  pickProfile: (phase: Extract<Phase, { type: 'profile-select' }>, choice: PushChoice) => void;
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
} {
  const fail = (view: ErrorView): void => {
    deps.setExitCode(1);
    setPhase({ type: 'error', view });
  };

  const guard = (task: () => Promise<void>): void => {
    task().catch((error: unknown) => {
      fail(apiFailure(error));
    });
  };

  const apply = async (context: PushContext, plan: PushPlan): Promise<void> => {
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

    if (options.dryRun) {
      setPhase({ type: 'done', plan: step.value, applied: null });

      return;
    }

    if (options.yes) {
      const gate = headlessWriteGate(options, context.credentials.environment);

      if (gate.ok && gate.value.kind === 'apply') {
        await apply(context, step.value);

        return;
      }
    }

    setPhase({ type: 'confirm', kind: 'push', plan: step.value, options, context });
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
    credentials: Credentials,
    block: ResolvedBlock,
  ): Promise<void> => {
    const { context, forgotten } = await loadPushContext(
      {
        client: deps.createClient(credentials),
        credentials,
        block,
        forget: options.forget === true,
      },
      deps,
    );

    if (forgotten) {
      setSession((session) => ({
        ...session,
        notices: [...session.notices, `Forgot the remembered target for ${block.block.api_name}.`],
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
    credentials: Credentials,
    name: string | undefined,
  ): Promise<void> => {
    setPhase({ type: 'packaging' });

    const step = await resolveBlock(name, deps);

    if (!step.ok) {
      if (step.choice === 'block' && step.choices) {
        setPhase({ type: 'block-select', options, credentials, choices: step.choices });

        return;
      }

      fail(step);

      return;
    }

    setSession((session) => ({ ...session, warnings: step.value.warnings }));
    await prepare(options, credentials, step.value);
  };

  const loadCredentials = async (options: PushCommandOptions): Promise<void> => {
    setPhase({ type: 'loading', label: 'Loading credentials…' });

    const step = await resolveCredentials(options, deps);

    if (!step.ok) {
      if (step.choice === 'profile' && step.choices) {
        setPhase({ type: 'profile-select', options, choices: step.choices });

        return;
      }

      fail(step);

      return;
    }

    const { credentials } = step.value;

    setSession((session) => ({ ...session, credentials }));
    await packageBlock(options, credentials, apiName);
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
      guard(() => loadCredentials(options));
    },
    pickProfile: (phase, choice) => {
      guard(() => loadCredentials({ ...phase.options, profile: choice.value }));
    },
    pickBlock: (phase, choice) => {
      guard(() => packageBlock(phase.options, phase.credentials, choice.value));
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
  };
}

interface ConfirmPromptProps {
  prompt: string;
  strict: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

const ConfirmPrompt: FC<ConfirmPromptProps> = ({ prompt, strict, onAccept, onCancel }) => {
  useInput((input, key) => {
    if (key.ctrl) {
      return;
    }

    const answer = input.toLowerCase();

    if (answer === 'y' || (!strict && key.return)) {
      onAccept();
    } else if (strict || answer === 'n' || key.escape) {
      onCancel();
    }
  });

  return <Text bold>{prompt}</Text>;
};

const Lines: FC<{ lines: readonly string[]; color?: 'yellow' | 'red' }> = ({ lines, color }) => (
  <Box flexDirection="column">
    {lines.map((line, index) => (
      <Text key={`${String(index)}-${line}`} {...(color && { color })}>
        {line}
      </Text>
    ))}
  </Box>
);

const PlanSummary: FC<{ plan: PushPlan }> = ({ plan }) => (
  <Box flexDirection="column">
    <Lines lines={formatSummaryLines(plan.summary)} />
    <Text>URL: {plan.url}</Text>
  </Box>
);

const Working: FC<{ label: string }> = ({ label }) => (
  <Box gap={1}>
    <Spinner />
    <Text dimColor>{label}</Text>
  </Box>
);

const ErrorFrame: FC<{ view: ErrorView }> = ({ view }) => (
  <Box flexDirection="column" gap={1}>
    <Box gap={1}>
      <Text color="red">✗</Text>
      <Text color="red">
        {view.issues && view.issues.length > 0 ? formatValidationIssues(view.issues) : view.message}
      </Text>
    </Box>
    {view.hint !== undefined && <Text dimColor>Hint: {view.hint}</Text>}
    {view.choices && view.choices.length > 0 && (
      <Box flexDirection="column">
        <Text>Choices:</Text>
        <Lines lines={view.choices.map((choice) => `  ${choice.label}`)} />
      </Box>
    )}
  </Box>
);

const DoneFrame: FC<{ plan: PushPlan; applied: AppliedPush | null }> = ({ plan, applied }) => {
  const refresh = buildBrowserRefresh(plan.dashboard.id);

  if (applied === null) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="yellow">Dry run: nothing was written.</Text>
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
  const app = useApp();
  const [phase, setPhase] = useState<Phase>({ type: 'loading', label: 'Loading credentials…' });
  const [session, setSession] = useState<Session>({
    credentials: null,
    warnings: [],
    notices: [],
  });
  const [flow] = useState(() => createPushFlow(apiName, deps, setPhase, setSession));
  const [initialOptions] = useState(options);

  useEffect(() => {
    flow.start(initialOptions);
  }, [flow, initialOptions]);

  useEffect(() => {
    if (phase.type === 'done' || phase.type === 'error') {
      app.exit();
    }
  }, [phase, app]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c' && phase.type !== 'done' && phase.type !== 'error') {
      deps.setExitCode(130);
      app.exit();
    }
  });

  const frame = (children: ReactNode): ReactNode => (
    <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
      <AppHeader />
      {session.credentials && (
        <Text dimColor>
          Environment: {session.credentials.environment} · Business:{' '}
          {session.credentials.businessId}
        </Text>
      )}
      {session.warnings.length > 0 && (
        <Text dimColor>{formatValidationIssues(session.warnings)}</Text>
      )}
      {session.notices.length > 0 && <Lines lines={session.notices} />}
      {children}
    </Box>
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
    case 'profile-select':
      return frame(
        <SelectList
          key="profile"
          title="Credential profile"
          items={phase.choices.map((choice) => ({ key: choice.value, label: choice.label }))}
          onSelect={pick(phase.choices, (choice) => {
            flow.pickProfile(phase, choice);
          })}
          onCancel={flow.cancel}
        />,
      );
    case 'block-select':
      return frame(
        <SelectList
          key="block"
          title="Block to push"
          items={phase.choices.map((choice) => ({ key: choice.value, label: choice.label }))}
          onSelect={pick(phase.choices, (choice) => {
            flow.pickBlock(phase, choice);
          })}
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
          {phase.plan.summary.isProduction && (
            <Text color="red" bold>
              PRODUCTION
            </Text>
          )}
          <ConfirmPrompt
            key="push"
            prompt={
              phase.plan.summary.isProduction ? 'Type y to push to production (y/N)' : 'Push? (Y/n)'
            }
            strict={phase.plan.summary.isProduction}
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
