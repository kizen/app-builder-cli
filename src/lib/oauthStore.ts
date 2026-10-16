/**
 * On-disk OAuth state, kept in `<credentials dir>/oauth/` so none of it is a
 * top-level `*.json` that `listCredentialProfiles` would mistake for an API-key
 * profile:
 *
 *   oauth/                      0700
 *     <env>.json                0600  the session (tokens) for one environment
 *     <env>.lock.<n>            0600  generation n of the environment's lock
 *     <env>.lock.<n>.released   0600  generation n was released
 *     clients.json              0600  DCR client_id cache, keyed by issuer
 *     clients.lock.<n>[.released]     lock for clients.json updates
 */
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { ENVIRONMENTS, GLOBAL_CREDENTIALS_DIR, type Environment } from './credentials.js';
import { isErrnoCode, isRecord } from './guards.js';
import { loginCommandFor, OAuthError } from './oauth.js';

export interface OAuthSession {
  environment: Environment;
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken: string | undefined;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string | undefined;
}

export interface LockOptions {
  /** A lock file older than this is presumed abandoned and taken over. */
  staleMs?: number;
  retryMs?: number;
  /** Give up waiting for another process after this long. */
  waitMs?: number;
}

export interface OAuthStore {
  dir: string;
  sessionPath: (environment: Environment) => string;
  /**
   * The stored session, or null when there is none. A session file that exists
   * but can't be read or parsed throws an OAuthError naming the file.
   */
  readSession: (environment: Environment) => Promise<OAuthSession | null>;
  writeSession: (session: OAuthSession) => Promise<void>;
  /** Returns whether a session file existed. Never reads the file. */
  deleteSession: (environment: Environment) => Promise<boolean>;
  /**
   * Environments with a session file, readable or not, so a corrupt file is
   * reported when it's used rather than looking like "not signed in".
   */
  listSessions: () => Promise<Environment[]>;
  readClientId: (issuer: string) => Promise<string | undefined>;
  writeClientId: (issuer: string, clientId: string) => Promise<void>;
  /** `options` bounds the wait for the clients.json lock. */
  forgetClientId: (issuer: string, options?: LockOptions) => Promise<void>;
  /**
   * Takes the per-environment session lock (held around a refresh, and around
   * the session write at login and the delete at logout); resolves with its
   * release function.
   */
  acquireLock: (environment: Environment, options?: LockOptions) => Promise<() => Promise<void>>;
}

export interface OAuthStoreOptions {
  /**
   * Probes a process the way `process.kill(pid, 0)` does: returns if it exists,
   * throws `ESRCH` if it doesn't. Tests inject it.
   */
  probeProcess?: (pid: number) => void;
  /** The pid written into this store's lock files. Defaults to `process.pid`. */
  pid?: number;
}

const CLIENTS_FILE = 'clients.json';
const CLIENTS_LOCK = 'clients';
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 100;
const DEFAULT_WAIT_MS = 35_000;
/** A lock file's whole contents: `<pid> <32 hex>`. A partial write never matches. */
const NONCE = /^([1-9]\d*) [0-9a-f]{32}$/;

function parseSession(raw: unknown, environment: Environment): OAuthSession | null {
  if (
    !isRecord(raw) ||
    raw.environment !== environment ||
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
    issuer: raw.issuer,
    clientId: raw.clientId,
    tokenEndpoint: raw.tokenEndpoint,
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
    expiresAt: raw.expiresAt,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
  };
}

/** Never carries the file's contents (a JSON.parse message would quote them). */
const unreadableSession = (environment: Environment, path: string): OAuthError =>
  new OAuthError(
    'login_required',
    `The saved ${environment} session at ${path} can't be read. Run \`${loginCommandFor(environment)}\` to sign in again.`,
  );

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultProbe = (pid: number): void => {
  process.kill(pid, 0);
};

/**
 * @param baseDir the credentials directory; `oauth/` is created inside it.
 * Defaults to `~/.kizenappbuilder`. Tests pass a temp dir.
 */
export function createOAuthStore(
  baseDir: string = GLOBAL_CREDENTIALS_DIR,
  options: OAuthStoreOptions = {},
): OAuthStore {
  const dir = join(baseDir, 'oauth');
  const probeProcess = options.probeProcess ?? defaultProbe;
  const pid = options.pid ?? process.pid;
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

  /**
   * clients.json is only a cache: a missing or corrupt file reads as empty and
   * is replaced on the next write, which costs one client registration.
   */
  const readClients = async (): Promise<Record<string, unknown>> => {
    let raw: unknown;

    try {
      raw = JSON.parse(await readFile(clientsPath, 'utf-8')) as unknown;
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT') || err instanceof SyntaxError) {
        return {};
      }

      throw err;
    }

    return isRecord(raw) ? raw : {};
  };

  // --- Locks ---------------------------------------------------------------
  //
  // POSIX has no atomic "delete this file if it still holds X", so a lock that
  // is broken or released by deleting one fixed path always has a window where
  // it deletes, or moves aside, a successor's lock. (Renaming it aside and
  // restoring a lock that turns out to be live leaves the path empty for a
  // moment, and a third taker can create a lock in that gap.) So nothing
  // here ever deletes the current lock. Instead the lock has generations:
  //
  // - `<name>.lock.<n>` is created with O_EXCL by the process that takes
  //   generation n. Only one creator of a given n can succeed.
  // - The holder is the creator of the highest n. To take the lock you must
  //   see the highest generation free (released, its pid dead on this
  //   machine, or its file older than staleMs), and then create n + 1. Two
  //   takers of the same stale generation race on that one create, so
  //   exactly one wins; the loser sees n + 1 held and waits.
  // - Release only creates `<name>.lock.<n>.released`. It never deletes, so a
  //   holder that overran staleMs and was superseded only marks its own old
  //   generation, which nobody looks at any more.
  // - A new holder deletes generations below its own. The highest generation
  //   ever created is therefore never deleted. A slow taker can still recreate
  //   an old, deleted number; after creating, it checks for any higher
  //   generation and, finding one (one always exists in that case), marks its
  //   file released and starts over.

  const lockFile = (name: string, generation: number): string =>
    join(dir, `${name}.lock.${String(generation)}`);
  const releasedFile = (name: string, generation: number): string =>
    `${lockFile(name, generation)}.released`;

  /** Generations present on disk, from both lock and released files. */
  const lockEntries = async (
    name: string,
  ): Promise<{ entry: string; generation: number; released: boolean }[]> => {
    const prefix = `${name}.lock.`;

    return (await readdir(dir)).flatMap((entry) => {
      if (!entry.startsWith(prefix)) {
        return [];
      }

      // Canonical numbers only: `007` would parse as 7 but never be `lockFile(7)`.
      const match = /^(0|[1-9]\d*)(\.released)?$/.exec(entry.slice(prefix.length));

      return match?.[1] === undefined
        ? []
        : [{ entry, generation: Number(match[1]), released: match[2] !== undefined }];
    });
  };

  /** The highest generation with a lock file, or -1. */
  const topGeneration = async (name: string): Promise<number> =>
    Math.max(
      -1,
      ...(await lockEntries(name)).filter((lock) => !lock.released).map((lock) => lock.generation),
    );

  /**
   * Whether the pid in a lock nonce is gone from this machine. EPERM means alive.
   * Only meaningful for a holder on this machine; a home directory shared across
   * machines falls back to the staleMs rule only when the pid happens to exist here.
   */
  const holderIsDead = (nonce: string): boolean => {
    const holder = Number(NONCE.exec(nonce)?.[1]);

    if (!Number.isSafeInteger(holder)) {
      return false;
    }

    try {
      probeProcess(holder);

      return false;
    } catch (err) {
      return isErrnoCode(err, 'ESRCH');
    }
  };

  /** 'gone' when the generation was deleted meanwhile (a newer one exists). */
  const generationState = async (
    name: string,
    generation: number,
    staleMs: number,
  ): Promise<'free' | 'held' | 'gone'> => {
    const path = lockFile(name, generation);

    try {
      await stat(releasedFile(name, generation));

      return 'free';
    } catch (err) {
      if (!isErrnoCode(err, 'ENOENT')) {
        throw err;
      }
    }

    try {
      const nonce = await readFile(path, 'utf-8');

      if (holderIsDead(nonce)) {
        return 'free';
      }

      return Date.now() - (await stat(path)).mtimeMs > staleMs ? 'free' : 'held';
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) {
        return 'gone';
      }

      throw err;
    }
  };

  const markReleased = async (name: string, generation: number): Promise<void> => {
    try {
      await writeFile(releasedFile(name, generation), '', { mode: 0o600 });
    } catch (err) {
      if (!isErrnoCode(err, 'ENOENT')) {
        throw err;
      }
    }
  };

  /** Creates generation n with O_EXCL; false if another taker created it first. */
  const claim = async (name: string, generation: number, nonce: string): Promise<boolean> => {
    let handle;

    try {
      handle = await open(lockFile(name, generation), 'wx', 0o600);
    } catch (err) {
      if (isErrnoCode(err, 'EEXIST')) {
        return false;
      }

      throw err;
    }

    try {
      await handle.writeFile(nonce, 'utf-8');
    } catch (err) {
      await handle.close().catch(() => undefined);
      // Never delete a generation that may be the highest; mark it instead.
      await markReleased(name, generation).catch(() => undefined);
      throw err;
    }

    await handle.close();

    return true;
  };

  /** Best effort: a failed cleanup only leaves files the next holder removes. */
  const removeOlder = async (name: string, generation: number): Promise<void> => {
    const older = (await lockEntries(name).catch(() => [])).filter(
      (lock) => lock.generation < generation,
    );

    await Promise.all(
      older.map((lock) => rm(join(dir, lock.entry), { force: true }).catch(() => undefined)),
    );
  };

  const acquire = async (
    name: string,
    options: LockOptions,
    timeoutMessage: () => string,
  ): Promise<() => Promise<void>> => {
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const started = Date.now();
    const checkTimeout = (): void => {
      if (Date.now() - started > waitMs) {
        throw new Error(timeoutMessage());
      }
    };

    await ensureDir();

    for (;;) {
      const top = await topGeneration(name);
      const state = top < 0 ? 'free' : await generationState(name, top, staleMs);

      if (state === 'free') {
        const mine = top + 1;
        const nonce = `${String(pid)} ${randomBytes(16).toString('hex')}`;

        if (await claim(name, mine, nonce)) {
          if ((await topGeneration(name)) > mine) {
            // A recreated old number; a newer generation is the real lock.
            await markReleased(name, mine);
          } else {
            await removeOlder(name, mine);

            let released = false;

            return async () => {
              if (!released) {
                released = true;
                await markReleased(name, mine);
              }
            };
          }
        }

        // Lost the race for `mine`, or backed off: the new state is already on
        // disk, so retry without sleeping, but still within waitMs.
        checkTimeout();
        continue;
      }

      checkTimeout();

      if (state === 'gone') {
        continue;
      }

      await sleep(retryMs);
    }
  };

  const withLock = async <T>(
    name: string,
    options: LockOptions,
    timeoutMessage: () => string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const release = await acquire(name, options, timeoutMessage);

    try {
      return await run();
    } finally {
      await release();
    }
  };

  const clientsTimeout = (): string =>
    `Timed out waiting for another appbuilder process to update the saved app registrations (${clientsPath})`;

  return {
    dir,
    sessionPath,

    async readSession(environment) {
      const path = sessionPath(environment);
      let text: string;

      try {
        text = await readFile(path, 'utf-8');
      } catch (err) {
        if (isErrnoCode(err, 'ENOENT')) {
          return null;
        }

        throw unreadableSession(environment, path);
      }

      let raw: unknown;

      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        throw unreadableSession(environment, path);
      }

      const session = parseSession(raw, environment);

      if (session === null) {
        throw unreadableSession(environment, path);
      }

      return session;
    },

    async writeSession(session) {
      await writeAtomic(sessionPath(session.environment), session);
    },

    async deleteSession(environment) {
      try {
        await unlink(sessionPath(environment));

        return true;
      } catch (err) {
        if (isErrnoCode(err, 'ENOENT')) {
          return false;
        }

        throw err;
      }
    },

    async listSessions() {
      const found = await Promise.all(
        ENVIRONMENTS.map(async (environment) => {
          try {
            await stat(sessionPath(environment));

            return environment;
          } catch (err) {
            if (isErrnoCode(err, 'ENOENT')) {
              return null;
            }

            throw err;
          }
        }),
      );

      return found.filter((environment): environment is Environment => environment !== null);
    },

    async readClientId(issuer) {
      const entry = (await readClients())[issuer];

      return isRecord(entry) && typeof entry.clientId === 'string' && entry.clientId !== ''
        ? entry.clientId
        : undefined;
    },

    async writeClientId(issuer, clientId) {
      await withLock(CLIENTS_LOCK, {}, clientsTimeout, async () => {
        await writeAtomic(clientsPath, { ...(await readClients()), [issuer]: { clientId } });
      });
    },

    async forgetClientId(issuer, lockOptions = {}) {
      await withLock(CLIENTS_LOCK, lockOptions, clientsTimeout, async () => {
        const clients = await readClients();

        if (issuer in clients) {
          await writeAtomic(
            clientsPath,
            Object.fromEntries(Object.entries(clients).filter(([key]) => key !== issuer)),
          );
        }
      });
    },

    acquireLock(environment, lockOptions = {}) {
      return acquire(
        environment,
        lockOptions,
        () =>
          `Timed out waiting for another appbuilder process using the ${environment} session (${join(dir, `${environment}.lock.*`)})`,
      );
    },
  };
}
