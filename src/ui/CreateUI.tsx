import type { FC } from 'react';
import { useCallback, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { join } from 'node:path';
import {
  buildManifest,
  createPlugin,
  findAvailableSubDir,
  precheckTargetDir,
} from '../lib/createPlugin.js';
import type { PrecheckResult } from '../lib/createPlugin.js';
import {
  emptyValues,
  FIELD_LABELS,
  FIELDS,
  inferApiName,
  normalizeFieldValue,
  REQUIRED_FIELDS,
  toggleArtifactSelection,
  validateField,
} from '../lib/createForm.js';
import type { FieldValues } from '../lib/createForm.js';
import { ARTIFACT_LABELS, ARTIFACT_TYPES } from '../lib/createArtifacts.js';
import type { ArtifactType } from '../lib/createArtifacts.js';
import type { Environment } from '../../shared/lib/credentials.js';
import { AppHeader } from './AppHeader.js';

type Mode = 'in-place' | 'sub-dir';

type Phase =
  | { type: 'target-select'; cursor: 0 | 1 }
  | { type: 'precheck-error'; targetDir: string; reason: PrecheckResult }
  | { type: 'field-entry'; field: number; values: FieldValues; fieldError?: string }
  | {
      type: 'artifact-select';
      values: FieldValues;
      cursor: number;
      selected: readonly ArtifactType[];
    }
  | { type: 'resolving-target' }
  | { type: 'confirm'; values: FieldValues; artifacts: readonly ArtifactType[] }
  | { type: 'writing' }
  | { type: 'done'; targetDir: string }
  | { type: 'error'; message: string };

interface CreateUIProps {
  parentDir: string;
  defaultBusinessId: string;
  defaultEnvironment: Environment;
}

const Hint: FC<{ text: string }> = ({ text }) => <Text dimColor>{text}</Text>;

export const CreateUI: FC<CreateUIProps> = ({
  parentDir,
  defaultBusinessId,
  defaultEnvironment,
}) => {
  const app = useApp();
  const [phase, setPhase] = useState<Phase>({ type: 'target-select', cursor: 0 });
  const [mode, setMode] = useState<Mode>('in-place');
  const [values, setValues] = useState<FieldValues>(() => emptyValues(defaultBusinessId));
  const [artifacts, setArtifacts] = useState<readonly ArtifactType[]>(() => [...ARTIFACT_TYPES]);
  const [inputBuffer, setInputBuffer] = useState('');
  const [targetDir, setTargetDir] = useState<string>(parentDir);

  const enterFieldEntry = useCallback((nextMode: Mode, initialValues: FieldValues): void => {
    setMode(nextMode);

    setInputBuffer(initialValues.name);

    setPhase({ type: 'field-entry', field: 0, values: initialValues });
  }, []);

  const runPrecheck = useCallback(
    async (dir: string): Promise<void> => {
      const result = await precheckTargetDir(dir);

      if (result !== 'ok') {
        setPhase({ type: 'precheck-error', targetDir: dir, reason: result });

        return;
      }

      setTargetDir(dir);

      enterFieldEntry('in-place', values);
    },
    [values, enterFieldEntry],
  );

  const resolveSubDirAndConfirm = useCallback(
    async (finalValues: FieldValues, artifacts: readonly ArtifactType[]): Promise<void> => {
      try {
        const dir = await findAvailableSubDir(parentDir, finalValues.apiName);

        setTargetDir(dir);

        setPhase({ type: 'confirm', values: finalValues, artifacts });
      } catch (err) {
        setPhase({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [parentDir],
  );

  const runWrite = useCallback(
    async (
      finalValues: FieldValues,
      dir: string,
      artifacts: readonly ArtifactType[],
    ): Promise<void> => {
      try {
        await createPlugin({
          targetDir: dir,
          name: finalValues.name,
          apiName: finalValues.apiName,
          externalLink: finalValues.externalLink,
          description: finalValues.description,
          developerBusinessId: finalValues.developerBusinessId,
          developerEnvironment: defaultEnvironment,
          artifacts,
        });

        setPhase({ type: 'done', targetDir: dir });
      } catch (err) {
        setPhase({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [defaultEnvironment],
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      app.exit();

      return;
    }

    if (phase.type === 'target-select') {
      if (key.upArrow) {
        setPhase({ type: 'target-select', cursor: 0 });
      } else if (key.downArrow) {
        setPhase({ type: 'target-select', cursor: 1 });
      } else if (key.return) {
        if (phase.cursor === 0) {
          void runPrecheck(parentDir);
        } else {
          enterFieldEntry('sub-dir', values);
        }
      } else if (key.escape) {
        app.exit();
      }

      return;
    }

    if (phase.type === 'precheck-error') {
      if (key.return || key.escape) {
        app.exit();
      }

      return;
    }

    if (phase.type === 'field-entry') {
      const { field, values: current } = phase;
      const fieldName = FIELDS[field];

      if (!fieldName) {
        return;
      }

      if (key.escape) {
        app.exit();

        return;
      }

      if (key.backspace || key.delete) {
        setInputBuffer((prev) => prev.slice(0, -1));

        return;
      }

      if (key.upArrow && field > 0) {
        const updated = { ...current, [fieldName]: inputBuffer };
        const prevField = field - 1;
        const prevName = FIELDS[prevField];

        setPhase({ type: 'field-entry', field: prevField, values: updated });

        setValues(updated);

        setInputBuffer(prevName ? updated[prevName] : '');

        return;
      }

      if (key.return || key.tab || key.downArrow) {
        const fieldError = validateField(fieldName, inputBuffer);

        if (fieldError !== undefined) {
          setPhase({ type: 'field-entry', field, values: current, fieldError });

          return;
        }

        const valueToStore = normalizeFieldValue(fieldName, inputBuffer);
        const updated = { ...current, [fieldName]: valueToStore };

        setValues(updated);

        const nextField = field + 1;

        if (nextField >= FIELDS.length) {
          setInputBuffer('');

          setPhase({
            type: 'artifact-select',
            values: updated,
            cursor: 0,
            selected: artifacts,
          });
        } else {
          const nextName = FIELDS[nextField];
          const existing = nextName ? updated[nextName] : '';
          const nextBuffer =
            nextName === 'apiName' && !existing ? inferApiName(updated.name) : existing;

          setPhase({ type: 'field-entry', field: nextField, values: updated });

          setInputBuffer(nextBuffer);
        }

        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setInputBuffer((prev) => prev + input);
      }

      return;
    }

    if (phase.type === 'artifact-select') {
      const { cursor, selected, values: current } = phase;

      if (key.escape) {
        const lastField = FIELDS.length - 1;
        const lastName = FIELDS[lastField];

        setPhase({ type: 'field-entry', field: lastField, values: current });

        setInputBuffer(lastName ? current[lastName] : '');

        return;
      }

      if (key.upArrow) {
        setPhase({ ...phase, cursor: Math.max(0, cursor - 1) });

        return;
      }

      if (key.downArrow) {
        setPhase({ ...phase, cursor: Math.min(ARTIFACT_TYPES.length - 1, cursor + 1) });

        return;
      }

      if (input === ' ') {
        const type = ARTIFACT_TYPES[cursor];

        if (type) {
          const next = toggleArtifactSelection(selected, type);

          setArtifacts(next);

          setPhase({ ...phase, selected: next });
        }

        return;
      }

      if (input === 'a') {
        setArtifacts([...ARTIFACT_TYPES]);

        setPhase({ ...phase, selected: [...ARTIFACT_TYPES] });

        return;
      }

      if (input === 'n') {
        setArtifacts([]);

        setPhase({ ...phase, selected: [] });

        return;
      }

      if (key.return) {
        if (mode === 'sub-dir') {
          setPhase({ type: 'resolving-target' });

          void resolveSubDirAndConfirm(current, selected);
        } else {
          setPhase({ type: 'confirm', values: current, artifacts: selected });
        }
      }

      return;
    }

    if (phase.type === 'confirm') {
      if (key.escape) {
        setPhase({
          type: 'artifact-select',
          values: phase.values,
          cursor: 0,
          selected: phase.artifacts,
        });

        return;
      }

      if (key.return) {
        setPhase({ type: 'writing' });

        void runWrite(phase.values, targetDir, phase.artifacts);
      }

      return;
    }

    if (phase.type === 'done' || phase.type === 'error') {
      if (key.return || key.escape) {
        app.exit();
      }
    }
  });

  if (phase.type === 'target-select') {
    const options = [
      { label: 'Use current directory', desc: parentDir },
      { label: 'Create new sub-directory', desc: `${parentDir}/<inferred from API name>` },
    ];

    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Box flexDirection="column" gap={0}>
          <Text bold>Where should the new plugin live?</Text>
          {options.map((opt, i) => {
            const selected = phase.cursor === i;

            return (
              <Box key={opt.label} gap={2}>
                <Text {...(selected && { color: 'cyan' as const })}>{selected ? '❯' : ' '}</Text>
                <Text bold={selected} {...(selected && { color: 'cyan' as const })}>
                  {opt.label}
                </Text>
                <Text dimColor>{opt.desc}</Text>
              </Box>
            );
          })}
        </Box>
        <Hint text="↑↓ to move · Enter to select · Esc to cancel" />
      </Box>
    );
  }

  if (phase.type === 'precheck-error') {
    const { targetDir: dir, reason } = phase;
    const conflict = reason === 'has-manifest' ? 'kizen.json' : '.kizenapp/';

    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Text color="red" bold>
          Cannot create plugin
        </Text>
        <Box flexDirection="column" gap={0}>
          <Text>
            {dir} already contains <Text bold>{conflict}</Text>.
          </Text>
          <Text dimColor>
            Remove the conflicting file/directory or choose a different target to avoid overwriting
            an existing plugin.
          </Text>
        </Box>
        <Hint text="Enter or Esc to exit" />
      </Box>
    );
  }

  if (phase.type === 'field-entry') {
    const { field: activeField, fieldError } = phase;
    const targetLine =
      mode === 'sub-dir'
        ? `Target: sub-directory of ${parentDir} (inferred from API name)`
        : `Target: ${targetDir}`;

    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Box flexDirection="column" gap={0}>
          <Text bold>Plugin details</Text>
          <Text dimColor>{targetLine}</Text>
        </Box>
        {fieldError !== undefined && <Text color="red">Error: {fieldError}</Text>}
        <Box flexDirection="column" gap={0}>
          {FIELDS.map((name, i) => {
            const isActive = activeField === i;
            const displayValue = isActive ? inputBuffer : values[name];
            const isRequired = REQUIRED_FIELDS.includes(name);
            const label = `${FIELD_LABELS[name]}${isRequired ? '' : ' (optional)'}`;

            return (
              <Box key={name} gap={2}>
                <Box width={24}>
                  <Text bold={isActive} {...(isActive && { color: 'cyan' as const })}>
                    {label}
                  </Text>
                </Box>
                <Text {...(isActive && { color: 'cyan' as const })}>{'>'}</Text>
                <Text>{displayValue}</Text>
                {isActive && <Text color="cyan">{'█'}</Text>}
              </Box>
            );
          })}
        </Box>
        <Hint text="Enter/Tab/↓ next · ↑ previous · Backspace delete · Esc cancel" />
      </Box>
    );
  }

  if (phase.type === 'artifact-select') {
    const { cursor, selected } = phase;

    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Box flexDirection="column" gap={0}>
          <Text bold>Which artifacts should we scaffold?</Text>
          <Text dimColor>Each one gets a directory with a config.json and a script that runs.</Text>
        </Box>
        <Box flexDirection="column" gap={0}>
          {ARTIFACT_TYPES.map((type, i) => {
            const active = cursor === i;
            const checked = selected.includes(type);

            return (
              <Box key={type} gap={1}>
                <Text {...(active && { color: 'cyan' as const })}>{active ? '❯' : ' '}</Text>
                <Text {...(checked && { color: 'green' as const })}>{checked ? '◉' : '◯'}</Text>
                <Text bold={active} {...(active && { color: 'cyan' as const })}>
                  {ARTIFACT_LABELS[type]}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Hint text="↑↓ move · Space toggle · a all · n none · Enter continue · Esc back" />
      </Box>
    );
  }

  if (phase.type === 'confirm') {
    const manifest = buildManifest({
      targetDir,
      name: phase.values.name,
      apiName: phase.values.apiName,
      externalLink: phase.values.externalLink,
      description: phase.values.description,
      developerBusinessId: phase.values.developerBusinessId,
      developerEnvironment: defaultEnvironment,
    });

    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Box flexDirection="column" gap={0}>
          <Text bold>Ready to create</Text>
          <Text dimColor>Target: {targetDir}</Text>
        </Box>
        <Box flexDirection="column" gap={0}>
          <Text bold>kizen.json preview</Text>
          <Text>{JSON.stringify(manifest, null, 2)}</Text>
        </Box>
        <Box flexDirection="column" gap={0}>
          <Text bold>Artifacts</Text>
          {phase.artifacts.length === 0 ? (
            <Text dimColor>{'  '}none (src/ will hold only thumbnail.png)</Text>
          ) : (
            phase.artifacts.map((type) => (
              <Text key={type} dimColor>
                {'  '}
                {ARTIFACT_LABELS[type]}
              </Text>
            ))
          )}
        </Box>
        <Box flexDirection="column" gap={0}>
          <Text dimColor>Also creates:</Text>
          <Text dimColor>
            {'  '}
            {join(targetDir, 'src/')}
          </Text>
          <Text dimColor>
            {'  '}
            {join(targetDir, 'src/thumbnail.png')} (generated placeholder)
          </Text>
          <Text dimColor>
            {'  '}
            {join(targetDir, 'releaseNotes/')}
          </Text>
          <Text dimColor>
            {'  '}
            {join(targetDir, '.gitignore')} (adds .kizenapp/)
          </Text>
        </Box>
        <Hint text="Enter to create · Esc to go back" />
      </Box>
    );
  }

  if (phase.type === 'resolving-target') {
    return (
      <Box paddingY={1} paddingX={2}>
        <Text dimColor>Finding available sub-directory…</Text>
      </Box>
    );
  }

  if (phase.type === 'writing') {
    return (
      <Box paddingY={1} paddingX={2}>
        <Text dimColor>Creating plugin…</Text>
      </Box>
    );
  }

  if (phase.type === 'done') {
    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Text color="green" bold>
          Plugin created at {phase.targetDir}
        </Text>
        <Box flexDirection="column" gap={0}>
          <Text dimColor>Next steps:</Text>
          <Text>
            {'  '}cd {phase.targetDir}
          </Text>
          <Text>{'  '}npx --yes @kizenapps/cli dev</Text>
          <Text dimColor>{'  '}Replace src/thumbnail.png with real artwork before publishing.</Text>
        </Box>
        <Hint text="Enter or Esc to exit" />
      </Box>
    );
  }

  // error
  return (
    <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
      <AppHeader />
      <Text color="red" bold>
        Failed to create plugin
      </Text>
      <Text>{phase.message}</Text>
      <Hint text="Enter or Esc to exit" />
    </Box>
  );
};
