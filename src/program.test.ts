import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command, Option } from 'commander';
import { ALL_VALID_ICONS_LIST, CUSTOM_ICON_NAMES } from '../shared/lib/validIcons.js';
import type * as KizenAdminModule from './lib/kizenAdmin.js';
import type * as SetupClaudeModule from './lib/setupClaude.js';
import { mcpServerPlan, runSetupClaude } from './lib/setupClaude.js';
import type * as SetupCodexModule from './lib/setupCodex.js';
import { runSetupCodex } from './lib/setupCodex.js';
import type * as WhoamiCommandModule from './lib/whoamiCommand.js';
import { runWhoamiCommand } from './lib/whoamiCommand.js';
import { createProgram } from './program.js';

// Only the setup-claude action's runner is replaced, so a test can see the deps it gets.
vi.mock('./lib/setupClaude.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SetupClaudeModule>()),
  runSetupClaude: vi.fn(() => Promise.resolve()),
}));

vi.mock('./lib/setupCodex.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SetupCodexModule>()),
  runSetupCodex: vi.fn(() => Promise.resolve()),
}));

vi.mock('./lib/whoamiCommand.js', async (importOriginal) => ({
  ...(await importOriginal<typeof WhoamiCommandModule>()),
  runWhoamiCommand: vi.fn(() => Promise.resolve()),
}));

/**
 * `admin` runs the real `runAdmin` (so the wrapper's own parsing is covered), with a fake session,
 * provisioner and spawn in place of the boundaries.
 */
const admin = vi.hoisted(() => ({
  spawned: [] as string[][],
  provisioned: 0,
  helpShown: 0,
}));

vi.mock('./lib/kizenAdmin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof KizenAdminModule>();
  const { EventEmitter } = await import('node:events');

  return {
    ...actual,
    runAdmin: vi.fn((args: readonly string[], deps: KizenAdminModule.AdminDeps) =>
      actual.runAdmin(args, {
        ...deps,
        store: {
          listSessions: () => Promise.resolve(['staging']),
          readSession: () =>
            Promise.resolve({
              businessId: '11111111-1111-4111-8111-111111111111',
              userId: '22222222-2222-4222-8222-222222222222',
            } as never),
          readAccount: (_environment, account) => Promise.resolve(account as never),
          listAccounts: (environment) =>
            Promise.resolve(
              environment !== 'staging'
                ? []
                : [
                    {
                      account: {
                        businessId: '11111111-1111-4111-8111-111111111111',
                        userId: '22222222-2222-4222-8222-222222222222',
                      },
                      session: undefined,
                      current: true,
                    },
                  ],
            ),
        },
        ensureKizen: () => {
          admin.provisioned += 1;

          return Promise.resolve({
            version: '1.2.3',
            dir: '/venv',
            python: '/venv/bin/python',
            kizen: '/venv/bin/kizen',
            built: false,
          });
        },
        spawn: (command, spawnArgs) => {
          admin.spawned.push([command, ...spawnArgs]);

          const child = Object.assign(new EventEmitter(), { kill: () => true });

          setImmediate(() => child.emit('close', 0, null));

          return child as never;
        },
        outputHelp: () => {
          admin.helpShown += 1;
        },
        writeStderr: () => undefined,
        setExitCode: () => undefined,
      }),
    ),
  };
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The sixteen commands, in the order `createProgram` registers them. */
const COMMAND_NAMES = [
  'create',
  'setup-claude',
  'setup-codex',
  'setup-copilot',
  'build',
  'dev',
  'encrypt',
  'report',
  'icons',
  'block',
  'app',
  'login',
  'logout',
  'whoami',
  'auth-header',
  'admin',
];

/** Every command's `--help` blurb, verbatim. */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  create: 'Scaffold a new Kizen plugin project',
  'setup-claude':
    'Install or refresh the Claude Code files in a plugin, or with --mcp only register the Kizen MCP server',
  'setup-codex': 'Install or refresh the Codex skills (.agents/skills) in a plugin',
  'setup-copilot': 'Add or refresh the Copilot code-review setup in an existing plugin repo',
  build: 'Bundle the plugin app into .kizenapp directory',
  dev: 'Start the plugin viewer dev server',
  encrypt: 'Encrypt a secret for a plugin against its encryption keys',
  report: 'Generate a self-contained HTML report of the plugin',
  icons: 'List all valid icon names accepted by toolbar items, pages, and adornments',
  block: 'Work with plugin content blocks',
  app: 'Publish the plugin as a Business App: previews, releases, merges and rollbacks',
  login:
    'Sign in to Kizen in the browser, or switch to a saved account, and store the session on this machine',
  logout: 'Remove the stored session from this machine',
  whoami: 'Show the user and business of the stored session',
  'auth-header':
    'Print an Authorization header for the stored session as JSON (for a Claude Code MCP headersHelper)',
  admin: "Run Kizen's admin CLI (kizen) with the signed-in session",
};

/** The flag strings each command declares, in declaration order. */
const COMMAND_OPTION_FLAGS: Record<string, string[]> = {
  create: [
    '-n, --name <name>',
    '-a, --api-name <name>',
    '-d, --description <text>',
    '-l, --external-link <url>',
    '-b, --business-id <id>',
    '-e, --environment <env>',
    '--artifacts <list>',
    '--include-lib',
    '--no-interactive',
  ],
  'setup-claude': ['--dry-run', '--include-lib', '--mcp', '--env <env>', '--force'],
  'setup-codex': ['--dry-run', '--include-lib'],
  'setup-copilot': ['--dry-run'],
  build: [],
  dev: [
    '-p, --port <port>',
    '-c, --credentials <path>',
    '-d, --debug',
    '-v, --verbose',
    '--no-viewer',
    '--no-cache',
  ],
  encrypt: [
    '--remote',
    '-c, --credentials <path>',
    '-a, --api-name <name>',
    '-v, --value <value>',
    '-s, --stage <stage>',
    '-o, --out <path>',
    '--no-interactive',
  ],
  report: ['-o, --output <path>'],
  icons: [],
  block: [],
  app: [],
  login: [
    '--env <env>',
    '--business <id-or-name>',
    '--user <userId>',
    '--list',
    '--json',
    '--no-interactive',
  ],
  logout: ['--env <env>', '--all', '--business <id-or-name>', '--user <userId>'],
  whoami: ['--env <env>', '--business <id-or-name>', '--user <userId>', '--json'],
  'auth-header': ['--env <env>', '--business <id>', '--user <userId>'],
  admin: ['--env <env>', '--business <id-or-name>', '--user <userId>'],
};

const BLOCK_PUSH_FLAGS = [
  '-c, --credentials <path>',
  '--profile <name>',
  '--dashboard <id>',
  '--dashlet <id>',
  '--create',
  '--dry-run',
  '--yes',
  '--allow-production',
  '--force',
  '--forget',
  '--json',
  '--no-interactive',
  '--env <env>',
  '--business <id-or-name>',
  '--user <userId>',
];

const BLOCK_TARGETS_FLAGS = [
  '-c, --credentials <path>',
  '--profile <name>',
  '--object <id>',
  '--json',
  '--env <env>',
  '--business <id-or-name>',
  '--user <userId>',
];

const APP_SESSION_FLAGS = [
  '--json',
  '--no-interactive',
  '--env <env>',
  '--business <id-or-name>',
  '--user <userId>',
];

const APP_CREDENTIAL_FLAGS = ['-c, --credentials <path>', '--profile <name>'];

const APP_WRITE_FLAGS = ['--dry-run', '--yes', '--allow-production'];

function subcommand(program: Command, name: string): Command {
  const found = program.commands.find((command) => command.name() === name);

  if (!found) {
    throw new Error(`command "${name}" is not registered`);
  }

  return found;
}

/** A command's runnable commands: itself, or the leaves of its subcommand groups. */
const leafCommands = (command: Command): Command[] =>
  command.commands.length === 0 ? [command] : command.commands.flatMap(leafCommands);

function option(program: Command, commandName: string, flags: string): Option {
  const found = subcommand(program, commandName).options.find((opt) => opt.flags === flags);

  if (!found) {
    throw new Error(`option "${flags}" is not declared on "${commandName}"`);
  }

  return found;
}

describe('createProgram', () => {
  it('names the program after the published binary so --help prints a runnable command', () => {
    // package.json `bin` is `appbuilder`, and the README documents every command
    // as `appbuilder <command>`.
    expect(createProgram().name()).toBe('appbuilder');
  });

  it('prints a runnable usage line', () => {
    expect(createProgram().helpInformation()).toContain('Usage: appbuilder [options] [command]');
  });

  it('carries the package description and version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      version: string;
      description: string;
    };
    const program = createProgram();

    expect(program.description()).toBe('Kizen plugin app builder');
    expect(program.version()).toBe(pkg.version);
    expect(pkg.description).toBe('CLI tool for running Kizen plugin apps locally');
  });

  it('declares only the version option at the top level', () => {
    expect(createProgram().options.map((opt) => opt.flags)).toStrictEqual(['-V, --version']);
  });

  it('returns an isolated instance on every call', () => {
    const first = createProgram();
    const second = createProgram();

    // A shared commander singleton would accumulate duplicate subcommands across
    // calls, so the per-instance count is what proves the isolation.
    expect(first).not.toBe(second);
    expect(first.commands).toHaveLength(COMMAND_NAMES.length);
    expect(second.commands).toHaveLength(COMMAND_NAMES.length);
    expect(first.commands[0]).not.toBe(second.commands[0]);
  });
});

describe('command wiring', () => {
  it('registers exactly the sixteen documented commands, in order', () => {
    expect(createProgram().commands.map((command) => command.name())).toStrictEqual(COMMAND_NAMES);
  });

  it.each(COMMAND_NAMES)('describes the %s command', (name) => {
    expect(subcommand(createProgram(), name).description()).toBe(COMMAND_DESCRIPTIONS[name]);
  });

  it.each(COMMAND_NAMES)('declares the documented option flags for %s', (name) => {
    const flags = subcommand(createProgram(), name).options.map((opt) => opt.flags);

    expect(flags).toStrictEqual(COMMAND_OPTION_FLAGS[name]);
  });

  it.each(['create', 'setup-claude', 'setup-codex', 'setup-copilot', 'build', 'icons'])(
    'takes no arguments on %s',
    (name) => {
      expect(subcommand(createProgram(), name).registeredArguments).toStrictEqual([]);
    },
  );
});

describe('dev command options', () => {
  it('defaults --port to the string "3121"', () => {
    const port = option(createProgram(), 'dev', '-p, --port <port>');

    // The action parses this with parseInt, so the default must stay a string —
    // a numeric default would be a silent type mismatch for `options.port`.
    expect(port.defaultValue).toBe('3121');
    expect(typeof port.defaultValue).toBe('string');
    expect(port.required).toBe(true);
  });

  it.each([
    ['--no-viewer', 'viewer'],
    ['--no-cache', 'cache'],
  ])('declares %s as a negation defaulting to enabled', (flags, attributeName) => {
    const negated = option(createProgram(), 'dev', flags);

    expect(negated.negate).toBe(true);
    expect(negated.attributeName()).toBe(attributeName);
  });

  it('resolves its declared defaults before any parsing', () => {
    expect(subcommand(createProgram(), 'dev').opts()).toStrictEqual({
      port: '3121',
      viewer: true,
      cache: true,
    });
  });

  it.each([
    ['-c, --credentials <path>', 'credentials'],
    ['-d, --debug', 'debug'],
    ['-v, --verbose', 'verbose'],
  ])('maps %s to the %s option value', (flags, attributeName) => {
    expect(option(createProgram(), 'dev', flags).attributeName()).toBe(attributeName);
  });
});

describe('encrypt command options', () => {
  it.each([
    ['--remote', 'remote', false],
    ['-c, --credentials <path>', 'credentials', true],
    ['-a, --api-name <name>', 'apiName', true],
    ['-v, --value <value>', 'value', true],
    ['-s, --stage <stage>', 'stage', true],
    ['-o, --out <path>', 'out', true],
  ])('declares %s as %s (takes a value: %s)', (flags, attributeName, takesValue) => {
    const opt = option(createProgram(), 'encrypt', flags);

    expect(opt.attributeName()).toBe(attributeName);
    expect(opt.required).toBe(takesValue);
    expect(opt.negate).toBe(false);
    expect(opt.defaultValue).toBeUndefined();
  });

  it('leaves every encrypt option unset before parsing', () => {
    // The action falls back to interactive prompts / kizen.json for anything
    // missing, so no encrypt flag may carry a commander-level default. The one
    // exception is commander's own: `--no-interactive` defaults `interactive` to
    // true, and the action splits it off (`takeInteractiveFlag`).
    expect(subcommand(createProgram(), 'encrypt').opts()).toStrictEqual({ interactive: true });
  });
});

describe('report command options', () => {
  it('declares --output with a home-relative default in its description', () => {
    const output = option(createProgram(), 'report', '-o, --output <path>');

    expect(output.attributeName()).toBe('output');
    expect(output.required).toBe(true);
    // The blurb interpolates the current user's global credentials dir, so match
    // the shape rather than an absolute path.
    expect(output.description).toMatch(/^output file path \(default: .+<api_name>\.html\)$/);
    expect(output.defaultValue).toBeUndefined();
  });
});

describe('block command', () => {
  it('nests an export subcommand with an optional api_name argument and a --copy option', () => {
    const exportCommand = subcommand(createProgram(), 'block').commands.find(
      (command) => command.name() === 'export',
    );

    expect(exportCommand).toBeDefined();
    expect(
      exportCommand?.registeredArguments.map((arg) => [arg.name(), arg.required]),
    ).toStrictEqual([['api_name', false]]);
    expect(exportCommand?.options.map((opt) => opt.flags)).toStrictEqual(['--copy']);
  });

  it('registers export, push and targets, in order', () => {
    expect(
      subcommand(createProgram(), 'block').commands.map((command) => command.name()),
    ).toStrictEqual(['export', 'push', 'targets']);
  });

  it.each([
    [
      'push',
      'Push a block to a Kizen dashboard, homepage or chart group dashlet',
      [['api_name', false]],
      BLOCK_PUSH_FLAGS,
    ],
    [
      'targets',
      'List the dashboards, homepages and chart groups a block can be pushed to',
      [],
      BLOCK_TARGETS_FLAGS,
    ],
  ])(
    'describes %s and gives it its documented arguments and flags',
    (name, description, args, flags) => {
      const command = subcommand(subcommand(createProgram(), 'block'), name);

      expect(command.description()).toBe(description);
      expect(command.registeredArguments.map((arg) => [arg.name(), arg.required])).toStrictEqual(
        args,
      );
      expect(command.options.map((opt) => opt.flags)).toStrictEqual(flags);
    },
  );

  it('maps the push and targets flags to their option names', () => {
    const block = subcommand(createProgram(), 'block');
    const attributeNames = (name: string): string[] =>
      subcommand(block, name).options.map((opt) => opt.attributeName());

    expect(attributeNames('push')).toStrictEqual([
      'credentials',
      'profile',
      'dashboard',
      'dashlet',
      'create',
      'dryRun',
      'yes',
      'allowProduction',
      'force',
      'forget',
      'json',
      'interactive',
      'env',
      'business',
      'user',
    ]);
    expect(attributeNames('targets')).toStrictEqual([
      'credentials',
      'profile',
      'object',
      'json',
      'env',
      'business',
      'user',
    ]);
  });

  it('leaves every push and targets option unset before parsing', () => {
    const block = subcommand(createProgram(), 'block');

    // But `--no-interactive`'s commander default, which the action splits off.
    expect(subcommand(block, 'push').opts()).toStrictEqual({ interactive: true });
    expect(subcommand(block, 'targets').opts()).toStrictEqual({});
  });
});

describe('app command', () => {
  it('registers versions, push, publish, merge, rollback, pull, actions and preview, in order', () => {
    expect(
      subcommand(createProgram(), 'app').commands.map((command) => command.name()),
    ).toStrictEqual([
      'versions',
      'push',
      'publish',
      'merge',
      'rollback',
      'pull',
      'actions',
      'preview',
    ]);
  });

  it('registers preview delete, with --owner, --expect-updated and --delete-app before the write flags', () => {
    const preview = subcommand(subcommand(createProgram(), 'app'), 'preview');

    expect(preview.description()).toBe("Manage the app's previews: delete");
    expect(preview.commands.map((command) => command.name())).toStrictEqual(['delete']);

    const remove = subcommand(preview, 'delete');

    expect(remove.description()).toBe(
      "Delete your preview of the app, or with --owner, another developer's",
    );
    expect(remove.registeredArguments).toStrictEqual([]);
    expect(remove.options.map((opt) => opt.flags)).toStrictEqual([
      ...APP_CREDENTIAL_FLAGS,
      '--owner <userId>',
      '--expect-updated <ts>',
      '--delete-app',
      ...APP_WRITE_FLAGS,
      ...APP_SESSION_FLAGS,
    ]);
    expect(remove.options.map((opt) => opt.attributeName())).toStrictEqual([
      'credentials',
      'profile',
      'owner',
      'expectUpdated',
      'deleteApp',
      'dryRun',
      'yes',
      'allowProduction',
      'json',
      'interactive',
      'env',
      'business',
      'user',
    ]);
  });

  it('registers actions list, link and unlink, in order', () => {
    const actions = subcommand(subcommand(createProgram(), 'app'), 'actions');

    expect(actions.description()).toBe(
      "Link the app's JS actions to objects: list, link and unlink",
    );
    expect(actions.commands.map((command) => command.name())).toStrictEqual([
      'list',
      'link',
      'unlink',
    ]);
  });

  it.each([
    [
      'list',
      "Show the app's JS actions and the objects they're linked to",
      [],
      [...APP_CREDENTIAL_FLAGS, ...APP_SESSION_FLAGS],
    ],
    [
      'link',
      'Link a JS action to an object, or change whether it shows in its menus',
      // Optional so a terminal can pick them; headless, a missing one is a usage_error.
      [
        ['action', false],
        ['object', false],
      ],
      [...APP_CREDENTIAL_FLAGS, '--menu', '--no-menu', ...APP_WRITE_FLAGS, ...APP_SESSION_FLAGS],
    ],
    [
      'unlink',
      "Remove a JS action's link to an object",
      [
        ['action', false],
        ['object', false],
      ],
      [...APP_CREDENTIAL_FLAGS, ...APP_WRITE_FLAGS, ...APP_SESSION_FLAGS],
    ],
  ])(
    'describes actions %s and gives it its documented arguments and flags',
    (name, description, args, flags) => {
      const command = subcommand(subcommand(subcommand(createProgram(), 'app'), 'actions'), name);

      expect(command.description()).toBe(description);
      expect(command.registeredArguments.map((arg) => [arg.name(), arg.required])).toStrictEqual(
        args,
      );
      expect(command.options.map((opt) => opt.flags)).toStrictEqual(flags);
    },
  );

  it('maps --menu and --no-menu to one `menu` option, unset unless passed', () => {
    const parse = (args: string[]): unknown => {
      const program = createProgram();
      let seen: unknown = 'not run';

      const link = subcommand(subcommand(subcommand(program, 'app'), 'actions'), 'link');

      link.action((_action: string, _object: string, options: { menu?: boolean }) => {
        seen = options.menu;
      });
      program.parse(['app', 'actions', 'link', 'a', 'b', ...args], { from: 'user' });

      return seen;
    };

    expect(parse([])).toBeUndefined();
    expect(parse(['--menu'])).toBe(true);
    expect(parse(['--no-menu'])).toBe(false);
  });

  it.each([
    [
      'versions',
      "Show the app's Live, released and preview versions",
      [],
      [...APP_CREDENTIAL_FLAGS, ...APP_SESSION_FLAGS],
    ],
    [
      'push',
      'Save this folder as your preview of the app',
      [],
      [
        ...APP_CREDENTIAL_FLAGS,
        ...APP_WRITE_FLAGS,
        '--force',
        '--base-from-preview <id>',
        ...APP_SESSION_FLAGS,
      ],
    ],
    [
      'publish',
      'Publish your preview as the next Live version',
      [],
      [
        ...APP_CREDENTIAL_FLAGS,
        ...APP_WRITE_FLAGS,
        '--force',
        '--expect-preview <id>',
        ...APP_SESSION_FLAGS,
      ],
    ],
    [
      'merge',
      'Merge the Live version (or --release) into this folder',
      [],
      [
        ...APP_CREDENTIAL_FLAGS,
        '--release <n>',
        '--base <n>',
        '--accept-live-base',
        '--dry-run',
        '--yes',
        ...APP_SESSION_FLAGS,
      ],
    ],
    [
      'rollback',
      'Restore a released version as your preview',
      [['version', true]],
      [...APP_CREDENTIAL_FLAGS, ...APP_WRITE_FLAGS, ...APP_SESSION_FLAGS],
    ],
    [
      'pull',
      "Download a released version's source into a new folder",
      [['version', true]],
      [...APP_CREDENTIAL_FLAGS, '--out <dir>', ...APP_SESSION_FLAGS],
    ],
  ])(
    'describes %s and gives it its documented arguments and flags',
    (name, description, args, flags) => {
      const command = subcommand(subcommand(createProgram(), 'app'), name);

      expect(command.description()).toBe(description);
      expect(command.registeredArguments.map((arg) => [arg.name(), arg.required])).toStrictEqual(
        args,
      );
      expect(command.options.map((opt) => opt.flags)).toStrictEqual(flags);
    },
  );

  it('maps the app flags to the option names the runners read', () => {
    const app = subcommand(createProgram(), 'app');
    const attributeNames = (name: string): string[] =>
      subcommand(app, name).options.map((opt) => opt.attributeName());

    expect(attributeNames('publish')).toStrictEqual([
      'credentials',
      'profile',
      'dryRun',
      'yes',
      'allowProduction',
      'force',
      'expectPreview',
      'json',
      'interactive',
      'env',
      'business',
      'user',
    ]);
    expect(attributeNames('merge')).toStrictEqual([
      'credentials',
      'profile',
      'release',
      'base',
      'acceptLiveBase',
      'dryRun',
      'yes',
      'json',
      'interactive',
      'env',
      'business',
      'user',
    ]);
    expect(attributeNames('pull')).toContain('out');
  });

  it('leaves every app option unset before parsing', () => {
    const app = subcommand(createProgram(), 'app');

    // But `--no-interactive`'s commander default, which the actions split off.
    for (const command of leafCommands(app)) {
      expect(command.opts(), command.name()).toStrictEqual({ interactive: true });
    }
  });
});

describe('--no-interactive', () => {
  const commandsWithUI = (): Command[] => {
    const program = createProgram();

    return [
      subcommand(subcommand(program, 'block'), 'push'),
      subcommand(program, 'create'),
      subcommand(program, 'encrypt'),
      subcommand(program, 'login'),
      ...leafCommands(subcommand(program, 'app')),
    ];
  };

  it('is a negation of `interactive` on every command with an interactive UI', () => {
    for (const command of commandsWithUI()) {
      const flag = command.options.find((opt) => opt.flags === '--no-interactive');

      expect(flag?.negate, command.name()).toBe(true);
      expect(flag?.attributeName(), command.name()).toBe('interactive');
      // No positive --interactive alongside it, which would change the default.
      expect(command.options.some((opt) => opt.flags === '--interactive')).toBe(false);
    }
  });

  it('is on no command without an interactive UI', () => {
    const program = createProgram();
    const without = [
      subcommand(subcommand(program, 'block'), 'targets'),
      subcommand(program, 'logout'),
      subcommand(program, 'whoami'),
      subcommand(program, 'auth-header'),
      subcommand(program, 'setup-codex'),
    ];

    for (const command of without) {
      expect(
        command.options.some((opt) => opt.flags === '--no-interactive'),
        command.name(),
      ).toBe(false);
    }
  });
});

describe('help output', () => {
  it('matches the published help text', () => {
    const program = createProgram();

    // Pin the wrap width: commander otherwise derives it from
    // process.stdout.columns, which would make the snapshot machine-dependent.
    program.configureHelp({ helpWidth: 80 });

    expect(program.helpInformation()).toMatchSnapshot();
  });
});

describe('icons command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runIcons(): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    createProgram().parse(['icons'], { from: 'user' });

    const lines = log.mock.calls.map((call) => String(call[0]));

    log.mockRestore();

    return lines;
  }

  it('prints the icon list verbatim', () => {
    // Wiring check only: that the registered action reaches stdout with exactly
    // the list and nothing else — no header, no trailing blurb, no reformatting,
    // no other list. Content-level properties of the underlying exports
    // (VALID_ICONS, VALID_ICONS_LIST, CUSTOM_ICON_NAMES) are covered by
    // shared/lib/validIcons.test.ts; ALL_VALID_ICONS_LIST itself is not
    // content-asserted anywhere while its duplicate emission is tracked as a
    // recorded bug.
    expect(runIcons()).toStrictEqual(ALL_VALID_ICONS_LIST);
  });

  it('prints each block in sorted order', () => {
    // ALL_VALID_ICONS_LIST is a sorted FontAwesome block followed by the sorted
    // custom-component names, so each block is ordered but the whole list is not.
    const lines = runIcons();
    const split = lines.length - CUSTOM_ICON_NAMES.size;
    const fontAwesome = lines.slice(0, split);
    const custom = lines.slice(split);

    expect(fontAwesome).toStrictEqual([...fontAwesome].sort());
    expect(custom).toStrictEqual([...custom].sort());
  });

  it('includes the custom Kizen-brand icons', () => {
    const lines = runIcons();

    expect(lines).toContain('kizen-k');
    expect(lines).toContain('form-entity');
  });
});

describe('setup-codex', () => {
  it('runs in the current directory with the parsed flags', async () => {
    await createProgram().parseAsync(['setup-codex', '--dry-run', '--include-lib'], {
      from: 'user',
    });

    expect(vi.mocked(runSetupCodex)).toHaveBeenCalledWith(
      process.cwd(),
      { dryRun: true, includeLib: true },
      expect.objectContaining({ fs: expect.any(Object) as unknown }),
    );
  });

  it.each(['--mcp', '--force', '--env'])('has no %s', (flag) => {
    expect(
      subcommand(createProgram(), 'setup-codex').options.some((opt) => opt.long === flag),
    ).toBe(false);
  });
});

describe('whoami', () => {
  it('passes --json to the whoami runner, with the other flags', async () => {
    await createProgram().parseAsync(
      ['whoami', '--json', '--env', 'staging', '--business', 'acme'],
      {
        from: 'user',
      },
    );

    expect(vi.mocked(runWhoamiCommand)).toHaveBeenCalledWith(
      { json: true, env: 'staging', business: 'acme' },
      expect.objectContaining({ store: expect.any(Object) as unknown }),
    );
  });
});

describe('setup-claude --mcp helper', () => {
  it("the helper pins the CLI's own version", async () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      name: string;
      version: string;
    };

    // The deps the registered setup-claude action passes carry the program's version.
    await createProgram().parseAsync(['setup-claude', '--mcp'], { from: 'user' });

    const deps = vi.mocked(runSetupClaude).mock.calls[0]?.[2];

    expect(deps?.cliVersion).toBe(pkg.version);

    const plan = mcpServerPlan('staging', deps?.cliVersion ?? '');
    const config = JSON.parse(plan.addArgs[5] ?? '') as { headersHelper: string };

    expect(config.headersHelper).toBe(`npx -y ${pkg.name}@${pkg.version} auth-header`);
  });
});

describe('admin command', () => {
  afterEach(() => {
    admin.spawned = [];
    admin.provisioned = 0;
    admin.helpShown = 0;
  });

  const kizenArgs = async (args: string[]): Promise<string[] | undefined> => {
    await createProgram().parseAsync(['admin', ...args], { from: 'user' });

    const [spawned] = admin.spawned;

    expect(spawned?.slice(0, 2)).toStrictEqual(['/venv/bin/python', '/venv/bin/kizen']);

    return spawned?.slice(2);
  };

  it.each([
    [
      ['status', '--help'],
      ['status', '--help'],
    ],
    [['--version'], ['--version']],
    [['-V'], ['-V']],
    [
      ['--dry-run', 'apply', '-h'],
      ['--dry-run', 'apply', '-h'],
    ],
    [
      ['--env', 'staging', 'status', '--env', 'go'],
      ['status', '--env', 'go'],
    ],
    [
      ['--env=staging', 'x', '--', 'y'],
      ['x', '--', 'y'],
    ],
    [
      ['--business', '11111111-1111-4111-8111-111111111111', 'status', '--business', 'go'],
      ['status', '--business', 'go'],
    ],
    [
      [
        '--user=22222222-2222-4222-8222-222222222222',
        '--business=11111111-1111-4111-8111-111111111111',
        '--',
        '--user',
        'x',
      ],
      ['--user', 'x'],
    ],
    [['--', '--help'], ['--help']],
    [['--', '--version'], ['--version']],
    [
      ['--', '--', 'a'],
      ['--', 'a'],
    ],
    // (o) kizen's own init, which it refuses under this mode.
    [['--', 'init'], ['init']],
  ])('(h) passes %j to kizen as %j', async (args, expected) => {
    expect(await kizenArgs(args)).toStrictEqual(expected);
  });

  it('shows the wrapper help for --help before any kizen argument', async () => {
    await createProgram().parseAsync(['admin', '--help'], { from: 'user' });
    await createProgram().parseAsync(['admin', '--env', 'staging', '-h'], { from: 'user' });

    expect(admin.helpShown).toBe(2);
    expect(admin.spawned).toStrictEqual([]);
    expect(admin.provisioned).toBe(0);
  });

  it('`help admin` prints the admin help and neither provisions nor runs kizen', () => {
    const program = createProgram();
    const command = subcommand(program, 'admin');
    let out = '';

    command
      .exitOverride()
      .configureHelp({ helpWidth: 100 })
      .configureOutput({
        writeOut: (text) => {
          out += text;
        },
      });

    expect(() => program.parse(['help', 'admin'], { from: 'user' })).toThrow(
      expect.objectContaining({ code: 'commander.help' }),
    );
    expect(out).toContain(
      'Usage: appbuilder admin [--env <env>] [--business <id-or-name> [--user <userId>]] [--] <kizen args...>',
    );
    expect(out).toContain('--env <env>');
    expect(admin.provisioned).toBe(0);
    expect(admin.spawned).toStrictEqual([]);
  });

  it('runs admin init through the shared provisioner without spawning kizen', async () => {
    await createProgram().parseAsync(['admin', 'init'], { from: 'user' });

    expect(admin.provisioned).toBe(1);
    expect(admin.spawned).toStrictEqual([]);
  });

  it('documents its usage in its help', () => {
    const command = subcommand(createProgram(), 'admin');

    command.configureHelp({ helpWidth: 100 });

    expect(command.helpInformation()).toContain(
      'Usage: appbuilder admin [--env <env>] [--business <id-or-name> [--user <userId>]] [--] <kizen args...>\n       appbuilder admin init',
    );
  });
});

describe('(r) option parsing of other commands is unchanged', () => {
  function capture(args: string[]): { out: string; code: string | undefined } {
    const program = createProgram();
    let out = '';

    program.exitOverride().configureOutput({
      writeOut: (text) => {
        out += text;
      },
      writeErr: (text) => {
        out += text;
      },
    });

    try {
      program.parse(args, { from: 'user' });
    } catch (error) {
      return { out, code: (error as { code?: string }).code };
    }

    return { out, code: undefined };
  }

  // `app merge` takes --release <n> rather than --version <n> because of this.
  it.each([
    [['dev', '-V']],
    [['block', 'push', '--version']],
    [['app', 'merge', '--version']],
    [['-V', 'admin']],
  ])('%j still prints the version', (args) => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      version: string;
    };

    expect(capture(args)).toStrictEqual({ out: `${pkg.version}\n`, code: 'commander.version' });
  });
});
