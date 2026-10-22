import { spawn } from 'node:child_process';
import { Command, type ParseOptionsResult } from 'commander';
import { ADMIN_PREFIX, runAdmin, type AdminDeps } from '../lib/kizenAdmin.js';
import { createDefaultKizenVenvDeps, ensureKizen } from '../lib/kizenVenv.js';
import { createOAuthStore } from '../lib/oauthStore.js';

const ADMIN = 'admin';

const INIT_HELP = `Usage: appbuilder admin init [--force]

Install kizen for appbuilder admin, or confirm it's installed. Needs Python 3.12 or newer.

Options:
  --force  remove kizen's install and install it again, to repair a damaged one; don't run it
           while appbuilder admin is running
`;

/**
 * `admin` takes its arguments raw: commander parses none of them, so kizen's own `--help`,
 * `--version` and `--` reach it untouched. `runAdmin` reads the wrapper's options itself.
 */
class RawArgsCommand extends Command {
  override parseOptions(argv: string[]): ParseOptionsResult {
    return { operands: [...argv], unknown: [] };
  }
}

export function createDefaultAdminDeps(command: Command): AdminDeps {
  const writeStderr = (text: string): void => {
    process.stderr.write(text);
  };

  const venvDeps = createDefaultKizenVenvDeps((line) => {
    writeStderr(`${ADMIN_PREFIX}: ${line}\n`);
  }, writeStderr);

  // @types/node types `isTTY` as boolean, but it's undefined on a stream that isn't a TTY.
  const stdin: { isTTY?: boolean } = process.stdin;

  return {
    store: createOAuthStore(),
    ensureKizen: (options) => ensureKizen(venvDeps, options),
    spawn,
    signals: process,
    interactive: stdin.isTTY === true,
    processEnv: process.env,
    execPath: process.execPath,
    scriptPath: process.argv[1],
    outputHelp: () => {
      command.outputHelp();
    },
    outputInitHelp: () => {
      process.stdout.write(INIT_HELP);
    },
    writeStderr,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

export function adminCommand(program: Command): void {
  const admin = new RawArgsCommand(ADMIN)
    .copyInheritedSettings(program)
    .description("Run Kizen's admin CLI (kizen) with the signed-in session")
    .usage('[--env <env>] [--] <kizen args...>\n       appbuilder admin init [--force]')
    .option('--env <env>', 'environment to use (default: the only signed-in one)')
    .allowExcessArguments()
    .addHelpText(
      'after',
      `
Wrapper options end at the first other argument or at --; everything after goes to kizen.
"appbuilder admin init" installs kizen ahead of time; it's otherwise installed on first use.`,
    )
    .action(async () => {
      await runAdmin(admin.args, createDefaultAdminDeps(admin));
    });

  program.addCommand(admin);

  // Without positional options, the root parses its own options (`-V`/`--version`) and drops `--`
  // anywhere in argv, subcommand arguments included. Hand everything after a leading `admin` to it
  // untouched instead; every other command parses as before.
  const parseOptions = program.parseOptions.bind(program);

  program.parseOptions = (argv: string[]): ParseOptionsResult =>
    argv[0] === ADMIN ? { operands: [ADMIN], unknown: argv.slice(1) } : parseOptions(argv);
}
