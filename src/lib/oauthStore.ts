/**
 * On-disk OAuth state, kept in `<credentials dir>/oauth/` so none of it is a
 * top-level `*.json` that `listCredentialProfiles` would mistake for an API-key
 * profile:
 *
 *   oauth/                          0700
 *     <env>.json                    0600  pointer: `{ "businessId", "userId" }`, the current account
 *     <env>.<business>.<user>.json  0600  one saved account's session (tokens and labels)
 *     <env>.<business>.<user>.lock  0600  its holder's random nonce; exists only while held
 *     clients.json                  0600  DCR client_id cache, keyed by issuer
 *
 * `<business>` and `<user>` are the account's ids, lowercase UUIDs as Kizen issues them. Each
 * account file is a saved account; the pointer picks the current one.
 *
 * Every write is an atomic rename. Only login, a switch and logout move the pointer, and a refresh
 * only ever writes or deletes its own account's file, so it can't undo a logout of another account
 * or a switch. Its write and a logout's unlink of that same file are serialized by the account's
 * lock (`withLockFile`): the refresh writes only if, under the lock, the file is still there with
 * the refresh token it spent (`commitRefresh`), so a refresh that finishes after a logout can't
 * bring the account back. The lock is best effort, as in GitHub CLI's `refresh.lock`: a lock not
 * acquired within `waitMs` is skipped, leaving that one operation to race as it would unlocked,
 * rather than wedging the CLI. Nothing else is locked. Accepted: a logout racing a sign-in to the
 * same account can delete that sign-in's new session file, leaving the account signed out.
 *
 * A write, rename or unlink here that fails with EPERM, EACCES or EROFS (a sandbox that only allows
 * writes to the project, typically), or ENOSPC / EDQUOT (a full disk), throws
 * `SessionStoreUnwritableError`, which says how to fix it. `probeWritable` finds that out before a token is spent.
 */
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENVIRONMENTS, GLOBAL_CREDENTIALS_DIR, type Environment } from './credentials.js';
import { ifExists, isErrnoCode, isRecord, nonEmptyString } from './guards.js';
import {
  loginRequired,
  OAuthError,
  SessionStoreUnwritableError,
  UNWRITABLE_ERRNO_CODES,
} from './oauth.js';

/** Who a session acts as: a token is bound to one Kizen user in one business. */
export interface OAuthAccount {
  businessId: string;
  userId: string;
}

export interface OAuthSession extends OAuthAccount {
  environment: Environment;
  /** Labels from `/auth/bootstrap` at sign-in, so saved accounts can be listed offline. */
  businessName: string | undefined;
  fullName: string | undefined;
  email: string | undefined;
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** One `<env>.<business>.<user>.json` file. */
export interface SavedAccount {
  account: OAuthAccount;
  /** Undefined when the file can't be read; it's still listed, by its ids. */
  session: OAuthSession | undefined;
  /** Whether the pointer names it. */
  current: boolean;
}

export interface OAuthStore {
  dir: string;
  /** The pointer file, `<env>.json`; an unreadable one is reported by this path. */
  sessionPath: (environment: Environment) => string;
  /** One account's session file. Throws for an account id that fails validation. */
  accountPath: (environment: Environment, account: OAuthAccount) => string;
  /**
   * The session the pointer names. Null with no pointer, or when the file it names is gone. An
   * unreadable pointer or session file throws an OAuthError naming it.
   */
  readSession: (environment: Environment) => Promise<OAuthSession | null>;
  /** One saved account's session, current or not. Null when its file is gone; unreadable throws. */
  readAccount: (environment: Environment, account: OAuthAccount) => Promise<OAuthSession | null>;
  /** Every saved account for the environment, unreadable ones included, in a stable order. */
  listAccounts: (environment: Environment) => Promise<SavedAccount[]>;
  /** Writes this account's session file only, in place; never moves the pointer. */
  writeSession: (session: OAuthSession) => Promise<void>;
  /**
   * Proves the store can be written as a write here needs to (create the directory and set its
   * mode, create, write 4 KiB to, fsync and rename a file in it, remove it), leaving nothing behind. A refresh
   * calls it before spending its refresh token, and login before opening the browser, so neither
   * gets tokens it can't keep. Throws `SessionStoreUnwritableError` for EPERM, EACCES, EROFS,
   * ENOSPC or EDQUOT; any other failure as it is.
   */
  probeWritable: () => Promise<void>;
  /**
   * A refresh's write of `session`, under its account's lock: re-reads that account's own file and
   * writes only if it's still there holding `spentRefreshToken`, the token the refresh presented.
   * `'gone'`: the file was removed (a logout), so nothing is written and the account stays signed
   * out. `'rotated'`: a peer stored newer tokens (another refresh, or a sign-in again), which are
   * kept. Never moves the pointer. An unreadable file throws as `readAccount` does.
   */
  commitRefresh: (
    session: OAuthSession,
    spentRefreshToken: string,
  ) => Promise<'written' | 'rotated' | 'gone'>;
  /** Points the environment at `account` (after `writeSession` of it), then cleans up. */
  setCurrent: (environment: Environment, account: OAuthAccount) => Promise<void>;
  /**
   * Deletes this account's file only, under its lock (as every account-file delete here is, so a
   * `commitRefresh` in progress finishes first and the delete wins); never touches the pointer, so
   * a pointer to it then reads as not signed in. Returns whether the file existed.
   */
  deleteSession: (environment: Environment, account: OAuthAccount) => Promise<boolean>;
  /**
   * Removes the pointer, then the account file it named, without reading that file (so an
   * unreadable session is removed too). Other saved accounts stay. Returns whether anyone was
   * signed in: an unreadable pointer counts, a pointer to a missing file doesn't. Throws if the
   * account file is there but can't be removed (the pointer is already gone by then).
   */
  signOut: (environment: Environment) => Promise<boolean>;
  /**
   * Removes one saved account's file. When the pointer names it, the pointer goes first (moved
   * aside before it's read, as in `signOut`, and never restored). `removed` says whether the file
   * existed, `current` whether this removed the pointer, so nobody is signed in afterwards.
   */
  removeAccount: (
    environment: Environment,
    account: OAuthAccount,
  ) => Promise<{ removed: boolean; current: boolean }>;
  /**
   * Removes the pointer and every saved account for the environment. `signedIn` is as for
   * `signOut`; `removed` counts the account files deleted. Throws if one can't be removed.
   */
  signOutAll: (environment: Environment) => Promise<{ signedIn: boolean; removed: number }>;
  /**
   * Environments with a pointer that names an existing session file, or that can't be read, so a
   * corrupt file is reported on use rather than as "not signed in". Saved accounts that aren't
   * current don't count.
   */
  listSessions: () => Promise<Environment[]>;
  readClientId: (issuer: string) => Promise<string | undefined>;
  writeClientId: (issuer: string, clientId: string) => Promise<void>;
  forgetClientId: (issuer: string) => Promise<void>;
}

const CLIENTS_FILE = 'clients.json';

/** What `probeWritable` writes: 4 KiB, above any session file (about 1 KiB of JSON). */
const PROBE_PAYLOAD = ' '.repeat(4096);

/**
 * A `<env>.json.<ms>-<hex>.signout` file is a pointer a logout moved aside and crashed before
 * removing. `<ms>` is when that logout moved it (epoch milliseconds), so its age is measured from
 * the logout, not from the pointer's mtime, which the rename keeps. It's deleted once older than
 * this, so a logout in progress keeps its own.
 */
export const SIGNOUT_MAX_AGE_MS = 10 * 60_000;

export interface LockFileOptions {
  /** How long to wait for a live lock before going ahead without it. */
  waitMs: number;
  /** A lock file older than this (by mtime) was left by a crash, and is taken over. */
  staleMs: number;
  /** How often a waiter retries. */
  pollMs: number;
}

/**
 * An account lock is held for one read and one fsync'd atomic write, or one unlink: milliseconds.
 * `waitMs` covers a slow disk while keeping `auth-header` inside Claude Code's 10s helper limit: a
 * refresh takes the lock once (its commit or its delete), after a request of at most 5s. `staleMs`
 * is far above any real hold, so only a lock whose holder died (or was stopped, or slept with the
 * laptop) mid-hold is taken over; a process that resumes after that races as an unlocked one would.
 */
export const ACCOUNT_LOCK: LockFileOptions = { waitMs: 2_000, staleMs: 30_000, pollMs: 25 };

/**
 * Creates `path` exclusively and writes a random nonce into it, waiting up to `waitMs` for a live
 * holder and taking over a stale file. Resolves to the nonce, which tells this holder's file from
 * a successor's on release (an inode number can be reused at once, and isn't reliable on Windows
 * or FAT). Undefined when it can't: timed out, or any error but EEXIST (a missing directory too,
 * where there's nothing yet to race over). The handle is closed at once, so the file can be
 * unlinked on Windows while held. Others only stat a lock, by mtime, so one just created and
 * still empty is live like any other.
 *
 * Best effort: two waiters that both judge one file stale can each remove it, the later removing
 * the earlier's new lock, and then both hold it. That's the unlocked race again, for that pair.
 */
async function acquireLockFile(
  path: string,
  { waitMs, staleMs, pollMs }: LockFileOptions,
): Promise<string | undefined> {
  const deadline = Date.now() + waitMs;

  for (;;) {
    let handle: FileHandle;

    try {
      handle = await open(path, 'wx', 0o600);
    } catch (err) {
      if (!isErrnoCode(err, 'EEXIST')) {
        return undefined;
      }

      try {
        const holder = await ifExists(stat(path));

        // Released since the open: try again at once.
        if (holder === undefined) {
          continue;
        }

        if (Date.now() - holder.mtimeMs > staleMs) {
          await ifExists(unlink(path));
          continue;
        }
      } catch {
        return undefined;
      }

      if (Date.now() >= deadline) {
        return undefined;
      }

      await sleep(pollMs);
      continue;
    }

    let nonce: string | undefined = randomBytes(16).toString('hex');

    try {
      await handle.writeFile(nonce, 'utf-8');
    } catch {
      // Without its nonce the release couldn't tell this file from a successor's.
      nonce = undefined;
    }

    try {
      await handle.close();
    } catch {
      nonce = undefined;
    }

    if (nonce === undefined) {
      await rm(path, { force: true }).catch(() => undefined);
    }

    return nonce;
  }
}

/**
 * Runs `run` holding the lock file `path` (see `acquireLockFile`), or without it once `waitMs` has
 * passed, so a lock never wedges the CLI. `held` says which. The file exists only while held: it's
 * removed whether `run` resolves or throws, and only if it still holds this call's nonce.
 */
export async function withLockFile<T>(
  path: string,
  options: LockFileOptions,
  run: () => Promise<T>,
): Promise<{ value: T; held: boolean }> {
  const lock = await acquireLockFile(path, options);

  try {
    return { value: await run(), held: lock !== undefined };
  } finally {
    if (lock !== undefined) {
      try {
        // Another nonce: taken over as stale meanwhile, so that file is the new holder's.
        if ((await ifExists(readFile(path, 'utf-8'))) === lock) {
          await ifExists(unlink(path));
        }
      } catch {
        // Best effort: a lock left behind is taken over once stale, or removed by `cleanUp`.
      }
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const validId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** `{ businessId, userId }` if both are valid ids, else undefined. */
const validAccount = (raw: unknown): OAuthAccount | undefined =>
  isRecord(raw) && validId(raw.businessId) && validId(raw.userId)
    ? { businessId: raw.businessId, userId: raw.userId }
    : undefined;

export const sameAccount = (a: OAuthAccount, b: OAuthAccount): boolean =>
  a.businessId === b.businessId && a.userId === b.userId;

/** The file-name key for an account, `<business>.<user>`. Throws for an invalid id. */
export const accountKey = (account: OAuthAccount): string => {
  if (validAccount(account) === undefined) {
    throw new Error('Refusing a session file name built from an invalid account id.');
  }

  return `${account.businessId}.${account.userId}`;
};

/** The pointer's account; undefined unless the file holds a valid `{ businessId, userId }`. */
function parsePointer(text: string): OAuthAccount | undefined {
  let raw: unknown;

  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }

  return validAccount(raw);
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function parseSession(raw: unknown, environment: Environment): OAuthSession | null {
  const account = validAccount(raw);

  if (
    !isRecord(raw) ||
    account === undefined ||
    raw.environment !== environment ||
    typeof raw.issuer !== 'string' ||
    typeof raw.clientId !== 'string' ||
    typeof raw.tokenEndpoint !== 'string' ||
    typeof raw.accessToken !== 'string' ||
    typeof raw.refreshToken !== 'string' ||
    typeof raw.expiresAt !== 'number'
  ) {
    return null;
  }

  return {
    environment,
    ...account,
    businessName: optionalString(raw.businessName),
    fullName: optionalString(raw.fullName),
    email: optionalString(raw.email),
    issuer: raw.issuer,
    clientId: raw.clientId,
    tokenEndpoint: raw.tokenEndpoint,
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: raw.expiresAt,
  };
}

export interface OAuthStoreOptions {
  /** The account lock's timings; `ACCOUNT_LOCK` by default. */
  lock?: Partial<LockFileOptions>;
}

/** @param baseDir the credentials directory; `oauth/` is created inside it. */
export function createOAuthStore(
  baseDir: string = GLOBAL_CREDENTIALS_DIR,
  options: OAuthStoreOptions = {},
): OAuthStore {
  const dir = join(baseDir, 'oauth');
  const lockOptions: LockFileOptions = { ...ACCOUNT_LOCK, ...options.lock };
  const sessionPath = (environment: Environment): string => join(dir, `${environment}.json`);
  const accountPath = (environment: Environment, account: OAuthAccount): string =>
    join(dir, `${environment}.${accountKey(account)}.json`);
  /** A stable name beside the account file, which is replaced by rename on every write. */
  const lockPath = (environment: Environment, account: OAuthAccount): string =>
    join(dir, `${environment}.${accountKey(account)}.lock`);

  /** `run` under the account's lock, or without it after `waitMs` (see `withLockFile`). */
  const underAccountLock = async <T>(
    environment: Environment,
    account: OAuthAccount,
    run: () => Promise<T>,
  ): Promise<T> => (await withLockFile(lockPath(environment, account), lockOptions, run)).value;
  const clientsPath = join(dir, CLIENTS_FILE);

  /** The account a file name in `dir` holds, for this environment; undefined for anything else. */
  const accountOfName = (environment: Environment, name: string): OAuthAccount | undefined => {
    const prefix = `${environment}.`;

    if (!name.startsWith(prefix) || !name.endsWith('.json')) {
      return undefined;
    }

    const segments = name.slice(prefix.length, -'.json'.length).split('.');

    if (segments.length !== 2) {
      return undefined;
    }

    const [businessId, userId] = segments;

    return validAccount({ businessId, userId });
  };

  const listNames = async (): Promise<string[]> => (await ifExists(readdir(dir))) ?? [];

  /** `run`, with `UNWRITABLE_ERRNO_CODES` as `SessionStoreUnwritableError`. */
  const writing = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      const errno = UNWRITABLE_ERRNO_CODES.find((code) => isErrnoCode(err, code));

      if (errno !== undefined) {
        throw new SessionStoreUnwritableError(dir, dirname(dir), errno);
      }

      throw err;
    }
  };

  const ensureDir = async (): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory's mode alone.
    await chmod(dir, 0o700);
  };

  /** Writes `text` to a new 0600 temp file beside `path`, then renames it to `to`. */
  const writeThenRename = async (path: string, text: string, to: string): Promise<void> => {
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;

    try {
      const handle = await open(tmp, 'wx', 0o600);

      try {
        await handle.writeFile(text, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(tmp, to);
    } catch (err) {
      // The original error is the one to report; a sandbox can refuse this cleanup too.
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  };

  /** Writes via a 0600 temp file and rename, so readers never see a partial file. */
  const writeAtomic = (path: string, data: unknown): Promise<void> =>
    writing(async () => {
      await ensureDir();
      await writeThenRename(path, JSON.stringify(data, null, 2), path);
    });

  const probeWritable = (): Promise<void> =>
    writing(async () => {
      await ensureDir();

      // Not a `<env>.<business>.<user>.json` name, so nothing lists it if a crash leaves it.
      const probe = join(dir, `.write-probe.${randomBytes(6).toString('hex')}`);

      // About a session file's size or more, so a full disk fails here and not at the commit.
      await writeThenRename(probe, PROBE_PAYLOAD, probe);
      await unlink(probe);
    });

  const unreadable = (environment: Environment, path: string): OAuthError =>
    loginRequired(environment, `The saved ${environment} session at ${path} can't be read.`, {
      again: true,
    });

  /**
   * Best effort, on login, switch and logout: deletes `<env>.json.<ms>-<hex>.signout` pointers a
   * crash left mid-logout once they're old enough, by the time in their name (when the logout
   * moved them aside), and account locks a crash left, once stale by their mtime (a lock is never
   * renamed). Only names matching those fixed patterns reach `join`.
   */
  const cleanUp = async (environment: Environment): Promise<void> => {
    try {
      const signout = new RegExp(`^${environment}\\.json\\.([0-9]{1,16})-[0-9a-f]{12}\\.signout$`);

      for (const name of await listNames()) {
        const movedAt = signout.exec(name)?.[1];

        if (movedAt !== undefined && Date.now() - Number(movedAt) > SIGNOUT_MAX_AGE_MS) {
          await ifExists(unlink(join(dir, name)));
        }

        const locked = name.endsWith('.lock')
          ? accountOfName(environment, `${name.slice(0, -'.lock'.length)}.json`)
          : undefined;

        if (locked !== undefined) {
          const path = lockPath(environment, locked);
          const lock = await ifExists(stat(path));

          // Read-then-unlink, as in a stale takeover; a lock this old has no live holder.
          if (lock !== undefined && Date.now() - lock.mtimeMs > lockOptions.staleMs) {
            await ifExists(unlink(path));
          }
        }
      }
    } catch {
      // Best effort: a later login or logout cleans up again.
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

  /** The file's text, or undefined if it's absent; any other read error makes it unreadable. */
  const readOrUnreadable = async (
    environment: Environment,
    path: string,
  ): Promise<string | undefined> => {
    try {
      return await ifExists(readFile(path, 'utf-8'));
    } catch {
      // EACCES, EISDIR, EIO, ...: not "not signed in", and not an error that names no file.
      throw unreadable(environment, path);
    }
  };

  const readAccount = async (
    environment: Environment,
    account: OAuthAccount,
  ): Promise<OAuthSession | null> => {
    const path = accountPath(environment, account);
    const text = await readOrUnreadable(environment, path);

    if (text === undefined) {
      return null;
    }

    try {
      const session = parseSession(JSON.parse(text) as unknown, environment);

      if (session !== null && sameAccount(session, account)) {
        return session;
      }
    } catch {
      // Not passed on: a JSON.parse message would quote the file's contents.
    }

    throw unreadable(environment, path);
  };

  /** The pointer's account; undefined with no pointer. An unreadable pointer throws. */
  const readPointer = async (environment: Environment): Promise<OAuthAccount | undefined> => {
    const pointerPath = sessionPath(environment);
    const pointer = await readOrUnreadable(environment, pointerPath);

    if (pointer === undefined) {
      return undefined;
    }

    const account = parsePointer(pointer);

    if (account === undefined) {
      throw unreadable(environment, pointerPath);
    }

    return account;
  };

  const readSession = async (environment: Environment): Promise<OAuthSession | null> => {
    const account = await readPointer(environment);

    return account === undefined ? null : readAccount(environment, account);
  };

  /**
   * Renames the pointer aside before reading it, so exactly the account it named is signed out,
   * and a login that lands meanwhile keeps its new pointer. Undefined with no pointer; `account`
   * is undefined for an unreadable one.
   */
  const takePointer = async (
    environment: Environment,
  ): Promise<{ account: OAuthAccount | undefined } | undefined> => {
    const pointerPath = sessionPath(environment);
    // The time goes in the name: cleanUp ages it from this logout, not from the pointer's mtime.
    const moved = `${pointerPath}.${String(Date.now())}-${randomBytes(6).toString('hex')}.signout`;

    if ((await writing(() => ifExists(rename(pointerPath, moved).then(() => true)))) !== true) {
      return undefined;
    }

    try {
      return { account: parsePointer(await readFile(moved, 'utf-8')) };
    } catch {
      return { account: undefined };
    } finally {
      await rm(moved, { force: true });
    }
  };

  /**
   * Unlinks one account file, under its lock so a `commitRefresh` in progress can't recreate it;
   * a failure other than "already gone" surfaces. Every logout's delete comes through here.
   */
  const unlinkAccount = (environment: Environment, account: OAuthAccount): Promise<boolean> =>
    underAccountLock(
      environment,
      account,
      async () =>
        (await writing(() =>
          ifExists(unlink(accountPath(environment, account)).then(() => true)),
        )) ?? false,
    );

  return {
    dir,
    sessionPath,
    accountPath,
    readSession,
    readAccount,

    async listAccounts(environment) {
      let current: OAuthAccount | undefined;

      try {
        current = await readPointer(environment);
      } catch {
        // An unreadable pointer names no account; the accounts are still listed.
      }

      const accounts = (await listNames())
        .map((name) => accountOfName(environment, name))
        .filter((account) => account !== undefined);
      const saved = await Promise.all(
        accounts.map(async (account): Promise<SavedAccount | undefined> => {
          let session: OAuthSession | undefined;

          try {
            const read = await readAccount(environment, account);

            // Deleted since the listing: not saved any more.
            if (read === null) {
              return undefined;
            }

            session = read;
          } catch (err) {
            if (!(err instanceof OAuthError && err.code === 'login_required')) {
              throw err;
            }
          }

          return {
            account,
            session,
            current: current !== undefined && sameAccount(current, account),
          };
        }),
      );
      const label = (entry: SavedAccount): string =>
        (entry.session?.businessName ?? entry.account.businessId).toLowerCase();

      return saved
        .filter((entry) => entry !== undefined)
        .sort(
          (a, b) =>
            label(a).localeCompare(label(b)) ||
            accountKey(a.account).localeCompare(accountKey(b.account)),
        );
    },

    async writeSession(session) {
      await writeAtomic(accountPath(session.environment, session), session);
    },

    probeWritable,

    async commitRefresh(session, spentRefreshToken) {
      const { environment } = session;

      return underAccountLock(environment, session, async () => {
        const stored = await readAccount(environment, session);

        if (stored === null) {
          return 'gone';
        }

        if (stored.refreshToken !== spentRefreshToken) {
          return 'rotated';
        }

        await writeAtomic(accountPath(environment, session), session);

        return 'written';
      });
    },

    async setCurrent(environment, account) {
      const { businessId, userId } = account;

      await writeAtomic(sessionPath(environment), { businessId, userId });
      await cleanUp(environment);
    },

    async deleteSession(environment, account) {
      return unlinkAccount(environment, account);
    },

    async signOut(environment) {
      const taken = await takePointer(environment);
      // An unreadable pointer counts as signed in; no account file is removed for it, since
      // there's no telling which it was (each one is a saved account).
      let signedIn = taken !== undefined;

      if (taken?.account !== undefined) {
        signedIn = await unlinkAccount(environment, taken.account);
      }

      await cleanUp(environment);

      return signedIn;
    },

    async removeAccount(environment, account) {
      let current = false;
      let pointer: OAuthAccount | undefined;

      try {
        pointer = await readPointer(environment);
      } catch {
        // An unreadable pointer names no account, so it isn't this one.
      }

      if (pointer !== undefined && sameAccount(pointer, account)) {
        // Whatever the moved-aside pointer names is signed out, even another account that a
        // switch made current between the read and the move: it's never put back, since a
        // restore races other logouts and logins. That account's own file stays saved, so
        // `login --business` brings it back without the browser.
        current = (await takePointer(environment)) !== undefined;
      }

      const removed = await unlinkAccount(environment, account);

      await cleanUp(environment);

      return { removed, current };
    },

    async signOutAll(environment) {
      const taken = await takePointer(environment);
      let signedIn = taken !== undefined && taken.account === undefined;
      let removed = 0;

      for (const name of await listNames()) {
        const account = accountOfName(environment, name);

        if (account !== undefined && (await unlinkAccount(environment, account))) {
          removed += 1;
          signedIn ||= taken?.account !== undefined && sameAccount(taken.account, account);
        }
      }

      await cleanUp(environment);

      return { signedIn, removed };
    },

    async listSessions() {
      const found = await Promise.all(
        ENVIRONMENTS.map(async (environment) => {
          try {
            return (await readSession(environment)) === null ? undefined : environment;
          } catch (err) {
            if (err instanceof OAuthError && err.code === 'login_required') {
              return environment;
            }

            throw err;
          }
        }),
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
