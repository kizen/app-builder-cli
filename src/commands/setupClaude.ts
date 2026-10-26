import type { Command } from 'commander';
import {
  createDefaultSetupClaudeDeps,
  runSetupClaude,
  type SetupClaudeOptions,
} from '../lib/setupClaude.js';

/** `version` is the program's (`createProgram` reads it from package.json); the MCP helper pins it. */
export function setupClaudeCommand(program: Command, version: string): void {
  program
    .command('setup-claude')
    .description(
      'Install or refresh the Claude Code files in a plugin, or with --mcp only register the Kizen MCP server',
    )
    .option('--dry-run', 'report what would change without writing files')
    .option(
      '--include-lib',
      'also install the Kizen data helper library (<entry>/lib/kizenData.js)',
    )
    .option(
      '--mcp',
      'only register the Kizen MCP server in Claude Code (user scope); writes no files, so it works in any directory',
    )
    .option('--env <env>', 'environment of the MCP server to register (with --mcp; default: go)')
    .option('--force', 'replace an existing Kizen MCP server registration (with --mcp)')
    .action(async (options: SetupClaudeOptions) => {
      await runSetupClaude(process.cwd(), options, createDefaultSetupClaudeDeps(version));
    });
}
