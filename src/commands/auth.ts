import type { Command } from 'commander';
import {
  createDefaultAuthCommandDeps,
  runAuthHeader,
  runLogin,
  runLogout,
  type AuthCommand,
  type AuthCommandOptions,
} from '../lib/oauthCommands.js';
import { runWhoamiCommand } from '../lib/whoamiCommand.js';
import { NO_INTERACTIVE_HELP, takeInteractiveFlag, type Interactive } from '../lib/interactive.js';
import { pickInTerminal } from '../ui/AccountPicker.js';

interface AuthCommandSpec {
  name: string;
  description: string;
  /** What --env means for this command. */
  env: string;
  /** Options besides --env: flags and description. */
  options?: [flags: string, description: string][];
  run: AuthCommand<AuthCommandOptions & Record<string, unknown>>;
}

const AUTH_COMMANDS: AuthCommandSpec[] = [
  {
    name: 'login',
    description:
      'Sign in to Kizen in the browser, or switch to a saved account, and store the session on this machine',
    env: 'environment to sign in to (default: go)',
    options: [
      [
        '--business <id-or-name>',
        'switch to the saved account with this business id, or business name (ignoring case); signs in with the browser if none matches or it expired',
      ],
      ['--user <userId>', 'with --business, pick the saved account of this user id'],
      ['--list', 'list the saved accounts for the environment and exit'],
      ['--json', 'with --list, print the accounts as JSON'],
      ['--no-interactive', NO_INTERACTIVE_HELP],
    ],
    run: runLogin,
  },
  {
    name: 'logout',
    description: 'Remove the stored session from this machine',
    env: 'environment to sign out of (default: the only signed-in one)',
    options: [
      ['--all', 'also remove every other saved account for the environment'],
      [
        '--business <id-or-name>',
        'remove only this saved account, by business id or name (ignoring case)',
      ],
      ['--user <userId>', 'with --business, remove the saved account of this user id'],
    ],
    run: runLogout,
  },
  {
    name: 'whoami',
    description: 'Show the user and business of the stored session',
    env: "environment to check (default: the only signed-in one, or with --business the only one where it's saved)",
    options: [
      [
        '--business <id-or-name>',
        'check this saved account, by business id or name (ignoring case), instead of the current one (default: $APPBUILDER_BUSINESS)',
      ],
      [
        '--user <userId>',
        'with --business, check the saved account of this user id (default: $APPBUILDER_USER)',
      ],
      ['--json', 'print the identity as JSON'],
    ],
    run: runWhoamiCommand,
  },
  {
    name: 'auth-header',
    description:
      'Print an Authorization header for the stored session as JSON (for a Claude Code MCP headersHelper)',
    env: 'environment to use; must match CLAUDE_CODE_MCP_SERVER_URL when that is set (default: the environment matching it, else the only signed-in one)',
    options: [
      ['--business <id>', 'with --user, use this saved account, current or not'],
      ['--user <userId>', 'with --business, the user id of that account'],
    ],
    run: runAuthHeader,
  },
];

export function authCommands(program: Command): void {
  for (const { name, description, env, options = [], run } of AUTH_COMMANDS) {
    const command = program.command(name).description(description).option('--env <env>', env);

    for (const [flags, text] of options) {
      command.option(flags, text);
    }

    command.action(async (parsed: AuthCommandOptions & Interactive & Record<string, unknown>) => {
      // Only `login` declares --no-interactive; elsewhere `interactive` is unset.
      const { noInteractive, options } = takeInteractiveFlag(parsed);

      await run(options, createDefaultAuthCommandDeps(undefined, pickInTerminal, noInteractive));
    });
  }
}
