import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command, Option } from 'commander';
import { ALL_VALID_ICONS_LIST, CUSTOM_ICON_NAMES } from '../shared/lib/validIcons.js';
import { createProgram } from './program.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The six commands, in the order `createProgram` registers them. */
const COMMAND_NAMES = ['create', 'build', 'dev', 'encrypt', 'report', 'icons'];

/** Every command's `--help` blurb, verbatim. */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  create: 'Scaffold a new Kizen plugin project',
  build: 'Bundle the plugin app into .kizenapp directory',
  dev: 'Start the plugin viewer dev server',
  encrypt: 'Encrypt a secret for a plugin against its encryption keys',
  report: 'Generate a self-contained HTML report of the plugin',
  icons: 'List all valid icon names accepted by toolbar items, pages, and adornments',
};

/** The flag strings each command declares, in declaration order. */
const COMMAND_OPTION_FLAGS: Record<string, string[]> = {
  create: [
    '-n, --name <name>',
    '-a, --api-name <name>',
    '-d, --description <text>',
    '-l, --external-link <url>',
    '-b, --business-id <id>',
    '--artifacts <list>',
  ],
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
  ],
  report: ['-o, --output <path>'],
  icons: [],
};

function subcommand(program: Command, name: string): Command {
  const found = program.commands.find((command) => command.name() === name);

  if (!found) {
    throw new Error(`command "${name}" is not registered`);
  }

  return found;
}

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
  it('registers exactly the six documented commands, in order', () => {
    expect(createProgram().commands.map((command) => command.name())).toStrictEqual(COMMAND_NAMES);
  });

  it.each(COMMAND_NAMES)('describes the %s command', (name) => {
    expect(subcommand(createProgram(), name).description()).toBe(COMMAND_DESCRIPTIONS[name]);
  });

  it.each(COMMAND_NAMES)('declares the documented option flags for %s', (name) => {
    const flags = subcommand(createProgram(), name).options.map((opt) => opt.flags);

    expect(flags).toStrictEqual(COMMAND_OPTION_FLAGS[name]);
  });

  it.each(['create', 'build', 'icons'])('takes no arguments on %s', (name) => {
    expect(subcommand(createProgram(), name).registeredArguments).toStrictEqual([]);
  });
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
    // missing, so no encrypt flag may carry a commander-level default.
    expect(subcommand(createProgram(), 'encrypt').opts()).toStrictEqual({});
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
