import { createElement } from 'react';
import { render } from 'ink';
import type { Command } from 'commander';
import { EncryptUI } from '../ui/EncryptUI.js';
import { encryptSecret } from '../lib/encryptionClient.js';
import type { EncryptionContext } from '../lib/encryptionClient.js';
import { loadCredentialsFromFile, loadGlobalCredentials } from '../lib/credentials.js';
import {
  invalidStageMessage,
  isValidStage,
  readManifestDefaults,
  readStdin,
  resolveStage,
  writeEnvelopeFile,
  type ManifestDefaults,
} from '../lib/encryptHelpers.js';
import { runHeadless } from '../lib/encryptHeadless.js';

interface EncryptOptions {
  remote?: boolean;
  credentials?: string;
  apiName?: string;
  value?: string;
  stage?: string;
  out?: string;
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
      if (options.stage !== undefined && !isValidStage(options.stage)) {
        console.error(invalidStageMessage(options.stage));
        process.exit(1);
      }

      // Read kizen.json for the api_name default. Skip the file read entirely
      // when api_name is already supplied via a flag.
      const needsDefaults = options.apiName === undefined;
      const defaults: ManifestDefaults = needsDefaults ? await readManifestDefaults() : {};

      // Default to prod when --stage isn't given (almost every plugin ships to
      // production); pass --stage dev to override.
      const { stage, wasDefaulted: stageWasDefaulted } = resolveStage(options.stage);

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
          await runHeadless(ctx, options, defaults, stageWasDefaulted, {
            loadCredentialsFromFile,
            loadGlobalCredentials,
            encryptSecret,
            readStdin,
            stdinIsTTY: () => process.stdin.isTTY,
            writeStdout: (text) => {
              process.stdout.write(text);
            },
            writeStderr: (text) => {
              process.stderr.write(text);
            },
            writeEnvelopeFile,
            setExitCode: (code) => {
              process.exitCode = code;
            },
          });
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
