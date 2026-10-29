import { describe, expect, it } from 'vitest';
import { isInteractive, takeInteractiveFlag, type InteractiveInput } from './interactive.js';

const TTY = { isTTY: true };

const plain = (overrides: Partial<InteractiveInput> = {}): InteractiveInput => ({
  stdin: TTY,
  stdout: TTY,
  env: { TERM: 'xterm-256color' },
  ...overrides,
});

describe('isInteractive', () => {
  it('isInteractive is true for a plain TTY', () => {
    expect(isInteractive(plain())).toBe(true);
    expect(isInteractive(plain({ env: {} }))).toBe(true);
  });

  it('isInteractive is false under CODEX_CI, CLAUDECODE, CI, TERM=dumb, APPBUILDER_NO_INTERACTIVE, --json and --no-interactive', () => {
    const cases: [string, Partial<InteractiveInput>][] = [
      ['CODEX_CI', { env: { TERM: 'xterm', CODEX_CI: '1' } }],
      ['CLAUDECODE', { env: { TERM: 'xterm', CLAUDECODE: '1' } }],
      ['CI', { env: { TERM: 'xterm', CI: 'true' } }],
      ['CI=1', { env: { TERM: 'xterm', CI: '1' } }],
      ['TERM=dumb', { env: { TERM: 'dumb' } }],
      ['APPBUILDER_NO_INTERACTIVE', { env: { TERM: 'xterm', APPBUILDER_NO_INTERACTIVE: '1' } }],
      ['--json', { json: true }],
      ['--no-interactive', { noInteractive: true }],
      ['piped stdout', { stdout: { isTTY: false } }],
      ['piped stdin', { stdin: {} }],
    ];

    for (const [name, overrides] of cases) {
      expect(isInteractive(plain(overrides)), name).toBe(false);
    }
  });

  it('treats an empty, 0 or false CI / APPBUILDER_NO_INTERACTIVE as unset', () => {
    for (const value of ['', '0', 'false', 'FALSE']) {
      expect(isInteractive(plain({ env: { CI: value } })), `CI=${value}`).toBe(true);
      expect(
        isInteractive(plain({ env: { APPBUILDER_NO_INTERACTIVE: value } })),
        `APPBUILDER_NO_INTERACTIVE=${value}`,
      ).toBe(true);
    }
  });

  it('isInteractive ignores CODEX_COMPANION_* variables', () => {
    expect(
      isInteractive(
        plain({
          env: {
            TERM: 'xterm',
            CODEX_COMPANION_SESSION_ID: 'abc',
            CODEX_COMPANION_HOME: '/x',
            CODEX_HOME: '/y',
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('takeInteractiveFlag', () => {
  it('splits commander’s `interactive` off the options', () => {
    expect(takeInteractiveFlag({ interactive: false, yes: true })).toStrictEqual({
      noInteractive: true,
      options: { yes: true },
    });
    expect(takeInteractiveFlag({ interactive: true, json: true })).toStrictEqual({
      noInteractive: false,
      options: { json: true },
    });
    expect(takeInteractiveFlag({})).toStrictEqual({ noInteractive: false, options: {} });
  });
});
