import type { Command } from 'commander';
import { ALL_VALID_ICONS_LIST } from '../../shared/lib/validIcons.js';

export function iconsCommand(program: Command): void {
  program
    .command('icons')
    .description('List all valid icon names accepted by toolbar items, pages, and adornments')
    .action(() => {
      for (const name of ALL_VALID_ICONS_LIST) {
        console.log(name);
      }
    });
}
