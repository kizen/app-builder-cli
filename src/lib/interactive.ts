/** Node types `isTTY` as boolean, but it's undefined on a stream that isn't a TTY. */
export interface MaybeTTY {
  isTTY?: boolean;
}

export interface InteractiveInput {
  stdin: MaybeTTY;
  stdout: MaybeTTY;
  json?: boolean;
  noInteractive?: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export const NO_INTERACTIVE_ENV = 'APPBUILDER_NO_INTERACTIVE';

const isTruthy = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

/** Exact names only: the Codex plugin for Claude Code sets `CODEX_COMPANION_*` in Claude Code. */
function runsUnderAutomation(env: InteractiveInput['env']): boolean {
  return (
    isTruthy(env.CI) ||
    env.CODEX_CI !== undefined ||
    env.CLAUDECODE !== undefined ||
    env.TERM === 'dumb' ||
    isTruthy(env[NO_INTERACTIVE_ENV])
  );
}

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

export const isProcessInteractive = (
  flags: Pick<InteractiveInput, 'json' | 'noInteractive'> = {},
): boolean =>
  isInteractive({ stdin: process.stdin, stdout: process.stdout, env: process.env, ...flags });

export const NO_INTERACTIVE_HELP = `run headless even at a terminal (also $${NO_INTERACTIVE_ENV})`;

/** What commander parses `--no-interactive` into: `false` with the flag, else `true`. */
export interface Interactive {
  interactive?: boolean;
}

export function takeInteractiveFlag<T extends Interactive>(
  parsed: T,
): { noInteractive: boolean; options: Omit<T, 'interactive'> } {
  const { interactive, ...options } = parsed;

  return { noInteractive: interactive === false, options };
}
