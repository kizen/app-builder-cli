import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { runBuild } from '../lib/runBuild.js';
import type { BuildStepName } from '../lib/runBuild.js';
import { formatBytes } from '../../shared/lib/formatBytes.js';
import { AppHeader } from './AppHeader.js';
import { Spinner } from './Spinner.js';

type BuildStep = BuildStepName | 'done' | 'error';

interface BuildUIProps {
  outputDir: string;
  pluginDir: string;
}

const STEPS: BuildStepName[] = [
  'creating-dir',
  'reading-files',
  'minifying',
  'packaging',
  'writing-bundle',
];

const STEP_LABELS: Record<BuildStepName, string> = {
  'creating-dir': 'Creating .kizenapp directory',
  'reading-files': 'Reading plugin files',
  minifying: 'Minifying scripts',
  packaging: 'Packaging plugin',
  'writing-bundle': 'Writing bundle.json',
};

export const BuildUI: FC<BuildUIProps> = ({ outputDir, pluginDir }) => {
  const app = useApp();
  const [step, setStep] = useState<BuildStep>('creating-dir');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bundleSize, setBundleSize] = useState<number | null>(null);

  useEffect(() => {
    void runBuild(pluginDir, outputDir, setStep)
      .then(({ bundleSize: size }) => {
        setBundleSize(size);
        setStep('done');

        app.exit();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);

        setErrorMessage(message);
        setStep('error');
        app.exit();
      });
  }, [outputDir, pluginDir, app]);

  const currentIndex = STEPS.indexOf(step as BuildStepName);
  const isError = step === 'error';
  const isDone = step === 'done';

  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <AppHeader marginBottom={1} />

      <Box flexDirection="column" gap={0}>
        {STEPS.map((s, i) => {
          const isActive = step === s;
          const isStepDone = isDone || currentIndex > i;
          const isFailed = isError && i === currentIndex;

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

        {errorMessage !== null && (
          <Box marginTop={1} borderStyle="single" borderColor="red" paddingX={1}>
            <Text color="red">{errorMessage}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
