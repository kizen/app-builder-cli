import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { PluginValidationError } from '@kizenapps/packager';
import type { ValidationIssue } from '@kizenapps/packager';
import { runBuild } from '../lib/runBuild.js';
import type { BuildStepName } from '../lib/runBuild.js';
import { formatBytes } from '../../shared/lib/formatBytes.js';
import { AppHeader } from './AppHeader.js';
import { Spinner } from './Spinner.js';
import { ValidationIssues } from './ValidationIssues.js';

type BuildStep = BuildStepName | 'done';

interface BuildUIProps {
  outputDir: string;
  pluginDir: string;
}

const STEPS: BuildStepName[] = [
  'creating-dir',
  'reading-files',
  'validating',
  'minifying',
  'packaging',
  'writing-bundle',
];

const STEP_LABELS: Record<BuildStepName, string> = {
  'creating-dir': 'Creating .kizenapp directory',
  'reading-files': 'Reading plugin files',
  validating: 'Validating plugin app',
  minifying: 'Minifying scripts',
  packaging: 'Packaging plugin',
  'writing-bundle': 'Writing bundle.json',
};

export const BuildUI: FC<BuildUIProps> = ({ outputDir, pluginDir }) => {
  const app = useApp();
  const [step, setStep] = useState<BuildStep>('creating-dir');
  const [failed, setFailed] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bundleSize, setBundleSize] = useState<number | null>(null);

  useEffect(() => {
    void runBuild(pluginDir, outputDir, setStep)
      .then(({ bundleSize: size }) => {
        setBundleSize(size);
        setStep('done');
      })
      .catch((err: unknown) => {
        if (err instanceof PluginValidationError) {
          setIssues(err.issues);
        } else {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }

        // Leave `step` on the step that was running so the ✗ lands on it.
        setFailed(true);
        process.exitCode = 1;
      });
  }, [outputDir, pluginDir]);

  // Exit only once the terminal frame has been committed and written to the
  // terminal. Calling app.exit() in the same tick as the state updates would
  // unmount ink before it paints the done/error frame, leaving the spinner as
  // the last thing on screen.
  useEffect(() => {
    if (step === 'done' || failed) {
      app.exit();
    }
  }, [step, failed, app]);

  const currentIndex = STEPS.indexOf(step as BuildStepName);
  const isDone = step === 'done';

  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <AppHeader marginBottom={1} />

      <Box flexDirection="column" gap={0}>
        {STEPS.map((s, i) => {
          const isActive = step === s;
          const isStepDone = isDone || currentIndex > i;
          const isFailed = failed && i === currentIndex;

          return (
            <Box key={s} gap={1}>
              {isFailed ? (
                <Text color="red">✗ {STEP_LABELS[s]}</Text>
              ) : isStepDone ? (
                <Text color="green">✓ {STEP_LABELS[s]}</Text>
              ) : isActive ? (
                <>
                  <Spinner />
                  <Text>{STEP_LABELS[s]}</Text>
                </>
              ) : (
                <Text dimColor> {STEP_LABELS[s]}</Text>
              )}
            </Box>
          );
        })}

        {isDone && bundleSize !== null && (
          <Box marginTop={1} gap={1}>
            <Text color="green">✓ bundle — {formatBytes(bundleSize)}</Text>
          </Box>
        )}

        {issues !== null && <ValidationIssues issues={issues} />}

        {errorMessage !== null && (
          <Box marginTop={1} borderStyle="single" borderColor="red" paddingX={1}>
            <Text color="red">{errorMessage}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
