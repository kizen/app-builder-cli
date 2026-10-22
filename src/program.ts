import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { adminCommand } from './commands/admin.js';
import { authCommands } from './commands/auth.js';
import { blockCommand } from './commands/block.js';
import { buildCommand } from './commands/build.js';
import { createCommand } from './commands/create.js';
import { devCommand } from './commands/dev.js';
import { encryptCommand } from './commands/encrypt.js';
import { iconsCommand } from './commands/icons.js';
import { reportCommand } from './commands/report.js';
import { setupClaudeCommand } from './commands/setupClaude.js';
import { setupCopilotCommand } from './commands/setupCopilot.js';

function readVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

  return pkg.version;
}

export function createProgram(): Command {
  const program = new Command();
  const version = readVersion();

  program.name('appbuilder').description('Kizen plugin app builder').version(version);

  createCommand(program);

  setupClaudeCommand(program, version);

  setupCopilotCommand(program);

  buildCommand(program);

  devCommand(program);

  encryptCommand(program);

  reportCommand(program);

  iconsCommand(program);

  blockCommand(program);

  authCommands(program);

  adminCommand(program);

  return program;
}
