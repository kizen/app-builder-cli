import type { EncryptionContext } from './encryptionClient.js';
import type { Credentials } from './credentials.js';
import type { ManifestDefaults } from './encryptHelpers.js';
import { compactEnvelope, defaultStageNotice, stripTrailingNewlines } from './encryptHelpers.js';

export interface HeadlessEncryptOptions {
  credentials?: string;
  apiName?: string;
  value?: string;
  out?: string;
}

export interface HeadlessEncryptDeps {
  loadCredentialsFromFile: (path: string) => Promise<Credentials>;
  loadGlobalCredentials: () => Promise<Credentials | null>;
  encryptSecret: (
    ctx: EncryptionContext,
    credentials: Credentials,
    apiName: string,
    value: string,
  ) => Promise<string>;
  readStdin: () => Promise<string>;
  stdinIsTTY: () => boolean;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  writeEnvelopeFile: (path: string, value: string) => Promise<void>;
  setExitCode: (code: number) => void;
}

export async function runHeadless(
  ctx: EncryptionContext,
  options: HeadlessEncryptOptions,
  defaults: ManifestDefaults,
  stageWasDefaulted: boolean,
  deps: HeadlessEncryptDeps,
): Promise<void> {
  const credentials =
    options.credentials !== undefined
      ? await deps.loadCredentialsFromFile(options.credentials)
      : await deps.loadGlobalCredentials();

  if (credentials === null) {
    throw new Error(
      'No credentials found. Pass --credentials or create ~/.kizenappbuilder/credentials.json.',
    );
  }

  const apiName = options.apiName ?? defaults.apiName;

  if (apiName === undefined || apiName.trim() === '') {
    throw new Error(
      'api_name is required in non-interactive mode. Pass --api-name or run inside a plugin directory.',
    );
  }

  if (stageWasDefaulted) {
    deps.writeStderr(defaultStageNotice(ctx.stage));
  }

  let value = options.value;

  if (value === undefined) {
    if (deps.stdinIsTTY()) {
      throw new Error(
        'No secret provided and stdin is a terminal. Pass --value, or pipe the secret in ' +
          '(e.g. `printf %s "$SECRET" | npx --yes @kizenapps/cli encrypt …`).',
      );
    }

    deps.writeStderr('Reading secret from stdin (pass --value to skip)…\n');

    value = stripTrailingNewlines(await deps.readStdin());
  }

  if (value === '') {
    throw new Error('A secret value is required. Pass --value or pipe it via stdin.');
  }

  const envelopeValue = await deps.encryptSecret(ctx, credentials, apiName.trim(), value);

  deps.writeStdout(`${compactEnvelope(envelopeValue)}\n`);

  if (options.out !== undefined) {
    try {
      await deps.writeEnvelopeFile(options.out, envelopeValue);
      deps.writeStderr(`Wrote encrypted envelope to ${options.out}\n`);
    } catch (err) {
      deps.writeStderr(
        `Error writing ${options.out}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      deps.setExitCode(1);
    }
  }
}
