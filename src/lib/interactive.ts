/**
 * Whether a command may show its interactive (ink) UI, or must run headless. Every command with
 * an interactive path asks this one function, so they all agree on when a person is at the
 * terminal.
 */

/** Node types `isTTY` as boolean, but it's undefined on a stream that isn't a TTY. */
export interface MaybeTTY {
  isTTY?: boolean;
}

export interface InteractiveInput {
  stdin: MaybeTTY;
  stdout: MaybeTTY;
  /** `--json`: the output is for a program, so never a UI. */
  json?: boolean;
  /** `--no-interactive`. */
  noInteractive?: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

/** Turns the UI off whatever the terminal, for scripts and agents that can't set a flag. */
export const NO_INTERACTIVE_ENV = 'APPBUILDER_NO_INTERACTIVE';

/** Set, and neither empty, `0` nor `false` (ignoring case). */
const isTruthy = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

/**
 * Agent and CI environments, by their exact variable names. Codex sets `CODEX_CI` (with
 * `TERM=dumb`) on every command it runs and can give it a PTY; Claude Code sets `CLAUDECODE`.
 * Never a `CODEX_` prefix match: the Codex plugin for Claude Code sets `CODEX_COMPANION_*`
 * inside Claude Code sessions, which says nothing about this process.
 */
function runsUnderAutomation(env: InteractiveInput['env']): boolean {
  return (
    isTruthy(env.CI) ||
    env.CODEX_CI !== undefined ||
    env.CLAUDECODE !== undefined ||
    env.TERM === 'dumb' ||
    isTruthy(env[NO_INTERACTIVE_ENV])
  );
}

/**
 * True only when both stdin and stdout are TTYs (a piped stdout means a program reads it), the
 * run has neither `--json` nor `--no-interactive`, and no agent or CI environment is detected.
 */
export function isInteractive({
  stdin,
  stdout,
  json,
  noInteractive,
  env,
}: InteractiveInput): boolean {
  return (
    stdin.isTTY === true &&
    stdout.isTTY === true &&
    json !== true &&
    noInteractive !== true &&
    !runsUnderAutomation(env)
  );
}

/** `isInteractive` for this process, given the run's flags. */
export const isProcessInteractive = (
  flags: Pick<InteractiveInput, 'json' | 'noInteractive'> = {},
): boolean =>
  isInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env, ...flags });

/** `--no-interactive`'s help text, the same on every command that has it. */
export const NO_INTERACTIVE_HELP = `run headless even at a terminal (also $${NO_INTERACTIVE_ENV})`;

/** What commander parses `--no-interactive` into: `false` with the flag, else `true`. */
export interface Interactive {
  interactive?: boolean;
}

/**
 * commander turns `--no-interactive` into `interactive: false` (and `true` by default). Splits it
 * off the parsed options, so the command's own options never see it.
 */
export function takeInteractiveFlag<T extends Interactive>(
  parsed: T,
): { noInteractive: boolean; options: Omit<T, 'interactive'> } {
  const { interactive, ...options } = parsed;

  return { noInteractive: interactive === false, options };
}
