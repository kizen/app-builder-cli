import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { buildCommand } from './commands/build.js';
import { createCommand } from './commands/create.js';
import { devCommand } from './commands/dev.js';
import { encryptCommand } from './commands/encrypt.js';
import { iconsCommand } from './commands/icons.js';
import { reportCommand } from './commands/report.js';

function readVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

  return pkg.version;
}

export function createProgram(): Command {
  const program = new Command();

  program.name('appbuilder').description('Kizen plugin app builder').version(readVersion());

  createCommand(program);

  buildCommand(program);

  devCommand(program);

  encryptCommand(program);

  reportCommand(program);

  iconsCommand(program);

  return program;
}
