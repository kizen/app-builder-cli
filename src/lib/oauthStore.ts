/**
 * On-disk OAuth state, kept in `<credentials dir>/oauth/` so none of it is a
 * top-level `*.json` that `listCredentialProfiles` would mistake for an API-key
 * profile:
 *
 *   oauth/                          0700
 *     <env>.json                    0600  pointer: `{ "businessId", "userId" }`, the current account
 *     <env>.<business>.<user>.json  0600  one saved account's session (tokens and labels)
 *     clients.json                  0600  DCR client_id cache, keyed by issuer
 *
 * `<business>` and `<user>` are the account's ids as lowercase hex, so any id Kizen returns makes
 * a safe file name, and distinct ids stay distinct on a case-insensitive filesystem (macOS's
 * default), where a case-sensitive encoding such as base64url would let two accounts share a file. Each account file is a saved account; the pointer picks the current one.
 *
 * Nothing is locked: every write is an atomic rename. A refresh only ever writes or deletes its
 * own account's file, and only login, a switch and logout move the pointer, so a refresh racing a
 * logout or a switch to another account can't undo it (see `createTokenProvider`). Accepted: a
 * logout racing a sign-in to the same account can delete that sign-in's new session file, leaving
 * the account signed out.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ENVIRONMENTS, GLOBAL_CREDENTIALS_DIR, type Environment } from './credentials.js';
import { ifExists, isRecord, nonEmptyString } from './guards.js';
import { loginRequired, OAuthError } from './oauth.js';

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
  scope: string | undefined;
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
  /** Points the environment at `account` (after `writeSession` of it), then cleans up. */
  setCurrent: (environment: Environment, account: OAuthAccount) => Promise<void>;
  /**
   * Deletes this account's file only; never touches the pointer, so a pointer to it then reads as
   * not signed in. Returns whether the file existed.
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

/**
 * A `<env>.json.<ms>-<hex>.signout` file is a pointer a logout moved aside and crashed before
 * removing. `<ms>` is when that logout moved it (epoch milliseconds), so its age is measured from
 * the logout, not from the pointer's mtime, which the rename keeps. It's deleted once older than
 * this, so a logout in progress keeps its own.
 */
export const SIGNOUT_MAX_AGE_MS = 10 * 60_000;

/**
 * An account id is used only hex-encoded in a file name. Kizen's id formats aren't pinned down,
 * so any non-empty UTF-8 string without control characters is accepted, up to a length that keeps
 * the longest name within the usual 255-byte limit: `integration.` (12) + 2 * (110 hex + 1 dot)
 * + `json` (4) + writeAtomic's `.<12 hex>.tmp` (17) = 255.
 */
export const MAX_ID_BYTES = 55;
const ENCODED_ID = /^(?:[0-9a-f]{2}){1,55}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  !CONTROL.test(value) &&
  Buffer.byteLength(value, 'utf-8') <= MAX_ID_BYTES &&
  // Lone surrogates don't survive a UTF-8 round trip, so they'd decode to another id.
  Buffer.from(value, 'utf-8').toString('utf-8') === value;

const encodeId = (id: string): string => Buffer.from(id, 'utf-8').toString('hex');

/** The id a file name segment encodes; undefined unless it's the canonical encoding of a valid id. */
const decodeId = (segment: string): string | undefined => {
  if (!ENCODED_ID.test(segment)) {
    return undefined;
  }

  const id = Buffer.from(segment, 'hex').toString('utf-8');

  return validId(id) && encodeId(id) === segment ? id : undefined;
};

/** `{ businessId, userId }` if both are valid ids, else undefined. */
export const validAccount = (raw: unknown): OAuthAccount | undefined =>
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

  return `${encodeId(account.businessId)}.${encodeId(account.userId)}`;
};

/** The pointer's account; undefined unless the file is exactly `{ businessId, userId }`. */
function parsePointer(text: string): OAuthAccount | undefined {
  let raw: unknown;

  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }

  // Exactly these two keys, so a whole session written to the pointer is unreadable rather than
  // a pointer to a file that was never written.
  return isRecord(raw) && Object.keys(raw).length === 2 ? validAccount(raw) : undefined;
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
    scope: optionalString(raw.scope),
  };
}

/** @param baseDir the credentials directory; `oauth/` is created inside it. */
export function createOAuthStore(baseDir: string = GLOBAL_CREDENTIALS_DIR): OAuthStore {
  const dir = join(baseDir, 'oauth');
  const sessionPath = (environment: Environment): string => join(dir, `${environment}.json`);
  const accountPath = (environment: Environment, account: OAuthAccount): string =>
    join(dir, `${environment}.${accountKey(account)}.json`);
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

    const [businessId, userId] = segments.map(decodeId);

    return businessId === undefined || userId === undefined ? undefined : { businessId, userId };
  };

  const listNames = async (): Promise<string[]> => (await ifExists(readdir(dir))) ?? [];

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

  const unreadable = (environment: Environment, path: string): OAuthError =>
    loginRequired(environment, `The saved ${environment} session at ${path} can't be read.`, {
      again: true,
    });

  /**
   * Best effort, on login, switch and logout: deletes `<env>.json.<ms>-<hex>.signout` pointers a
   * crash left mid-logout once they're old enough, by the time in their name (when the logout
   * moved them aside). Only names matching that fixed pattern reach `join`.
   */
  const cleanUp = async (environment: Environment): Promise<void> => {
    try {
      const signout = new RegExp(`^${environment}\\.json\\.([0-9]{1,16})-[0-9a-f]{12}\\.signout$`);

      for (const name of await listNames()) {
        const movedAt = signout.exec(name)?.[1];

        if (movedAt !== undefined && Date.now() - Number(movedAt) > SIGNOUT_MAX_AGE_MS) {
          await ifExists(unlink(join(dir, name)));
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

    if ((await ifExists(rename(pointerPath, moved).then(() => true))) !== true) {
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

  /** Unlinks one account file; a failure other than "already gone" surfaces. */
  const unlinkAccount = async (environment: Environment, account: OAuthAccount): Promise<boolean> =>
    (await ifExists(unlink(accountPath(environment, account)).then(() => true))) ?? false;

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

    async setCurrent(environment, account) {
      const { businessId, userId } = account;

      // accountKey validates both ids before anything is written.
      accountKey(account);
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
      // Validates the ids before anything is touched.
      accountKey(account);

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
