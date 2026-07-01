import type { FC, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  listCredentialProfiles,
  loadCredentialProfile,
  loadCredentialsFromFile,
  loadGlobalCredentials,
} from '../lib/credentials.js';
import type { CredentialProfile, Credentials } from '../lib/credentials.js';
import { encryptSecret } from '../lib/encryptionClient.js';
import type { EncryptionContext } from '../lib/encryptionClient.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { AppHeader } from './AppHeader.js';
import { Spinner } from './Spinner.js';

interface EncryptUIProps {
  ctx: EncryptionContext;
  /** True when --stage was not given and the stage fell back to the prod default. */
  stageDefaulted?: boolean;
  /** Skip the profile picker and load from this file instead. */
  credentialsPath?: string;
  /** Provided via --api-name; skips the api_name prompt. */
  initialApiName?: string;
  /** Prefill for the api_name prompt (from kizen.json) — does not skip it. */
  defaultApiName?: string;
  /** Provided via --value; skips the secret prompt. */
  initialValue?: string;
  /** Called once with the base64 envelope value when encryption succeeds, so the
   * caller can write --out / emit it after ink unmounts. */
  onDone?: (envelopeValue: string) => void;
}

type Phase =
  | { type: 'loading' }
  | { type: 'profile-select'; profiles: CredentialProfile[]; cursor: number }
  | { type: 'api-name-entry'; buffer: string; error?: string }
  | { type: 'value-entry'; buffer: string; error?: string }
  | { type: 'fetching-key' }
  | { type: 'encrypting' }
  | { type: 'done'; envelope: string; copied: boolean }
  | { type: 'error'; message: string };

const Hint: FC<{ text: string }> = ({ text }) => <Text dimColor>{text}</Text>;

export const EncryptUI: FC<EncryptUIProps> = ({
  ctx,
  stageDefaulted,
  credentialsPath,
  initialApiName,
  defaultApiName,
  initialValue,
  onDone,
}) => {
  const app = useApp();
  const [phase, setPhase] = useState<Phase>({ type: 'loading' });
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [apiName, setApiName] = useState<string>(initialApiName ?? '');
  const [secret, setSecret] = useState<string>(initialValue ?? '');

  const fail = useCallback((err: unknown) => {
    process.exitCode = 1;
    // Exit is deferred to the terminal-phase effect below so the error frame is
    // actually painted before ink unmounts.
    setPhase({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }, []);

  const runEncryption = useCallback(
    async (creds: Credentials, name: string, value: string) => {
      try {
        const envelopeValue = await encryptSecret(ctx, creds, name, value, (p) => {
          setPhase(p === 'fetching-key' ? { type: 'fetching-key' } : { type: 'encrypting' });
        });
        const envelope = JSON.stringify({ encrypted: true, value: envelopeValue }, null, 2);

        onDone?.(envelopeValue);

        // Copy the envelope to the clipboard so the user can paste it without the
        // terminal's soft-wrapping becoming real line breaks in the copied text.
        // The envelope is ciphertext (never the plaintext secret), so this is
        // safe; the copy is best-effort and the envelope is shown either way.
        const copied = await copyToClipboard(envelope);

        // Exit is deferred to the terminal-phase effect below so the done frame
        // (with the envelope) is painted before ink unmounts.
        setPhase({ type: 'done', envelope, copied });
      } catch (err) {
        fail(err);
      }
    },
    [ctx, fail, onDone],
  );

  // Advance to the next required input, or kick off the encryption once we have
  // everything. Args are passed explicitly so we never read stale state.
  const proceed = useCallback(
    (creds: Credentials, name: string, value: string) => {
      if (name.trim() === '') {
        setPhase({ type: 'api-name-entry', buffer: defaultApiName ?? '' });

        return;
      }

      if (value === '') {
        setPhase({ type: 'value-entry', buffer: '' });

        return;
      }

      void runEncryption(creds, name.trim(), value);
    },
    [defaultApiName, runEncryption],
  );

  const handleProfileChosen = useCallback(
    async (profile: CredentialProfile) => {
      try {
        setPhase({ type: 'loading' });

        const creds = profile.isDefault
          ? await loadGlobalCredentials()
          : await loadCredentialProfile(profile.name);

        if (creds === null) {
          throw new Error(`Could not load credential profile: ${profile.name}`);
        }

        setCredentials(creds);
        proceed(creds, apiName, secret);
      } catch (err) {
        fail(err);
      }
    },
    [apiName, secret, proceed, fail],
  );

  // Resolve credentials on mount, then either show the picker or move on.
  useEffect(() => {
    void (async () => {
      try {
        if (credentialsPath !== undefined) {
          // loadCredentialsFromFile throws on a missing/invalid file; wrap it so
          // the error frame shows which path failed rather than a raw ENOENT.
          let creds: Credentials;

          try {
            creds = await loadCredentialsFromFile(credentialsPath);
          } catch (err) {
            throw new Error(
              `Could not load credentials from ${credentialsPath}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }

          setCredentials(creds);
          proceed(creds, apiName, secret);

          return;
        }

        const profiles = await listCredentialProfiles();

        if (profiles.length === 0) {
          throw new Error(
            'No credential profiles found. Create ~/.kizenappbuilder/credentials.json first.',
          );
        }

        const [only] = profiles;

        if (profiles.length === 1 && only !== undefined) {
          const creds = only.isDefault
            ? await loadGlobalCredentials()
            : await loadCredentialProfile(only.name);

          if (creds === null) {
            throw new Error(`Could not load credential profile: ${only.name}`);
          }

          setCredentials(creds);
          proceed(creds, apiName, secret);

          return;
        }

        setPhase({ type: 'profile-select', profiles, cursor: 0 });
      } catch (err) {
        fail(err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Exit only once a terminal frame has been committed and written to the
  // terminal. Calling app.exit() in the same tick as the setPhase would unmount
  // ink before it paints the done/error frame, leaving the spinner as the last
  // thing on screen.
  useEffect(() => {
    if (phase.type === 'done' || phase.type === 'error') {
      app.exit();
    }
  }, [phase, app]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      process.exitCode = 130;
      app.exit();

      return;
    }

    if (phase.type === 'profile-select') {
      const { profiles, cursor } = phase;

      if (key.upArrow) {
        setPhase({ ...phase, cursor: (cursor - 1 + profiles.length) % profiles.length });
      } else if (key.downArrow) {
        setPhase({ ...phase, cursor: (cursor + 1) % profiles.length });
      } else if (key.return) {
        // cursor is kept in range by the modulo above, so this is always defined.
        const selected = profiles[cursor];

        if (selected !== undefined) {
          void handleProfileChosen(selected);
        }
      }

      return;
    }

    if (phase.type === 'api-name-entry') {
      const { buffer } = phase;

      if (key.backspace || key.delete) {
        setPhase({ type: 'api-name-entry', buffer: buffer.slice(0, -1) });
      } else if (key.return) {
        const name = buffer.trim();

        if (name === '') {
          setPhase({ type: 'api-name-entry', buffer, error: 'api_name cannot be empty' });

          return;
        }

        setApiName(name);

        if (credentials) {
          proceed(credentials, name, secret);
        } else {
          fail(new Error('Internal error: credentials were not loaded'));
        }
      } else if (input && !key.ctrl && !key.meta) {
        setPhase({ type: 'api-name-entry', buffer: buffer + input });
      }

      return;
    }

    if (phase.type === 'value-entry') {
      const { buffer } = phase;

      if (key.backspace || key.delete) {
        setPhase({ type: 'value-entry', buffer: buffer.slice(0, -1) });
      } else if (key.return) {
        if (buffer === '') {
          setPhase({ type: 'value-entry', buffer, error: 'secret cannot be empty' });

          return;
        }

        setSecret(buffer);

        if (credentials) {
          proceed(credentials, apiName, buffer);
        } else {
          fail(new Error('Internal error: credentials were not loaded'));
        }
      } else if (input && !key.ctrl && !key.meta) {
        setPhase({ type: 'value-entry', buffer: buffer + input });
      }

      return;
    }
  });

  const modeLabel = ctx.isRemote ? 'remote Kizen API' : 'on-machine';

  const stageLabel = stageDefaulted === true ? `${ctx.stage} (default)` : ctx.stage;

  const frame = (children: ReactNode): ReactNode => (
    <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
      <AppHeader />
      <Text dimColor>
        Mode: {modeLabel} Stage: {stageLabel}
      </Text>
      {children}
    </Box>
  );

  if (phase.type === 'loading') {
    return frame(
      <Box gap={1}>
        <Spinner />
        <Text dimColor>Loading credentials…</Text>
      </Box>,
    );
  }

  if (phase.type === 'profile-select') {
    const { profiles, cursor } = phase;

    return frame(
      <>
        <Text bold>Credential profile</Text>
        <Box flexDirection="column">
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
        </Box>
        <Hint text="↑↓ to move · Enter to select · Ctrl+C to quit" />
      </>,
    );
  }

  if (phase.type === 'api-name-entry') {
    return frame(
      <>
        <Text bold>Plugin api_name</Text>
        {phase.error !== undefined && <Text color="red">Error: {phase.error}</Text>}
        <Box gap={1}>
          <Text color="cyan">{'>'}</Text>
          <Text>{phase.buffer}</Text>
          <Text color="cyan">█</Text>
        </Box>
        <Hint text="Type the api_name · Enter to confirm · Ctrl+C to quit" />
      </>,
    );
  }

  if (phase.type === 'value-entry') {
    return frame(
      <>
        <Text bold>Secret value</Text>
        {phase.error !== undefined && <Text color="red">Error: {phase.error}</Text>}
        <Box gap={1}>
          <Text color="cyan">{'>'}</Text>
          <Text>{'•'.repeat(phase.buffer.length)}</Text>
          <Text color="cyan">█</Text>
        </Box>
        <Hint text="Input hidden · Enter to encrypt · Ctrl+C to quit" />
      </>,
    );
  }

  if (phase.type === 'fetching-key') {
    return frame(
      <Box gap={1}>
        <Spinner />
        <Text>
          Fetching {ctx.stage} public key for <Text bold>{apiName}</Text>…
        </Text>
      </Box>,
    );
  }

  if (phase.type === 'encrypting') {
    return frame(
      <Box gap={1}>
        <Spinner />
        <Text>Encrypting…</Text>
      </Box>,
    );
  }

  if (phase.type === 'error') {
    return frame(
      <Box gap={1}>
        <Text color="red">✗</Text>
        <Text color="red">{phase.message}</Text>
      </Box>,
    );
  }

  // phase.type === 'done'
  return frame(
    <>
      <Box gap={1}>
        <Text color="green">✓</Text>
        <Text bold>Encrypted secret ready</Text>
      </Box>
      {phase.copied ? (
        <Text color="green">
          ✓ Copied to clipboard — paste it into the secret value in your kizen.json.
        </Text>
      ) : (
        <Text dimColor>
          {'Paste this into the secret value in your kizen.json (re-run with --out <path> to save ' +
            'it to a file; selecting it here may capture line wraps):'}
        </Text>
      )}
      <Text>{phase.envelope}</Text>
    </>,
  );
};
