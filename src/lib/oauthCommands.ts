/**
 * `appbuilder login`, `logout`, `whoami` and `auth-header`. Only `auth-header` ever writes a
 * token, and only the access token, to stdout.
 */
import { apiOriginFor } from '../../shared/lib/kizenUrls.js';
import { ENVIRONMENTS, parseEnvironment, type Environment } from './credentials.js';
import { errorMessage } from './guards.js';
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
import { createOAuthStore, mutateSession, type OAuthStore } from './oauthStore.js';

/**
 * Claude Code kills a `headersHelper` after 10s. auth-header's worst case (lock wait, then
 * refresh request, then `FORGET_CLIENT_WAIT_MS`) runs serially and must stay under it with room
 * for start-up. A lost lease (only after a pause that already overran) adds up to two lock waits.
 */
export const CLAUDE_CODE_HELPER_LIMIT_MS = 10_000;
export const AUTH_HEADER_LOCK_WAIT_MS = 3_000;
export const AUTH_HEADER_REQUEST_TIMEOUT_MS = 5_000;

export interface AuthCommandDeps {
  store: OAuthStore;
  loginDeps: LoginDeps;
  getIdentity: (environment: Environment) => Promise<KizenIdentity>;
  tokenProvider: (environment: Environment, options?: TokenProviderOptions) => BearerTokenProvider;
  authHeaderTimeouts: { requestTimeoutMs: number; lockWaitMs: number };
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
  const writeStderr = (text: string): void => {
    process.stderr.write(text);
  };

  return {
    store,
    loginDeps: createDefaultLoginDeps(store, (line) => {
      writeStderr(`${line}\n`);
    }),
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
    writeStderr,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

function requireEnvironment(env: string): Environment {
  const { environment, message } = parseEnvironment(env);

  if (environment === undefined) {
    throw new Error(message);
  }

  return environment;
}

/** --env if given, else the only environment with a stored session; any problem is an error. */
async function sessionEnvironment(
  env: string | undefined,
  store: OAuthStore,
): Promise<Environment> {
  const resolved = await resolveSessionEnvironment(env, () => store.listSessions());

  if (!resolved.ok) {
    throw new Error(resolved.message);
  }

  return resolved.environment;
}

const identityLines = (environment: Environment, identity: KizenIdentity): string => {
  const who = [identity.fullName, identity.email && `<${identity.email}>`]
    .filter(Boolean)
    .join(' ');
  const business = identity.businessName
    ? `${identity.businessName} (${identity.businessId})`
    : identity.businessId;

  return `Environment: ${environment}
User: ${who === '' ? identity.userId : `${who} (${identity.userId})`}
Business: ${business}
`;
};

/** `<prefix>: <message>` to stderr, exit 1. `oneLine` collapses it and drops any API hint. */
function report(
  deps: AuthCommandDeps,
  error: unknown,
  { prefix = 'Error', oneLine = false } = {},
): void {
  const message = errorMessage(error);
  const hint = error instanceof KizenApiError && error.hint !== undefined ? `\n${error.hint}` : '';

  deps.writeStderr(
    `${prefix}: ${oneLine ? message.replace(/\s+/g, ' ').trim() : `${message}${hint}`}\n`,
  );
  deps.setExitCode(1);
}

export type AuthCommand = (options: { env?: string }, deps: AuthCommandDeps) => Promise<void>;

const guarded =
  (run: AuthCommand): AuthCommand =>
  async (options, deps) => {
    try {
      await run(options, deps);
    } catch (error) {
      report(deps, error);
    }
  };

export const runLogin = guarded(async (options, deps) => {
  const environment = requireEnvironment(options.env ?? DEFAULT_LOGIN_ENVIRONMENT);

  deps.writeStderr(`Signing in to ${environment}.\n`);
  await login(environment, deps.loginDeps);
  deps.writeStdout(`Signed in to ${environment}.\n`);

  try {
    deps.writeStdout(identityLines(environment, await deps.getIdentity(environment)));
  } catch (error) {
    deps.writeStderr(`Signed in, but couldn't load the account details: ${errorMessage(error)}\n`);
  }
});

export const runLogout = guarded(async (options, deps) => {
  const resolved = await resolveSessionEnvironment(options.env, () => deps.store.listSessions());

  if (!resolved.ok) {
    if (resolved.problem !== 'not_signed_in') {
      throw new Error(resolved.message);
    }

    deps.writeStdout('Not signed in.\n');

    return;
  }

  const { environment } = resolved;
  // Never reads the file, so an unreadable session is removed too.
  const deleted = await mutateSession(deps.store, environment, () =>
    deps.store.deleteSession(environment),
  );

  deps.writeStdout(
    deleted
      ? `Signed out of ${environment}. The session was removed from this machine.\n`
      : `Not signed in to ${environment}.\n`,
  );
});

export const runWhoami = guarded(async (options, deps) => {
  const environment = await sessionEnvironment(options.env, deps.store);

  deps.writeStdout(identityLines(environment, await deps.getIdentity(environment)));
});

function serverEnvironment(serverUrl: string): { environment: Environment; origin: string } {
  let origin: string;

  try {
    origin = new URL(serverUrl).origin;
  } catch {
    throw new Error(
      "CLAUDE_CODE_MCP_SERVER_URL is not a valid URL, so auth-header won't send a token.",
    );
  }

  const environment = ENVIRONMENTS.find((candidate) => apiOriginFor(candidate) === origin);

  if (environment === undefined) {
    throw new Error(
      `No Kizen environment matches the MCP server ${origin}, so auth-header won't send it a token.`,
    );
  }

  return { environment, origin };
}

/**
 * Origin guard: with CLAUDE_CODE_MCP_SERVER_URL set, its origin must match a Kizen environment
 * and --env must agree, so a token only goes to the environment it belongs to. Without it,
 * --env, else the only signed-in environment.
 */
async function headerEnvironment(
  env: string | undefined,
  deps: AuthCommandDeps,
): Promise<Environment> {
  const explicit = env === undefined ? undefined : requireEnvironment(env);
  const serverUrl = deps.processEnv.CLAUDE_CODE_MCP_SERVER_URL;

  if (serverUrl !== undefined && serverUrl !== '') {
    const server = serverEnvironment(serverUrl);

    if (explicit !== undefined && explicit !== server.environment) {
      throw new Error(
        `--env ${explicit} doesn't match the MCP server ${server.origin} (${server.environment}), so auth-header won't send it a token.`,
      );
    }

    return server.environment;
  }

  return explicit ?? sessionEnvironment(undefined, deps.store);
}

/** Claude Code `headersHelper`. Failures print one stderr line and nothing to stdout. */
export const runAuthHeader: AuthCommand = async (options, deps) => {
  let line: string;

  try {
    const environment = await headerEnvironment(options.env, deps);
    const { requestTimeoutMs, lockWaitMs } = deps.authHeaderTimeouts;
    const token = await deps
      .tokenProvider(environment, { requestTimeoutMs, lock: { waitMs: lockWaitMs } })
      .getAccessToken();

    line = `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`;
  } catch (error) {
    report(deps, error, { prefix: 'appbuilder auth-header', oneLine: true });

    return;
  }

  deps.writeStdout(line);
};
