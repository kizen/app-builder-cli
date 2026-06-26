import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { program } from 'commander';
import { buildCommand } from './commands/build.js';
import { createCommand } from './commands/create.js';
import { devCommand } from './commands/dev.js';
import { encryptCommand } from './commands/encrypt.js';
import { iconsCommand } from './commands/icons.js';
import { reportCommand } from './commands/report.js';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

program.name('appbuilder').description('Kizen plugin app builder').version(pkg.version);

createCommand(program);

buildCommand(program);

devCommand(program);

encryptCommand(program);

reportCommand(program);

iconsCommand(program);

program.parse();
