import { createElement } from 'react';
import { render } from 'ink';
import type { Command } from 'commander';
import { CreateUI } from '../ui/CreateUI.js';
import { loadGlobalCredentials } from '../lib/credentials.js';
import { createPlugin, precheckTargetDir } from '../lib/createPlugin.js';
import { runHeadlessCreate } from '../lib/createHeadless.js';
import type { CreateOptions } from '../lib/createHeadless.js';
import { ARTIFACT_TYPES } from '../lib/createArtifacts.js';

export function createCommand(program: Command): void {
  program
    .command('create')
    .description('Scaffold a new Kizen plugin project')
    .option('-n, --name <name>', 'plugin display name (implies a non-interactive run)')
    .option('-a, --api-name <name>', 'plugin api_name (inferred from --name when omitted)')
    .option('-d, --description <text>', 'plugin description')
    .option('-l, --external-link <url>', 'external link shown on the plugin listing')
    .option('-b, --business-id <id>', 'developer business id (defaults to saved credentials)')
    .option(
      '--artifacts <list>',
      `comma-separated artifact types, or "all" / "none" (default: all). Types: ${ARTIFACT_TYPES.join(', ')}`,
    )
    .action(async (options: CreateOptions) => {
      const parentDir = process.cwd();
      const globalCreds = await loadGlobalCredentials();
      const defaultBusinessId = globalCreds?.businessId ?? '';
      // The business id is only valid in the environment it was issued for, so
      // the manifest keys it by that environment rather than emitting a bare
      // string. `parseCredentials` already defaults this to 'go'.
      const defaultEnvironment = globalCreds?.environment ?? 'go';

      // ink's interactive UI needs a TTY for raw-mode input AND a TTY stdout to
      // render into. If either is redirected/piped (CI, `| tee`), fall back to
      // the headless flow, as `encrypt` does.
      //
      // ANY flag also counts as scripted intent. Checking only --name would let
      // `create --api-name foo` open a prompt that silently discards the flag;
      // going headless instead surfaces a real error naming what's missing.
      const suppliedFlags = Object.values(options).some((value) => value !== undefined);

      const isNonInteractive = !process.stdin.isTTY || !process.stdout.isTTY || suppliedFlags;

      if (isNonInteractive) {
        await runHeadlessCreate(
          options,
          { businessId: defaultBusinessId, environment: defaultEnvironment },
          parentDir,
          {
            precheckTargetDir,
            createPlugin,
            writeStdout: (text) => {
              process.stdout.write(text);
            },
            writeStderr: (text) => {
              process.stderr.write(text);
            },
            setExitCode: (code) => {
              process.exitCode = code;
            },
          },
        );

        return;
      }

      const { waitUntilExit } = render(
        createElement(CreateUI, { parentDir, defaultBusinessId, defaultEnvironment }),
        { exitOnCtrlC: false },
      );

      await waitUntilExit();
    });
}
