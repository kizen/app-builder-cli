import { useEffect, useState, type FC, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { AppDeps } from '../lib/appFlow.js';
import { warningLines } from '../lib/commandCore.js';
import {
  createAppFlow,
  isFinalAppPhase,
  type AppOutcome,
  type AppPhase,
  type AppRequest,
  type FinalPhase,
} from './appUiFlow.js';
import { ChoiceList } from './ChoiceList.js';
import { EMPTY_SESSION, LOADING_CREDENTIALS, type Session } from './commandSession.js';
import { ProductionConfirm } from './ConfirmPrompt.js';
import { ErrorFrame, type ErrorView } from './ErrorFrame.js';
import { Lines } from './Lines.js';
import { SessionFrame, useCommandExit } from './SessionFrame.js';
import { ValidationIssues } from './ValidationIssues.js';
import { Working } from './Working.js';

export interface AppUIProps {
  request: AppRequest;
  deps: AppDeps;
}

const Warnings: FC<{ warnings: readonly string[] }> = ({ warnings }) =>
  warnings.length > 0 ? <Lines lines={warningLines(warnings)} color="yellow" /> : null;

const OutcomeFrame: FC<{ outcome: AppOutcome }> = ({ outcome }) => (
  <Box flexDirection="column" gap={1}>
    <Text bold color={outcome.tone === 'success' ? 'green' : 'yellow'}>
      {outcome.title}
    </Text>
    {outcome.lines.length > 0 && <Lines lines={outcome.lines} />}
    <Warnings warnings={outcome.warnings} />
    {outcome.next !== null && <Text dimColor>Next: {outcome.next}</Text>}
  </Box>
);

const FinalFrame: FC<{ phase: FinalPhase }> = ({ phase }) =>
  phase.type === 'done' ? (
    <OutcomeFrame outcome={phase.outcome} />
  ) : (
    <Box flexDirection="column" gap={1}>
      <Lines lines={phase.lines} />
      <Warnings warnings={phase.warnings} />
    </Box>
  );

const Failure: FC<{ view: ErrorView }> = ({ view }) =>
  view.issues && view.issues.length > 0 ? (
    <ValidationIssues issues={view.issues} />
  ) : (
    <ErrorFrame view={view} />
  );

export const AppUI: FC<AppUIProps> = ({ request, deps }) => {
  const [phase, setPhase] = useState<AppPhase>({ type: 'loading', label: LOADING_CREDENTIALS });
  const [session, setSession] = useState<Session>(EMPTY_SESSION);
  const [flow] = useState(() => createAppFlow(request, deps, setPhase, setSession));

  useEffect(() => {
    flow.start();
  }, [flow]);

  useCommandExit(isFinalAppPhase(phase), deps.setExitCode, flow.abort);

  const frame = (children: ReactNode): ReactNode => (
    <SessionFrame session={session}>{children}</SessionFrame>
  );

  switch (phase.type) {
    case 'loading':
      return frame(<Working label={phase.label} />);
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
    case 'report':
      return frame(<FinalFrame phase={phase} />);
    case 'confirm':
      return frame(
        <Box flexDirection="column" gap={1}>
          <Lines lines={phase.lines} />
          <Warnings warnings={phase.warnings} />
          <ProductionConfirm
            isProduction={phase.isProduction}
            strict={phase.strict === true}
            prompt={phase.prompt}
            productionPrompt={phase.productionPrompt}
            onAccept={() => {
              flow.accept(phase);
            }}
            onCancel={flow.cancel}
          />
        </Box>,
      );
    case 'choose':
      return frame(
        <Box flexDirection="column" gap={1}>
          {phase.above !== undefined && <FinalFrame phase={phase.above} />}
          {phase.lines.length > 0 && <Lines lines={phase.lines} />}
          {phase.message !== '' && <Text color="yellow">{phase.message}</Text>}
          <ChoiceList
            key={[phase.title, ...phase.choices.map((choice) => choice.value)].join('|')}
            title={phase.title}
            choices={phase.choices}
            onPick={(choice) => {
              flow.choose(phase, choice);
            }}
            onCancel={() => {
              flow.dismiss(phase);
            }}
            {...(phase.initial !== undefined && { initial: phase.initial })}
            searchable={phase.searchable === true}
          />
        </Box>,
      );
    case 'done':
      return frame(<FinalFrame phase={phase} />);
    case 'error':
      return frame(<Failure view={phase.view} />);
  }
};
