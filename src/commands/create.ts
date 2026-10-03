import { createElement } from 'react';
import { render } from 'ink';
import type { Command } from 'commander';
import { CreateUI } from '../ui/CreateUI.js';
import { loadGlobalCredentials } from '../lib/credentials.js';
import { createPlugin, precheckTargetDir } from '../lib/createPlugin.js';
import { hasNonInteractiveFlags, runHeadlessCreate } from '../lib/createHeadless.js';
import type { CreateOptions } from '../lib/createHeadless.js';
import { ARTIFACT_TYPES } from '../lib/createArtifacts.js';
import { ENVIRONMENTS } from '../../shared/lib/credentials.js';

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
      '-e, --environment <env>',
      `environment the business id belongs to: ${ENVIRONMENTS.join(', ')} (defaults to saved credentials)`,
    )
    .option(
      '--artifacts <list>',
      `comma-separated artifact types, or "all" / "none" (default: all). Types: ${ARTIFACT_TYPES.join(', ')}`,
    )
    .option('--include-lib', 'also install the Kizen data helper library (src/lib/kizenData.js)')
    .action(async (options: CreateOptions) => {
      const parentDir = process.cwd();
      const globalCreds = await loadGlobalCredentials();
      const defaultBusinessId = globalCreds?.businessId ?? '';
      const defaultEnvironment = globalCreds?.environment ?? 'go';

      const isNonInteractive =
        !process.stdin.isTTY || !process.stdout.isTTY || hasNonInteractiveFlags(options);

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
        createElement(CreateUI, {
          parentDir,
          defaultBusinessId,
          defaultEnvironment,
          includeLib: options.includeLib === true,
        }),
        { exitOnCtrlC: false },
      );

      await waitUntilExit();
    });
}
