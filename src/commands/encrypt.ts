import { createElement } from 'react';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from 'ink';
import type { Command } from 'commander';
import { EncryptUI } from '../ui/EncryptUI.js';
import { encryptSecret } from '../lib/encryptionClient.js';
import type { EncryptionContext } from '../lib/encryptionClient.js';
import { loadCredentialsFromFile, loadGlobalCredentials } from '../lib/credentials.js';

interface EncryptOptions {
  remote?: boolean;
  credentials?: string;
  apiName?: string;
  value?: string;
  stage?: string;
  out?: string;
}

/** The envelope object that gets pasted into a kizen.json secret value. */
function envelopeObject(value: string): { encrypted: true; value: string } {
  return { encrypted: true, value };
}

/** Single-line JSON for stdout/pipes — no whitespace, so a redirect captures it
 * on one line with no chance of embedded line breaks. */
function compactEnvelope(value: string): string {
  return JSON.stringify(envelopeObject(value));
}

/** Writes the envelope to a file as pretty JSON. The file's newlines are real
 * and intentional (the base64 `value` stays on one line), so copying the value
 * out of the file never picks up terminal soft-wraps. */
async function writeEnvelopeFile(path: string, value: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(envelopeObject(value), null, 2)}\n`, 'utf-8');
}

/** Fields read from kizen.json to prefill defaults. */
interface ManifestDefaults {
  apiName?: string;
}

/** The encryption stage used when --stage isn't given. Almost every plugin ships
 * to production, so prod is the right default; pass --stage dev to override.
 * Mirrors DEFAULT_ENCRYPTION_TARGET in viewer/src/lib/encryptionTarget.ts. */
const DEFAULT_STAGE: 'dev' | 'prod' = 'prod';

/**
 * Reads api_name from kizen.json in the cwd, if present, to prefill the
 * api_name prompt.
 */
async function readManifestDefaults(): Promise<ManifestDefaults> {
  try {
    const raw = await readFile(join(process.cwd(), 'kizen.json'), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const manifest = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;

    const apiName =
      typeof manifest.api_name === 'string' && manifest.api_name !== ''
        ? manifest.api_name
        : undefined;

    return {
      ...(apiName !== undefined && { apiName }),
    };
  } catch {
    // Not in a plugin directory — fine, the UI will prompt with no defaults.
  }

  return {};
}

/** Reads all of stdin (used as the secret when piped in non-interactive mode). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Non-interactive path for pipes/CI (no TTY, so ink's raw-mode input can't run).
 * Everything must come from flags; the secret may also be piped via stdin. The
 * encrypted envelope is written to stdout so it can be redirected or captured.
 */
async function runHeadless(
  ctx: EncryptionContext,
  options: EncryptOptions,
  defaults: ManifestDefaults,
  stageWasDefaulted: boolean,
): Promise<void> {
  const credentials =
    options.credentials !== undefined
      ? await loadCredentialsFromFile(options.credentials)
      : await loadGlobalCredentials();

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
    process.stderr.write(
      `No --stage given; defaulting to ${ctx.stage} encryption keys (pass --stage dev to override)\n`,
    );
  }

  // Prefer --value; otherwise accept the secret piped on stdin. Piping is the
  // safer option because --value leaks the secret into the process list (ps).
  // Announce the read so a stalled stdin (an open pipe with no input) isn't a
  // silent hang — the common CI cases (/dev/null, closed pipe) EOF immediately.
  let value = options.value;

  if (value === undefined) {
    // Reading from a TTY here would block forever waiting for the user to type +
    // EOF. That happens when stdout is piped/redirected (so we took the headless
    // path) but stdin is still the terminal, e.g. `appbuilder encrypt | jq`.
    // Fail fast with guidance instead of appearing to hang.
    if (process.stdin.isTTY) {
      throw new Error(
        'No secret provided and stdin is a terminal. Pass --value, or pipe the secret in ' +
          '(e.g. `printf %s "$SECRET" | npx --yes @kizenapps/cli encrypt …`).',
      );
    }

    process.stderr.write('Reading secret from stdin (pass --value to skip)…\n');

    // Strip trailing CR/LF (handles \n, \r\n, and a lone \r) like shell $(...).
    value = (await readStdin()).replace(/[\r\n]+$/, '');
  }

  if (value === '') {
    throw new Error('A secret value is required. Pass --value or pipe it via stdin.');
  }

  const envelopeValue = await encryptSecret(ctx, credentials, apiName.trim(), value);

  // Emit the envelope on stdout FIRST so the pipe/redirect contract always holds,
  // even if the optional --out write fails afterward.
  process.stdout.write(`${compactEnvelope(envelopeValue)}\n`);

  if (options.out !== undefined) {
    try {
      await writeEnvelopeFile(options.out, envelopeValue);
      process.stderr.write(`Wrote encrypted envelope to ${options.out}\n`);
    } catch (err) {
      // Don't re-throw: stdout already carries the envelope, so a failed --out
      // is a non-fatal warning (signalled via exit code) rather than data loss.
      process.stderr.write(
        `Error writing ${options.out}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  }
}

export function encryptCommand(program: Command): void {
  program
    .command('encrypt')
    .description('Encrypt a secret for a plugin against its encryption keys')
    .option('--remote', "encrypt via the plugin-wizard's remote API instead of on-machine")
    .option('-c, --credentials <path>', 'path to a credentials JSON file')
    .option('-a, --api-name <name>', 'plugin api_name the secret belongs to')
    .option('-v, --value <value>', 'plaintext secret value to encrypt')
    .option('-s, --stage <stage>', 'which encryption API to use: dev or prod (default: prod)')
    .option('-o, --out <path>', 'also write the encrypted envelope to a file')
    .action(async (options: EncryptOptions) => {
      if (options.stage !== undefined && options.stage !== 'dev' && options.stage !== 'prod') {
        console.error(`Error: --stage must be "dev" or "prod" (got: "${options.stage}")`);
        process.exit(1);
      }

      // Read kizen.json for the api_name default. Skip the file read entirely
      // when api_name is already supplied via a flag.
      const needsDefaults = options.apiName === undefined;
      const defaults = needsDefaults ? await readManifestDefaults() : {};

      // Default to prod when --stage isn't given (almost every plugin ships to
      // production); pass --stage dev to override.
      const stageWasDefaulted = options.stage === undefined;
      const stage: 'dev' | 'prod' =
        options.stage === 'dev' || options.stage === 'prod' ? options.stage : DEFAULT_STAGE;

      const ctx: EncryptionContext = {
        isRemote: options.remote === true,
        stage,
      };

      // ink's interactive UI needs a TTY for raw-mode input AND a TTY stdout to
      // render into. If either is redirected/piped (CI, `> out.json`, `| jq`),
      // fall back to the headless flow so stdout gets clean compact JSON instead
      // of ANSI frames.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        try {
          await runHeadless(ctx, options, defaults, stageWasDefaulted);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        return;
      }

      // The UI copies to the clipboard itself; we capture the raw value here so
      // that after ink unmounts we can write --out (ink's rendered frame
      // soft-wraps the long base64, so we never read the envelope back off it).
      let envelopeValue: string | undefined;

      const { waitUntilExit } = render(
        createElement(EncryptUI, {
          ctx,
          stageDefaulted: stageWasDefaulted,
          onDone: (value: string) => {
            envelopeValue = value;
          },
          ...(options.credentials !== undefined && { credentialsPath: options.credentials }),
          ...(options.apiName !== undefined && { initialApiName: options.apiName }),
          ...(defaults.apiName !== undefined && { defaultApiName: defaults.apiName }),
          ...(options.value !== undefined && { initialValue: options.value }),
        }),
        { exitOnCtrlC: false },
      );

      await waitUntilExit();

      // envelopeValue is only set on success (onDone); stays undefined on Ctrl+C
      // or error, so nothing is written in those cases.
      if (envelopeValue !== undefined && options.out !== undefined) {
        try {
          await writeEnvelopeFile(options.out, envelopeValue);
          process.stderr.write(`Wrote encrypted envelope to ${options.out}\n`);
        } catch (err) {
          console.error(
            `Error writing ${options.out}: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 1;
        }
      }
    });
}
