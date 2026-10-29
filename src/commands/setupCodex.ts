import type { Command } from 'commander';
import {
  createDefaultSetupCodexDeps,
  runSetupCodex,
  type SetupCodexOptions,
} from '../lib/setupCodex.js';

export function setupCodexCommand(program: Command): void {
  program
    .command('setup-codex')
    .description('Install or refresh the Codex skills (.agents/skills) in a plugin')
    .option('--dry-run', 'report what would change without writing files')
    .option(
      '--include-lib',
      'also install the Kizen data helper library (<entry>/lib/kizenData.js)',
    )
    .action(async (options: SetupCodexOptions) => {
      await runSetupCodex(process.cwd(), options, createDefaultSetupCodexDeps());
    });
}
