import type { Command } from 'commander';
import {
  createDefaultAuthCommandDeps,
  runAuthHeader,
  runLogin,
  runLogout,
  runWhoami,
} from '../lib/oauthCommands.js';

interface EnvOption {
  env?: string;
}

export function authCommands(program: Command): void {
  program
    .command('login')
    .description('Sign in to Kizen in the browser and store the session on this machine')
    .option('--env <env>', 'environment to sign in to (default: go)')
    .action(async (options: EnvOption) => {
      await runLogin(options, createDefaultAuthCommandDeps());
    });

  program
    .command('logout')
    .description('Remove the stored session from this machine')
    .option('--env <env>', 'environment to sign out of (default: the only signed-in one)')
    .action(async (options: EnvOption) => {
      await runLogout(options, createDefaultAuthCommandDeps());
    });

  program
    .command('whoami')
    .description('Show the user and business of the stored session')
    .option('--env <env>', 'environment to check (default: the only signed-in one)')
    .action(async (options: EnvOption) => {
      await runWhoami(options, createDefaultAuthCommandDeps());
    });

  program
    .command('auth-header')
    .description(
      'Print an Authorization header for the stored session as JSON (for a Claude Code MCP headersHelper)',
    )
    .option(
      '--env <env>',
      'environment to use; must match CLAUDE_CODE_MCP_SERVER_URL when that is set (default: the environment matching it, else the only signed-in one)',
    )
    .action(async (options: EnvOption) => {
      await runAuthHeader(options, createDefaultAuthCommandDeps());
    });
}
