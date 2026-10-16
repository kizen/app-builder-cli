/**
 * `appbuilder login`, `logout`, `whoami` and `auth-header`. Output goes through
 * injected writers so tests can assert on exactly what a user would see. Only
 * `auth-header` ever writes a token, and only the access token, to stdout.
 */
import { BASE_URLS } from '../../shared/lib/kizenUrls.js';
import {
  ENVIRONMENTS,
  isEnvironment,
  unknownEnvironmentMessage,
  type Environment,
} from './credentials.js';
import { createKizenClient, KizenApiError, type KizenIdentity } from './kizenClient.js';
import { DEFAULT_LOGIN_ENVIRONMENT } from './oauth.js';
import {
  createDefaultLoginDeps,
  createDefaultTokenProvider,
  login,
  resolveSessionEnvironment,
  type BearerTokenProvider,
  type LoginDeps,
  type TokenProviderOptions,
} from './oauthSession.js';
import { createOAuthStore, type OAuthStore } from './oauthStore.js';

export type { TokenProviderOptions } from './oauthSession.js';

/**
 * Claude Code kills a `headersHelper` after 10s. The worst case for
 * `auth-header` is a full lock wait, then a full refresh request, then (when the
 * refresh hits `invalid_client`) the best-effort `FORGET_CLIENT_WAIT_MS` wait to
 * forget the client. All three together stay under that with room for process
 * start-up.
 */
export const CLAUDE_CODE_HELPER_LIMIT_MS = 10_000;
export const AUTH_HEADER_LOCK_WAIT_MS = 3_000;
export const AUTH_HEADER_REQUEST_TIMEOUT_MS = 5_000;

export interface AuthCommandDeps {
  store: OAuthStore;
  loginDeps: LoginDeps;
  getIdentity: (environment: Environment) => Promise<KizenIdentity>;
  tokenProvider: (environment: Environment, options?: TokenProviderOptions) => BearerTokenProvider;
  /** Timeouts `auth-header` passes to `tokenProvider`. */
  authHeaderTimeouts: { requestTimeoutMs: number; lockWaitMs: number };
  /** Environment variables (for CLAUDE_CODE_MCP_SERVER_URL). */
  processEnv: Readonly<Record<string, string | undefined>>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

export function createDefaultAuthCommandDeps(
  store: OAuthStore = createOAuthStore(),
): AuthCommandDeps {
  const tokenProvider = (
    environment: Environment,
    options?: TokenProviderOptions,
  ): BearerTokenProvider => createDefaultTokenProvider(environment, store, options);

  return {
    store,
    loginDeps: createDefaultLoginDeps(store),
    getIdentity: (environment) =>
      createKizenClient({ bearer: tokenProvider(environment) }).getIdentity(),
    tokenProvider,
    authHeaderTimeouts: {
      requestTimeoutMs: AUTH_HEADER_REQUEST_TIMEOUT_MS,
      lockWaitMs: AUTH_HEADER_LOCK_WAIT_MS,
    },
    processEnv: process.env,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

export class AuthCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthCommandError';
  }
}

function parseEnvironment(env: string): Environment {
  if (!isEnvironment(env)) {
    throw new AuthCommandError(unknownEnvironmentMessage(env));
  }

  return env;
}

/** --env if given, else the only environment with a stored session; any problem is an error. */
async function sessionEnvironment(
  env: string | undefined,
  store: OAuthStore,
): Promise<Environment> {
  const resolved = await resolveSessionEnvironment(env, () => store.listSessions());

  if (!resolved.ok) {
    throw new AuthCommandError(resolved.message);
  }

  return resolved.environment;
}

const identityLines = (environment: Environment, identity: KizenIdentity): string[] => {
  const who = [identity.fullName, identity.email && `<${identity.email}>`]
    .filter(Boolean)
    .join(' ');
  const business = identity.businessName
    ? `${identity.businessName} (${identity.businessId})`
    : identity.businessId;

  return [
    `Environment: ${environment}`,
    `User: ${who === '' ? identity.userId : `${who} (${identity.userId})`}`,
    `Business: ${business}`,
  ];
};

function report(deps: AuthCommandDeps, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof KizenApiError && error.hint !== undefined ? `\n${error.hint}` : '';

  deps.writeStderr(`Error: ${message}${hint}\n`);
  deps.setExitCode(1);
}

export async function runLogin(options: { env?: string }, deps: AuthCommandDeps): Promise<void> {
  try {
    const environment =
      options.env === undefined ? DEFAULT_LOGIN_ENVIRONMENT : parseEnvironment(options.env);

    deps.writeStderr(`Signing in to ${environment}.\n`);
    await login(environment, deps.loginDeps);
    deps.writeStdout(`Signed in to ${environment}.\n`);

    try {
      deps.writeStdout(
        `${identityLines(environment, await deps.getIdentity(environment)).join('\n')}\n`,
      );
    } catch (error) {
      deps.writeStderr(
        `Signed in, but couldn't load the account details: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  } catch (error) {
    report(deps, error);
  }
}

/**
 * Deletes under the session lock, so a refresh in flight elsewhere finishes
 * (and writes) first, or starts after and finds no session. Without it, the
 * refresh would write the deleted session back. Never reads the file, so an
 * unreadable session is removed too.
 */
async function deleteUnderLock(environment: Environment, store: OAuthStore): Promise<boolean> {
  const release = await store.acquireLock(environment);

  try {
    return await store.deleteSession(environment);
  } finally {
    await release();
  }
}

export async function runLogout(options: { env?: string }, deps: AuthCommandDeps): Promise<void> {
  try {
    const resolved = await resolveSessionEnvironment(options.env, () => deps.store.listSessions());

    if (!resolved.ok && resolved.problem !== 'not_signed_in') {
      throw new AuthCommandError(resolved.message);
    }

    const environment = resolved.ok ? resolved.environment : null;

    if (environment === null || !(await deleteUnderLock(environment, deps.store))) {
      deps.writeStdout(
        environment === null ? 'Not signed in.\n' : `Not signed in to ${environment}.\n`,
      );

      return;
    }

    deps.writeStdout(`Signed out of ${environment}. The session was removed from this machine.\n`);
  } catch (error) {
    report(deps, error);
  }
}

export async function runWhoami(options: { env?: string }, deps: AuthCommandDeps): Promise<void> {
  try {
    const environment = await sessionEnvironment(options.env, deps.store);

    deps.writeStdout(
      `${identityLines(environment, await deps.getIdentity(environment)).join('\n')}\n`,
    );
  } catch (error) {
    report(deps, error);
  }
}

/** The environment whose API origin is the MCP server URL's origin; errors if none. */
function serverEnvironment(serverUrl: string): { environment: Environment; origin: string } {
  let origin: string;

  try {
    origin = new URL(serverUrl).origin;
  } catch {
    throw new AuthCommandError(
      "CLAUDE_CODE_MCP_SERVER_URL is not a valid URL, so auth-header won't send a token.",
    );
  }

  const environment = ENVIRONMENTS.find(
    (candidate) => new URL(BASE_URLS[candidate]).origin === origin,
  );

  if (environment === undefined) {
    throw new AuthCommandError(
      `No Kizen environment matches the MCP server ${origin}, so auth-header won't send it a token.`,
    );
  }

  return { environment, origin };
}

/**
 * The environment `auth-header` signs for. When Claude Code passes
 * CLAUDE_CODE_MCP_SERVER_URL, the server decides: its origin must match a Kizen
 * environment, and --env, if given, must agree with it. So a token is only ever
 * sent to the environment it belongs to. Without the variable (a manual run),
 * --env, else the only signed-in environment.
 */
async function headerEnvironment(
  env: string | undefined,
  deps: AuthCommandDeps,
): Promise<Environment> {
  const explicit = env === undefined ? undefined : parseEnvironment(env);
  const serverUrl = deps.processEnv.CLAUDE_CODE_MCP_SERVER_URL;

  if (serverUrl !== undefined && serverUrl !== '') {
    const server = serverEnvironment(serverUrl);

    if (explicit !== undefined && explicit !== server.environment) {
      throw new AuthCommandError(
        `--env ${explicit} doesn't match the MCP server ${server.origin} (${server.environment}), so auth-header won't send it a token.`,
      );
    }

    return server.environment;
  }

  return explicit ?? sessionEnvironment(undefined, deps.store);
}

/**
 * Claude Code `headersHelper`: prints `{"Authorization":"Bearer <access token>"}`
 * as the only stdout line, refreshing first when the token is about to expire.
 * Failures print one line to stderr and nothing to stdout.
 */
export async function runAuthHeader(
  options: { env?: string },
  deps: AuthCommandDeps,
): Promise<void> {
  let line: string;

  try {
    const environment = await headerEnvironment(options.env, deps);
    const { requestTimeoutMs, lockWaitMs } = deps.authHeaderTimeouts;
    const token = await deps
      .tokenProvider(environment, { requestTimeoutMs, lock: { waitMs: lockWaitMs } })
      .getAccessToken();

    line = `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    deps.writeStderr(`appbuilder auth-header: ${message.replace(/\s+/g, ' ').trim()}\n`);
    deps.setExitCode(1);

    return;
  }

  deps.writeStdout(line);
}
