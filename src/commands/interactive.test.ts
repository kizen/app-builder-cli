import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as InkModule from 'ink';
import type * as AppHeadlessModule from '../lib/appHeadless.js';
import type * as CreateHeadlessModule from '../lib/createHeadless.js';
import type * as OAuthCommandsModule from '../lib/oauthCommands.js';
import type * as PushHeadlessModule from '../lib/pushHeadless.js';
import { createProgram } from '../program.js';

const calls = vi.hoisted(() => ({
  rendered: 0,
  headless: [] as string[],
  loginInteractive: [] as boolean[],
}));

vi.mock('ink', async (importOriginal) => ({
  ...(await importOriginal<typeof InkModule>()),
  render: vi.fn(() => {
    calls.rendered += 1;

    return { waitUntilExit: () => Promise.resolve() };
  }),
}));

vi.mock('../lib/pushHeadless.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PushHeadlessModule>()),
  createDefaultPushDeps: vi.fn(() => ({})),
  runPushHeadless: vi.fn(() => {
    calls.headless.push('block push');

    return Promise.resolve();
  }),
}));

vi.mock('../lib/createDefaults.js', () => ({
  resolveCreateDefaults: vi.fn(() => Promise.resolve({ businessId: '', environment: 'go' })),
}));

vi.mock('../lib/createHeadless.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CreateHeadlessModule>()),
  runHeadlessCreate: vi.fn(() => {
    calls.headless.push('create');

    return Promise.resolve();
  }),
}));

vi.mock('../lib/encryptHeadless.js', () => ({
  runHeadless: vi.fn(() => {
    calls.headless.push('encrypt');

    return Promise.resolve();
  }),
}));

vi.mock('../lib/appHeadless.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AppHeadlessModule>()),
  runAppPushHeadless: vi.fn(() => {
    calls.headless.push('app push');

    return Promise.resolve();
  }),
}));

vi.mock('../lib/oauthCommands.js', async (importOriginal) => ({
  ...(await importOriginal<typeof OAuthCommandsModule>()),
  runLogin: vi.fn((_options: unknown, deps: OAuthCommandsModule.AuthCommandDeps) => {
    calls.loginInteractive.push(deps.isInteractive());

    return Promise.resolve();
  }),
}));

const AUTOMATION_ENV = ['CI', 'CODEX_CI', 'CLAUDECODE', 'APPBUILDER_NO_INTERACTIVE'] as const;

const COMMANDS: [name: string, argv: string[]][] = [
  ['block push', ['block', 'push', 'my_block']],
  ['create', ['create', '--include-lib']],
  ['encrypt', ['encrypt', '--api-name', 'acme']],
  ['app push', ['app', 'push']],
];

const setTTY = (
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  value: boolean | undefined,
): void => {
  Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
};

describe('block push, create, encrypt and login use isInteractive', () => {
  const original = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

  beforeEach(() => {
    calls.rendered = 0;
    calls.headless = [];
    calls.loginInteractive = [];
    setTTY(process.stdin, true);
    setTTY(process.stdout, true);
    vi.stubEnv('TERM', 'xterm-256color');

    for (const name of AUTOMATION_ENV) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    setTTY(process.stdin, original.stdin);
    setTTY(process.stdout, original.stdout);
    vi.unstubAllEnvs();
  });

  const run = (argv: string[]): Promise<unknown> =>
    createProgram().parseAsync(argv, { from: 'user' });

  it.each(COMMANDS)('%s renders the UI at a plain terminal', async (_name, argv) => {
    await run(argv);

    expect(calls).toMatchObject({ rendered: 1, headless: [] });
  });

  it.each(COMMANDS)('%s runs headless under CLAUDECODE with TTYs', async (name, argv) => {
    vi.stubEnv('CLAUDECODE', '1');

    await run(argv);

    expect(calls).toMatchObject({ rendered: 0, headless: [name] });
  });

  it.each(COMMANDS)('%s runs headless with --no-interactive', async (name, argv) => {
    await run([...argv, '--no-interactive']);

    expect(calls).toMatchObject({ rendered: 0, headless: [name] });
  });

  it('create keeps the wizard with --no-interactive unset, despite commander’s `interactive: true`', async () => {
    await run(['create']);

    expect(calls).toMatchObject({ rendered: 1, headless: [] });
  });

  it('login offers the account picker only where isInteractive says so', async () => {
    await run(['login']);
    await run(['login', '--no-interactive']);
    vi.stubEnv('CLAUDECODE', '1');
    await run(['login']);
    vi.stubEnv('CLAUDECODE', undefined);
    vi.stubEnv('CODEX_CI', '1');
    await run(['login']);

    expect(calls.loginInteractive).toStrictEqual([true, false, false, false]);
  });
});
