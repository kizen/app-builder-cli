import type { FC } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  DEFAULT_PROFILE_NAME,
  ENVIRONMENTS,
  GLOBAL_CREDENTIALS_PATH,
  listCredentialProfiles,
  loadCredentialProfile,
  loadGlobalCredentials,
  saveCredentialProfile,
} from '../lib/credentials.js';
import type { CredentialProfile, Credentials } from '../lib/credentials.js';
import { AppHeader } from './AppHeader.js';

type Mode = 'global' | 'local';

type Phase =
  | { type: 'mode-select'; cursor: 0 | 1 }
  | { type: 'profile-loading' }
  | { type: 'profile-select'; profiles: CredentialProfile[]; cursor: number }
  | {
      type: 'name-entry';
      nameBuffer: string;
      nameError?: string;
      existingProfiles: CredentialProfile[];
    }
  | { type: 'loading' }
  | { type: 'creds-entry'; field: number; values: Partial<Credentials>; envCursor: number }
  | { type: 'saving' }
  | { type: 'done' };

const FIELDS = ['apiKey', 'userId', 'businessId'] as const;
const FIELD_LABELS: Record<string, string> = {
  apiKey: 'API Key',
  userId: 'User ID',
  businessId: 'Business ID',
};

export type CredentialMode = 'global' | 'local';

export interface CredentialSetupResult {
  mode: CredentialMode;
  credentials: Credentials | null;
  profileName?: string;
}

interface CredentialSetupUIProps {
  initialMode?: CredentialMode;
  showProfileManager?: boolean;
  onComplete: (result: CredentialSetupResult) => void;
  onCancel?: () => void;
}

const Hint: FC<{ text: string }> = ({ text }) => <Text dimColor>{text}</Text>;

export const CredentialSetupUI: FC<CredentialSetupUIProps> = ({
  initialMode,
  showProfileManager,
  onComplete,
  onCancel,
}) => {
  const [phase, setPhase] = useState<Phase>(
    initialMode === 'global' && !showProfileManager
      ? { type: 'loading' }
      : initialMode === 'global' && showProfileManager
        ? { type: 'profile-loading' }
        : { type: 'mode-select', cursor: 0 },
  );
  const [inputBuffer, setInputBuffer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [activeProfileName, setActiveProfileName] = useState<string | undefined>(undefined);

  const handleModeChosen = useCallback(
    (mode: Mode) => {
      if (mode === 'local') {
        onComplete({ mode: 'local', credentials: null });

        return;
      }

      setPhase({ type: 'profile-loading' });
    },
    [onComplete],
  );

  const handleProfileChosen = useCallback(async (profile: CredentialProfile | null) => {
    if (profile === null) {
      // "Add new profile" selected
      setPhase({ type: 'profile-loading' });

      const profiles = await listCredentialProfiles();

      setPhase({ type: 'name-entry', nameBuffer: '', existingProfiles: profiles });

      return;
    }

    setActiveProfileName(profile.isDefault ? undefined : profile.name);

    setPhase({ type: 'loading' });

    const existing = profile.isDefault
      ? await loadGlobalCredentials()
      : await loadCredentialProfile(profile.name);
    const envCursor = existing ? Math.max(0, ENVIRONMENTS.indexOf(existing.environment)) : 0;

    setPhase({ type: 'creds-entry', field: 0, values: existing ?? {}, envCursor });
  }, []);

  const handleSave = useCallback(
    async (values: Partial<Credentials>, envCursor: number) => {
      const environment = ENVIRONMENTS[envCursor] ?? 'go';
      const credentials: Credentials = {
        apiKey: values.apiKey ?? '',
        userId: values.userId ?? '',
        businessId: values.businessId ?? '',
        environment,
      };

      setPhase({ type: 'saving' });

      try {
        const profileName = activeProfileName ?? DEFAULT_PROFILE_NAME;

        await saveCredentialProfile(profileName, credentials);

        onComplete({
          mode: 'global',
          credentials,
          ...(activeProfileName !== undefined && { profileName: activeProfileName }),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));

        setPhase({ type: 'creds-entry', field: 0, values, envCursor });
      }
    },
    [onComplete, activeProfileName],
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      process.exit(0);
    }

    if (key.escape) {
      if (phase.type === 'creds-entry' || phase.type === 'name-entry') {
        // Go back to profile select if we came from there
        if (initialMode === 'global' && showProfileManager) {
          setPhase({ type: 'profile-loading' });

          void loadProfileList();

          return;
        }
      }

      onCancel?.();

      return;
    }

    if (phase.type === 'mode-select') {
      if (key.upArrow) {
        setPhase({ type: 'mode-select', cursor: 0 });
      } else if (key.downArrow) {
        setPhase({ type: 'mode-select', cursor: 1 });
      } else if (key.return) {
        const mode: Mode = phase.cursor === 0 ? 'global' : 'local';

        handleModeChosen(mode);
      }

      return;
    }

    if (phase.type === 'profile-select') {
      const { profiles, cursor } = phase;
      const addNewIdx = profiles.length;
      const totalItems = profiles.length + 1; // +1 for "Add new"

      if (key.upArrow) {
        setPhase({ ...phase, cursor: (cursor - 1 + totalItems) % totalItems });
      } else if (key.downArrow) {
        setPhase({ ...phase, cursor: (cursor + 1) % totalItems });
      } else if (key.return) {
        if (cursor === addNewIdx) {
          setPhase({ type: 'name-entry', nameBuffer: '', existingProfiles: profiles });
        } else {
          const selected = profiles[cursor] ?? profiles[0];

          if (selected) {
            void handleProfileChosen(selected);
          }
        }
      }

      return;
    }

    if (phase.type === 'name-entry') {
      const { nameBuffer, existingProfiles } = phase;

      if (key.backspace || key.delete) {
        setPhase({ type: 'name-entry', nameBuffer: nameBuffer.slice(0, -1), existingProfiles });
      } else if (key.return) {
        const trimmed = nameBuffer.trim();

        if (!trimmed) {
          setPhase({ ...phase, nameError: 'Name cannot be empty' });

          return;
        }

        if (trimmed === DEFAULT_PROFILE_NAME) {
          setPhase({ ...phase, nameError: `"${DEFAULT_PROFILE_NAME}" is reserved` });

          return;
        }

        if (existingProfiles.some((p) => p.name === trimmed)) {
          setPhase({ ...phase, nameError: `Profile "${trimmed}" already exists` });

          return;
        }

        // Valid name — proceed to empty creds-entry
        setActiveProfileName(trimmed);

        setPhase({ type: 'creds-entry', field: 0, values: {}, envCursor: 0 });

        setInputBuffer('');
      } else if (input && !key.ctrl && !key.meta) {
        setPhase({ type: 'name-entry', nameBuffer: nameBuffer + input, existingProfiles });
      }

      return;
    }

    if (phase.type === 'creds-entry') {
      const { field, values, envCursor } = phase;
      const isEnvField = field === FIELDS.length;

      if (isEnvField) {
        if (key.leftArrow) {
          setPhase({
            ...phase,
            envCursor: (envCursor - 1 + ENVIRONMENTS.length) % ENVIRONMENTS.length,
          });
        } else if (key.rightArrow) {
          setPhase({ ...phase, envCursor: (envCursor + 1) % ENVIRONMENTS.length });
        } else if (key.upArrow) {
          setPhase({ ...phase, field: field - 1 });

          setInputBuffer(values[FIELDS[field - 1] as keyof typeof values] ?? '');
        } else if (key.return) {
          void handleSave(values, envCursor);
        }

        return;
      }

      const fieldName = FIELDS[field];

      if (!fieldName) {
        return;
      }

      if (key.backspace || key.delete) {
        setInputBuffer((prev) => prev.slice(0, -1));
      } else if (key.upArrow && field > 0) {
        const updatedValues = { ...values, [fieldName]: inputBuffer };
        const prevField = field - 1;

        setPhase({ ...phase, field: prevField, values: updatedValues });

        setInputBuffer(updatedValues[FIELDS[prevField] as keyof typeof updatedValues] ?? '');
      } else if (key.return || key.tab || key.downArrow) {
        const updatedValues = { ...values, [fieldName]: inputBuffer };
        const nextField = field + 1;

        setPhase({ ...phase, field: nextField, values: updatedValues });

        if (nextField < FIELDS.length) {
          setInputBuffer(updatedValues[FIELDS[nextField] as keyof typeof updatedValues] ?? '');
        } else {
          setInputBuffer('');
        }
      } else if (input && !key.ctrl && !key.meta) {
        setInputBuffer((prev) => prev + input);
      }
    }
  });

  const loadProfileList = useCallback(async () => {
    const profiles = await listCredentialProfiles();

    setPhase({ type: 'profile-select', profiles, cursor: 0 });
  }, []);

  // Load profile list when entering profile-loading phase
  useEffect(() => {
    if (phase.type === 'profile-loading') {
      void loadProfileList();
    }
  }, [phase.type, loadProfileList]);

  // Handle initial mode without profile manager (existing behavior)
  useEffect(() => {
    if (initialMode === 'global' && !showProfileManager) {
      void (async () => {
        const existing = await loadGlobalCredentials();
        const envCursor = existing ? Math.max(0, ENVIRONMENTS.indexOf(existing.environment)) : 0;

        setPhase({ type: 'creds-entry', field: 0, values: existing ?? {}, envCursor });
      })();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset input buffer when switching to creds-entry
  useEffect(() => {
    if (phase.type === 'creds-entry' && phase.field === 0) {
      setInputBuffer(phase.values.apiKey ?? '');
    }
  }, [phase.type]); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase.type === 'loading' || phase.type === 'saving' || phase.type === 'profile-loading') {
    const label =
      phase.type === 'saving'
        ? 'Saving credentials…'
        : phase.type === 'profile-loading'
          ? 'Loading profiles…'
          : 'Loading credentials…';

    return (
      <Box paddingY={1} paddingX={2}>
        <Text dimColor>{label}</Text>
      </Box>
    );
  }

  if (phase.type === 'done') {
    return null;
  }

  if (phase.type === 'mode-select') {
    const options: { label: string; desc: string; mode: Mode }[] = [
      { label: 'Global', desc: `~/.kizenappbuilder/credentials.json`, mode: 'global' },
      { label: 'Local', desc: 'Enter credentials in the browser dev tools', mode: 'local' },
    ];

    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Box flexDirection="column" gap={0}>
          <Text bold>Credential mode</Text>
          {options.map((opt, i) => {
            const selected = phase.cursor === i;

            return (
              <Box key={opt.mode} gap={2}>
                <Text {...(selected && { color: 'cyan' as const })}>{selected ? '❯' : ' '}</Text>
                <Text bold={selected} {...(selected && { color: 'cyan' as const })}>
                  {opt.label}
                </Text>
                <Text dimColor>{opt.desc}</Text>
              </Box>
            );
          })}
        </Box>
        <Hint text="↑↓ to move · Enter to select · Ctrl+C to quit" />
      </Box>
    );
  }

  if (phase.type === 'profile-select') {
    const { profiles, cursor } = phase;
    const addNewIdx = profiles.length;

    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Box flexDirection="column" gap={0}>
          <Text bold>Credential profiles</Text>
          {profiles.map((profile, i) => {
            const selected = cursor === i;

            return (
              <Box key={profile.name} gap={2}>
                <Text {...(selected && { color: 'cyan' as const })}>{selected ? '❯' : ' '}</Text>
                <Text bold={selected} {...(selected && { color: 'cyan' as const })}>
                  {profile.isDefault ? 'Default' : profile.name}
                </Text>
                <Text dimColor>{profile.path}</Text>
              </Box>
            );
          })}
          <Box gap={2}>
            <Text {...(cursor === addNewIdx && { color: 'cyan' as const })}>
              {cursor === addNewIdx ? '❯' : ' '}
            </Text>
            <Text
              bold={cursor === addNewIdx}
              {...(cursor === addNewIdx && { color: 'cyan' as const })}
            >
              + Add new profile
            </Text>
          </Box>
        </Box>
        <Hint text="↑↓ to move · Enter to select · Esc to cancel" />
      </Box>
    );
  }

  if (phase.type === 'name-entry') {
    const { nameBuffer, nameError } = phase;

    return (
      <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
        <AppHeader />
        <Box flexDirection="column" gap={0}>
          <Text bold>New credential profile</Text>
        </Box>
        {nameError && <Text color="red">Error: {nameError}</Text>}
        <Box gap={2}>
          <Box width={12}>
            <Text bold color="cyan">
              Profile name
            </Text>
          </Box>
          <Text color="cyan">{'>'}</Text>
          <Text>{nameBuffer}</Text>
          <Text color="cyan">{'█'}</Text>
        </Box>
        <Hint text="Type a name · Enter to confirm · Esc to go back" />
      </Box>
    );
  }

  // creds-entry phase
  const { field: activeField, values, envCursor } = phase;
  const isEnvField = activeField === FIELDS.length;
  const profileLabel = activeProfileName ?? DEFAULT_PROFILE_NAME;

  return (
    <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
      <AppHeader />
      <Box flexDirection="column" gap={0}>
        <Text bold>
          {activeProfileName !== undefined ? `Profile: ${activeProfileName}` : 'Global credentials'}
        </Text>
        <Text dimColor>
          Saved to:{' '}
          {activeProfileName !== undefined
            ? `~/.kizenappbuilder/${activeProfileName}.json`
            : GLOBAL_CREDENTIALS_PATH}
        </Text>
      </Box>
      {error && <Text color="red">Error: {error}</Text>}
      <Box flexDirection="column" gap={0}>
        {FIELDS.map((name, i) => {
          const isActive = activeField === i;
          const displayValue = isActive ? inputBuffer : (values[name] ?? '');

          return (
            <Box key={name} gap={2}>
              <Box width={12}>
                <Text bold={isActive} {...(isActive && { color: 'cyan' as const })}>
                  {FIELD_LABELS[name]}
                </Text>
              </Box>
              <Text {...(isActive && { color: 'cyan' as const })}>{'>'}</Text>
              <Text>{displayValue}</Text>
              {isActive && <Text color="cyan">{'█'}</Text>}
            </Box>
          );
        })}
        <Box gap={2}>
          <Box width={12}>
            <Text bold={isEnvField} {...(isEnvField && { color: 'cyan' as const })}>
              Environment
            </Text>
          </Box>
          <Text {...(isEnvField && { color: 'cyan' as const })}>{'>'}</Text>
          <Box gap={1}>
            {ENVIRONMENTS.map((env, i) => {
              const isSelected = i === envCursor;

              if (isEnvField) {
                return (
                  <Text key={env} bold={isSelected} {...(isSelected && { color: 'cyan' as const })}>
                    {isSelected ? `[${env}]` : env}
                  </Text>
                );
              }

              return (
                <Text key={env} dimColor={!isSelected} bold={isSelected}>
                  {env}
                </Text>
              );
            })}
          </Box>
        </Box>
      </Box>
      {isEnvField ? (
        <Hint text="←→ to select · ↑↓ to move · Enter to save · Esc to cancel" />
      ) : (
        <Hint text="↑↓ to move · Backspace to delete · Esc to cancel" />
      )}
      <Text dimColor>Profile: {profileLabel}</Text>
    </Box>
  );
};
