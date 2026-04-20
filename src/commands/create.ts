import { createElement } from 'react';
import { render } from 'ink';
import type { Command } from 'commander';
import { CreateUI } from '../ui/CreateUI.js';
import { loadGlobalCredentials } from '../lib/credentials.js';

export function createCommand(program: Command): void {
  program
    .command('create')
    .description('Scaffold a new Kizen plugin project')
    .action(async () => {
      const parentDir = process.cwd();
      const globalCreds = await loadGlobalCredentials();
      const defaultBusinessId = globalCreds?.businessId ?? '';

      const { waitUntilExit } = render(createElement(CreateUI, { parentDir, defaultBusinessId }), {
        exitOnCtrlC: false,
      });

      await waitUntilExit();
    });
}
