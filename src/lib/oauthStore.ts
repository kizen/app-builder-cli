/**
 * On-disk OAuth state, kept in `<credentials dir>/oauth/` so none of it is a
 * top-level `*.json` that `listCredentialProfiles` would mistake for an API-key
 * profile:
 *
 *   oauth/          0700
 *     <env>.json    0600  the session (tokens) for one environment
 *     clients.json  0600  DCR client_id cache, keyed by issuer
 *
 * Nothing is locked: every write is an atomic rename, and the token provider re-reads before it
 * writes (see `createTokenProvider`).
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ENVIRONMENTS, GLOBAL_CREDENTIALS_DIR, type Environment } from './credentials.js';
import { ifExists, isRecord, nonEmptyString } from './guards.js';
import { loginRequired } from './oauth.js';

export interface OAuthSession {
  environment: Environment;
  /**
   * Random per login, kept across refreshes. A token provider pins it so a later
   * login (another business, say) never feeds its tokens into a running command.
   */
  loginId: string;
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken: string | undefined;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string | undefined;
}

export interface OAuthStore {
  dir: string;
  sessionPath: (environment: Environment) => string;
  /** Null when there is none. An unreadable session file throws an OAuthError naming it. */
  readSession: (environment: Environment) => Promise<OAuthSession | null>;
  writeSession: (session: OAuthSession) => Promise<void>;
  /** Returns whether a session file existed. Never reads the file. */
  deleteSession: (environment: Environment) => Promise<boolean>;
  /** Readable or not, so a corrupt file is reported on use rather than as "not signed in". */
  listSessions: () => Promise<Environment[]>;
  readClientId: (issuer: string) => Promise<string | undefined>;
  writeClientId: (issuer: string, clientId: string) => Promise<void>;
  forgetClientId: (issuer: string) => Promise<void>;
}

const CLIENTS_FILE = 'clients.json';

function parseSession(raw: unknown, environment: Environment): OAuthSession | null {
  if (!isRecord(raw)) {
    return null;
  }

  const loginId = nonEmptyString(raw.loginId);

  if (
    raw.environment !== environment ||
    loginId === undefined ||
    typeof raw.issuer !== 'string' ||
    typeof raw.clientId !== 'string' ||
    typeof raw.tokenEndpoint !== 'string' ||
    typeof raw.accessToken !== 'string' ||
    typeof raw.expiresAt !== 'number'
  ) {
    return null;
  }

  return {
    environment,
    loginId,
    issuer: raw.issuer,
    clientId: raw.clientId,
    tokenEndpoint: raw.tokenEndpoint,
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
    expiresAt: raw.expiresAt,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
  };
}

/** @param baseDir the credentials directory; `oauth/` is created inside it. */
export function createOAuthStore(baseDir: string = GLOBAL_CREDENTIALS_DIR): OAuthStore {
  const dir = join(baseDir, 'oauth');
  const sessionPath = (environment: Environment): string => join(dir, `${environment}.json`);
  const clientsPath = join(dir, CLIENTS_FILE);

  const ensureDir = async (): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory's mode alone.
    await chmod(dir, 0o700);
  };

  /** Writes via a 0600 temp file and rename, so readers never see a partial file. */
  const writeAtomic = async (path: string, data: unknown): Promise<void> => {
    await ensureDir();

    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;

    try {
      const handle = await open(tmp, 'wx', 0o600);

      try {
        await handle.writeFile(JSON.stringify(data, null, 2), 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  };

  /** Only a cache: a missing or corrupt file reads as empty and costs one re-registration. */
  const readClients = async (): Promise<Record<string, unknown>> => {
    let raw: unknown;

    try {
      raw = JSON.parse((await ifExists(readFile(clientsPath, 'utf-8'))) ?? '{}') as unknown;
    } catch (err) {
      if (err instanceof SyntaxError) {
        return {};
      }

      throw err;
    }

    return isRecord(raw) ? raw : {};
  };

  return {
    dir,
    sessionPath,

    async readSession(environment) {
      const path = sessionPath(environment);

      try {
        const text = await ifExists(readFile(path, 'utf-8'));

        if (text === undefined) {
          return null;
        }

        const session = parseSession(JSON.parse(text) as unknown, environment);

        if (session !== null) {
          return session;
        }
      } catch {
        // Not passed on: a JSON.parse message would quote the file's contents.
      }

      const reason = `The saved ${environment} session at ${path} can't be read.`;

      throw loginRequired(environment, reason, { again: true });
    },

    async writeSession(session) {
      await writeAtomic(sessionPath(session.environment), session);
    },

    async deleteSession(environment) {
      return (await ifExists(unlink(sessionPath(environment)).then(() => true))) ?? false;
    },

    async listSessions() {
      const found = await Promise.all(
        ENVIRONMENTS.map((environment) =>
          ifExists(stat(sessionPath(environment)).then(() => environment)),
        ),
      );

      return found.filter((environment) => environment !== undefined);
    },

    async readClientId(issuer) {
      const entry = (await readClients())[issuer];

      return isRecord(entry) ? nonEmptyString(entry.clientId) : undefined;
    },

    // Read-modify-write, unlocked: a concurrent update can be lost, which costs one extra
    // client registration on a later login.
    async writeClientId(issuer, clientId) {
      await writeAtomic(clientsPath, { ...(await readClients()), [issuer]: { clientId } });
    },

    async forgetClientId(issuer) {
      const clients = await readClients();

      if (issuer in clients) {
        await writeAtomic(
          clientsPath,
          Object.fromEntries(Object.entries(clients).filter(([key]) => key !== issuer)),
        );
      }
    },
  };
}
