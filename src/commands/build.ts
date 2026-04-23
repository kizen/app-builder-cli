import { createElement } from 'react';
import { render } from 'ink';
import type { Command } from 'commander';
import { BuildUI } from '../ui/BuildUI.js';
import { ensureGitignore } from '../lib/gitignore.js';

export function buildCommand(program: Command): void {
  program
    .command('build')
    .description('Bundle the plugin app into .kizenapp directory')
    .action(async () => {
      const pluginDir = process.cwd();
      const outputDir = `${pluginDir}/.kizenapp`;

      ensureGitignore(pluginDir);

      const { waitUntilExit } = render(createElement(BuildUI, { outputDir, pluginDir }));

      await waitUntilExit();
    });
}
