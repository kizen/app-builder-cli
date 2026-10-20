import type { Command } from 'commander';
import {
  createDefaultAuthCommandDeps,
  runAuthHeader,
  runLogin,
  runLogout,
  runWhoami,
  type AuthCommand,
} from '../lib/oauthCommands.js';

/** Each command: its name, description, what its --env option means, and what it runs. */
const AUTH_COMMANDS: [string, string, string, AuthCommand][] = [
  [
    'login',
    'Sign in to Kizen in the browser and store the session on this machine',
    'environment to sign in to (default: go)',
    runLogin,
  ],
  [
    'logout',
    'Remove the stored session from this machine',
    'environment to sign out of (default: the only signed-in one)',
    runLogout,
  ],
  [
    'whoami',
    'Show the user and business of the stored session',
    'environment to check (default: the only signed-in one)',
    runWhoami,
  ],
  [
    'auth-header',
    'Print an Authorization header for the stored session as JSON (for a Claude Code MCP headersHelper)',
    'environment to use; must match CLAUDE_CODE_MCP_SERVER_URL when that is set (default: the environment matching it, else the only signed-in one)',
    runAuthHeader,
  ],
];

export function authCommands(program: Command): void {
  for (const [name, description, env, run] of AUTH_COMMANDS) {
    program
      .command(name)
      .description(description)
      .option('--env <env>', env)
      .action(async (options: { env?: string }) => {
        await run(options, createDefaultAuthCommandDeps());
      });
  }
}
