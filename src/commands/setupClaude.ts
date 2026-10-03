import type { Command } from 'commander';
import { runSetupClaude } from '../lib/setupClaude.js';

export function setupClaudeCommand(program: Command): void {
  program
    .command('setup-claude')
    .description('Install or refresh the Claude Code skill for building custom blocks')
    .option('--dry-run', 'report what would change without writing files')
    .option(
      '--include-lib',
      'also install the Kizen data helper library (<entry>/lib/kizenData.js)',
    )
    .action(async (options: { dryRun?: boolean; includeLib?: boolean }) => {
      await runSetupClaude(process.cwd(), options);
    });
}
