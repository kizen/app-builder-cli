import type { Command } from 'commander';
import {
  defaultSetupClaudeDeps,
  runSetupClaude,
  type SetupClaudeDeps,
  type SetupClaudeOptions,
} from '../lib/setupClaude.js';

/**
 * The default deps plus the CLI's version, taken from the program (`createProgram`
 * sets it from package.json), so the MCP helper is pinned to the running CLI.
 */
export const setupClaudeDepsFor = (program: Command): SetupClaudeDeps => ({
  ...defaultSetupClaudeDeps,
  cliVersion: program.version(),
});

export function setupClaudeCommand(program: Command): void {
  program
    .command('setup-claude')
    .description('Install or refresh the Claude Code skill for building custom blocks')
    .option('--dry-run', 'report what would change without writing files')
    .option(
      '--include-lib',
      'also install the Kizen data helper library (<entry>/lib/kizenData.js)',
    )
    .option('--mcp', 'also register the Kizen MCP server in Claude Code (user scope)')
    .option('--env <env>', 'environment of the MCP server to register (with --mcp; default: go)')
    .option('--force', 'replace an existing Kizen MCP server registration (with --mcp)')
    .action(async (options: SetupClaudeOptions) => {
      await runSetupClaude(process.cwd(), options, setupClaudeDepsFor(program));
    });
}
