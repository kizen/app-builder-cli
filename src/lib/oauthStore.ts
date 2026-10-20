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
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENVIRONMENTS, GLOBAL_CREDENTIALS_DIR, type Environment } from './credentials.js';
import { ifExists, isErrnoCode, isRecord, nonEmptyString } from './guards.js';
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

export interface LockOptions {
  /** A lock file older than this is presumed abandoned and taken over. */
  staleMs?: number;
  retryMs?: number;
  /** Give up waiting for another process after this long. */
  waitMs?: number;
}

/**
 * A held lock: call it to release. `confirm` renews the lease and reports whether this is
 * still the holder (false once released or superseded). Call it right before each mutation.
 */
export type LockHandle = (() => Promise<void>) & { confirm: () => Promise<boolean> };

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
  /** `options` bounds the wait for the clients.json lock. */
  forgetClientId: (issuer: string, options?: LockOptions) => Promise<void>;
  /** The per-environment session lock, held around every session mutation. */
  acquireLock: (environment: Environment, options?: LockOptions) => Promise<LockHandle>;
}

interface OAuthStoreOptions {
  /** Like `process.kill(pid, 0)`: returns if the process exists, throws `ESRCH` if not. */
  probeProcess?: (pid: number) => void;
  /** Written into this store's lock files. Defaults to `process.pid`. */
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

const defaultProbe = (pid: number): void => {
  process.kill(pid, 0);
};

/** @param baseDir the credentials directory; `oauth/` is created inside it. */
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

  // --- Locks ---------------------------------------------------------------
  //
  // POSIX can't atomically "delete this file if it still holds X", so nothing here ever
  // deletes the current lock. Locks have generations; the highest n is the holder:
  // - Take the lock by creating `<name>.lock.<n+1>` with O_EXCL; one creator of a given n wins.
  // - Only once n is free: `.released`, its pid dead on this machine, or older than staleMs.
  // - Release only writes `<name>.lock.<n>.released`; it never deletes.
  // - A new holder deletes the generations below its own.
  // - A slow taker that recreates an old number sees a higher one, marks it released, backs off.
  // `confirm` (touch, then check nonce and top generation) runs right before each mutation, but
  // the confirm-to-mutate gap is NOT closed: a taker that saw the old mtime as stale can still
  // take n + 1 during it, and it spans the whole mutation through writeAtomic's fsync/rename.
  // Rationale, vault entry:
  // cli-oauth-via-kizen-dcr-what-webapp-supports-the-app-builder-poc-design-and-its-gotchas

  const lockFile = (name: string, generation: number): string =>
    join(dir, `${name}.lock.${String(generation)}`);
  const releasedFile = (name: string, generation: number): string =>
    `${lockFile(name, generation)}.released`;

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

  /** -1 when there is none. */
  const topGeneration = async (name: string): Promise<number> =>
    Math.max(
      -1,
      ...(await lockEntries(name)).filter((lock) => !lock.released).map((lock) => lock.generation),
    );

  /** EPERM means alive. Only meaningful on this machine; elsewhere staleMs decides. */
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

    if ((await ifExists(stat(releasedFile(name, generation)))) !== undefined) {
      return 'free';
    }

    const nonce = await ifExists(readFile(path, 'utf-8'));

    if (nonce === undefined) {
      return 'gone';
    }

    if (holderIsDead(nonce)) {
      return 'free';
    }

    const lock = await ifExists(stat(path));

    if (lock === undefined) {
      return 'gone';
    }

    return Date.now() - lock.mtimeMs > staleMs ? 'free' : 'held';
  };

  const markReleased = async (name: string, generation: number): Promise<void> => {
    await ifExists(writeFile(releasedFile(name, generation), '', { mode: 0o600 }));
  };

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

  const handleFor = (name: string, mine: number, nonce: string): LockHandle => {
    const path = lockFile(name, mine);
    let released = false;

    const confirm = async (): Promise<boolean> => {
      if (released) {
        return false;
      }

      // Renew first; then the file may be gone (a newer holder) or recreated by a slow taker.
      const now = new Date();
      const current = await ifExists(utimes(path, now, now).then(() => readFile(path, 'utf-8')));

      return current === nonce && (await topGeneration(name)) === mine;
    };

    return Object.assign(
      async () => {
        if (!released) {
          released = true;
          await markReleased(name, mine);
        }
      },
      { confirm },
    );
  };

  /** Null when another taker got n or a newer generation exists. */
  const tryTake = async (name: string, n: number): Promise<LockHandle | null> => {
    const nonce = `${String(pid)} ${randomBytes(16).toString('hex')}`;

    if (!(await claim(name, n, nonce))) {
      return null;
    }

    if ((await topGeneration(name)) > n) {
      // A recreated old number; a newer generation is the real lock.
      await markReleased(name, n);

      return null;
    }

    await removeOlder(name, n);

    return handleFor(name, n, nonce);
  };

  const acquire = async (
    name: string,
    options: LockOptions,
    timeoutMessage: string,
  ): Promise<LockHandle> => {
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const started = Date.now();

    await ensureDir();

    for (;;) {
      const top = await topGeneration(name);
      const state = top < 0 ? 'free' : await generationState(name, top, staleMs);
      const lock = state === 'free' ? await tryTake(name, top + 1) : null;

      if (lock) {
        return lock;
      }

      if (Date.now() - started > waitMs) {
        throw new Error(timeoutMessage);
      }

      // After a lost race, a back-off or a deleted generation, the new state is
      // already on disk: look again without sleeping.
      if (state === 'held') {
        await sleep(retryMs);
      }
    }
  };

  const withLock = async <T>(
    name: string,
    options: LockOptions,
    timeoutMessage: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const release = await acquire(name, options, timeoutMessage);

    try {
      return await run();
    } finally {
      await release();
    }
  };

  const clientsTimeout = `Timed out waiting for another appbuilder process to update the saved app registrations (${clientsPath})`;

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
        `Timed out waiting for another appbuilder process using the ${environment} session (${join(dir, `${environment}.lock.*`)})`,
      );
    },
  };
}

/** What a `withSessionLock` step returns when its `confirm` came back false. */
export const LEASE_LOST: unique symbol = Symbol('lease lost');

/** The first attempt included. */
const MAX_LEASE_ATTEMPTS = 3;

/** `mutate()` if `lock` is still held (see `withSessionLock`), else `LEASE_LOST`. */
export const whenConfirmed = async <T>(
  lock: LockHandle,
  mutate: () => Promise<T>,
): Promise<T | typeof LEASE_LOST> => ((await lock.confirm()) ? mutate() : LEASE_LOST);

/**
 * Every session mutation goes through here, so an in-flight refresh never writes its stale
 * session back over a newer login or a logout.
 *
 * The lease can lapse at any await (laptop sleep, a slow token request), so `step` must end in
 * `whenConfirmed`. On `LEASE_LOST` the lock is re-taken and `step` re-run from the start, so it
 * re-reads what it checks. For a refresh, re-taking keeps the rotated tokens once the old refresh
 * token is spent server-side.
 *
 * `held` is a lock the caller already holds, used for the first attempt and released here.
 */
export async function withSessionLock<T>(
  store: OAuthStore,
  environment: Environment,
  step: (lock: LockHandle) => Promise<T | typeof LEASE_LOST>,
  { lock: options, held }: { lock?: LockOptions | undefined; held?: LockHandle } = {},
): Promise<T> {
  let lock = held ?? (await store.acquireLock(environment, options));

  for (let attempt = 1; ; attempt += 1) {
    let result: T | typeof LEASE_LOST;

    try {
      result = await step(lock);
    } finally {
      await lock();
    }

    if (result !== LEASE_LOST) {
      return result;
    }

    if (attempt >= MAX_LEASE_ATTEMPTS) {
      throw new Error(
        `Another appbuilder process kept taking over the ${environment} session lock. Run the command again.`,
      );
    }

    lock = await store.acquireLock(environment, options);
  }
}

/** Runs one session mutation under the session lock, confirmed (see `withSessionLock`). */
export const mutateSession = <T>(
  store: OAuthStore,
  environment: Environment,
  mutate: () => Promise<T>,
): Promise<T> => withSessionLock(store, environment, (lock) => whenConfirmed(lock, mutate));
