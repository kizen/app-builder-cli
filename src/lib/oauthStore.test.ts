import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import type * as FsPromisesModule from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountKey,
  ACCOUNT_LOCK,
  createOAuthStore,
  SIGNOUT_MAX_AGE_MS,
  withLockFile,
  type LockFileOptions,
  type OAuthAccount,
  type OAuthSession,
  type OAuthStore,
} from './oauthStore.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ISSUER,
  oauthSession,
  deferred,
  rejectionOf,
  signIn,
} from '../test/oauth.js';

/**
 * When set, the next `readFile` of a path it matches completes the read, then waits on `gate`
 * before returning: a pause inside a store call, between its read and what it does next. With
 * `before`, it waits before reading instead, so the pause falls just ahead of the read.
 */
const hooks = vi.hoisted(() => ({
  pauseRead: undefined as
    | {
        matches: (path: string) => boolean;
        reached: () => void;
        gate: Promise<void>;
        before?: boolean;
      }
    | undefined,
  /** When set, the next `unlink` of a path it matches rejects with `error` instead. */
  failUnlink: undefined as { matches: (path: string) => boolean; error: Error } | undefined,
  /** Called with the path whenever an exclusive create (`open(path, 'wx')`) finds it taken. */
  onCreateTaken: undefined as ((path: string) => void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromisesModule>();
  const readFile = async (...args: Parameters<typeof fs.readFile>): Promise<string | Buffer> => {
    const pause = hooks.pauseRead;
    const paused = pause !== undefined && typeof args[0] === 'string' && pause.matches(args[0]);

    if (paused) {
      hooks.pauseRead = undefined;
    }

    if (paused && pause.before === true) {
      pause.reached();
      await pause.gate;
    }

    const result = await fs.readFile(...args);

    if (paused && pause.before !== true) {
      pause.reached();
      await pause.gate;
    }

    return result;
  };

  const unlink = async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
    const fail = hooks.failUnlink;

    if (fail !== undefined && typeof args[0] === 'string' && fail.matches(args[0])) {
      hooks.failUnlink = undefined;
      throw fail.error;
    }

    return fs.unlink(...args);
  };

  const open = async (
    ...args: Parameters<typeof fs.open>
  ): Promise<FsPromisesModule.FileHandle> => {
    try {
      return await fs.open(...args);
    } catch (err) {
      if (args[1] === 'wx' && (err as { code?: unknown }).code === 'EEXIST') {
        hooks.onCreateTaken?.(String(args[0]));
      }

      throw err;
    }
  };

  const mocked = { ...fs, readFile, unlink, open };

  return { ...mocked, default: mocked };
});

afterEach(() => {
  hooks.pauseRead = undefined;
  hooks.failUnlink = undefined;
  hooks.onCreateTaken = undefined;
});

/** Every store gets a base dir under this, so the real ~/.kizenappbuilder is never touched. */
const root = mkdtempSync(join(tmpdir(), 'appbuilder-oauth-store-'));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Account B's session: another business and user, with its own tokens. */
const sessionB = (overrides: Partial<OAuthSession> = {}): OAuthSession =>
  oauthSession({
    ...ACCOUNT_B,
    businessName: 'Bravo B',
    fullName: 'Bob B',
    email: 'bob@b.test',
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
    ...overrides,
  });

const unreadableMessage = (path: string): string =>
  `The saved staging session at ${path} can't be read. Run \`appbuilder login --env staging\` to sign in again.`;

describe('oauth store', () => {
  it('pointer and account files are written 0600 in a 0700 oauth subdirectory, and nothing else', async () => {
    const base = join(root, 'permissions');
    const store = createOAuthStore(base);

    await signIn(store, oauthSession());
    await store.writeClientId('https://staging.kizen.com', 'client-1');

    const oauthDir = join(base, 'oauth');
    const pointer = join(oauthDir, 'staging.json');
    const accountFile = join(oauthDir, `staging.${ACCOUNT_A.businessId}.${ACCOUNT_A.userId}.json`);

    expect(accountKey(ACCOUNT_A)).toBe(`${ACCOUNT_A.businessId}.${ACCOUNT_A.userId}`);
    expect(store.sessionPath('staging')).toBe(pointer);
    expect(store.accountPath('staging', ACCOUNT_A)).toBe(accountFile);
    expect(JSON.parse(await readFile(pointer, 'utf-8'))).toStrictEqual(ACCOUNT_A);
    // The identity labels are stored with the tokens.
    expect(JSON.parse(await readFile(accountFile, 'utf-8'))).toStrictEqual(oauthSession());

    for (const file of [pointer, accountFile, join(oauthDir, 'clients.json')]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    expect((await stat(oauthDir)).mode & 0o777).toBe(0o700);
    // Nothing lands at the top level, where listCredentialProfiles would read it as a profile.
    expect(await readdir(base)).toStrictEqual(['oauth']);
  });

  it('round-trips a session through the pointer, lists it, and signs out', async () => {
    const store = createOAuthStore(join(root, 'other'));
    const session = oauthSession({ environment: 'integration', expiresAt: 42 });

    expect(await store.readSession('integration')).toBeNull();
    // Written but not pointed to: saved, not signed in.
    await store.writeSession(session);
    expect(await store.readSession('integration')).toBeNull();
    expect(await store.listSessions()).toStrictEqual([]);
    expect(await store.readAccount('integration', ACCOUNT_A)).toStrictEqual(session);

    await store.setCurrent('integration', ACCOUNT_A);
    expect(await store.readSession('integration')).toStrictEqual(session);
    expect(await store.listSessions()).toStrictEqual(['integration']);

    expect(await store.signOut('integration')).toBe(true);
    expect(await store.signOut('integration')).toBe(false);
    expect(await store.readSession('integration')).toBeNull();
    expect(await store.listSessions()).toStrictEqual([]);
    expect(await readdir(store.dir)).toStrictEqual([]);
  });

  it('writing the same account again overwrites its file in place', async () => {
    const store = createOAuthStore(join(root, 'in-place'));

    await signIn(store, oauthSession());
    await signIn(
      store,
      oauthSession({ accessToken: 'access-again', businessName: 'Acme Renamed' }),
    );

    expect((await readdir(store.dir)).sort()).toStrictEqual([
      `staging.${accountKey(ACCOUNT_A)}.json`,
      'staging.json',
    ]);
    expect(await store.readSession('staging')).toStrictEqual(
      oauthSession({ accessToken: 'access-again', businessName: 'Acme Renamed' }),
    );
  });

  it("deleteSession removes only that account's file and leaves the pointer", async () => {
    const store = createOAuthStore(join(root, 'delete-one'));

    await signIn(store, oauthSession());
    await store.writeSession(sessionB());

    expect(await store.deleteSession('staging', ACCOUNT_B)).toBe(true);
    expect(await store.readSession('staging')).toStrictEqual(oauthSession());

    expect(await store.deleteSession('staging', ACCOUNT_A)).toBe(true);
    expect(await store.deleteSession('staging', ACCOUNT_A)).toBe(false);
    // A pointer to a missing file reads as not signed in, and isn't listed.
    expect(await readdir(store.dir)).toStrictEqual(['staging.json']);
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.listSessions()).toStrictEqual([]);
    // Signing out of it says nobody was signed in, and removes the pointer.
    expect(await store.signOut('staging')).toBe(false);
    expect(await readdir(store.dir)).toStrictEqual([]);
  });

  it('lists saved accounts with the current one marked, unreadable ones included, and nothing else', async () => {
    const store = createOAuthStore(join(root, 'list'));
    const unreadableAccount: OAuthAccount = {
      businessId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      userId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
    };
    const unreadablePath = store.accountPath('staging', unreadableAccount);

    expect(await store.listAccounts('staging')).toStrictEqual([]);

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());
    await signIn(store, oauthSession({ environment: 'go', issuer: 'https://app.go.kizen.com' }));
    await writeFile(unreadablePath, '{"accessToken": "secret-in-file", "tr');
    // Not account files: a temp file, a moved-aside pointer, the client cache.
    await writeFile(join(store.dir, `staging.${accountKey(ACCOUNT_B)}.json.abc.tmp`), '{}');
    await writeFile(
      join(store.dir, 'staging.json.1700000000000-0123456789ab.signout'),
      JSON.stringify(ACCOUNT_B),
    );
    await store.writeClientId(ISSUER, 'client-1');

    // Sorted by business name (or id), case-insensitively.
    expect(await store.listAccounts('staging')).toStrictEqual([
      { account: ACCOUNT_A, session: oauthSession(), current: true },
      { account: ACCOUNT_B, session: sessionB(), current: false },
      { account: unreadableAccount, session: undefined, current: false },
    ]);

    // An unreadable pointer marks nothing current, and the accounts are still listed.
    await writeFile(store.sessionPath('staging'), '{"trunc');
    expect(
      (await store.listAccounts('staging')).map(({ account, current }) => [account, current]),
    ).toStrictEqual([
      [ACCOUNT_A, false],
      [ACCOUNT_B, false],
      [unreadableAccount, false],
    ]);
  });

  it('caches client ids per issuer and forgets one without touching the others', async () => {
    const store = createOAuthStore(join(root, 'clients'));

    await store.writeClientId('https://a.test', 'a1');
    await store.writeClientId('https://b.test', 'b1');
    await store.forgetClientId('https://a.test');

    expect(await store.readClientId('https://a.test')).toBeUndefined();
    expect(await store.readClientId('https://b.test')).toBe('b1');
  });

  it('corrupt pointer or session file reports an unreadable-session error naming the path', async () => {
    const store = createOAuthStore(join(root, 'corrupt'));
    const pointer = store.sessionPath('staging');
    const sessionFile = store.accountPath('staging', ACCOUNT_A);
    const fixtures: [path: string, contents: string][] = [
      // Truncated JSON.
      [pointer, '{"accessToken": "secret-in-file-1", "refre'],
      // Valid JSON, wrong shape.
      [sessionFile, JSON.stringify({ accessToken: 'secret-in-file-1' })],
      // A session for another account than the one its file (and the pointer) names.
      [sessionFile, JSON.stringify(sessionB({ accessToken: 'secret-in-file-1' }))],
    ];

    await mkdir(store.dir, { recursive: true });

    for (const [path, contents] of fixtures) {
      await writeFile(pointer, JSON.stringify(ACCOUNT_A));
      await writeFile(sessionFile, JSON.stringify(oauthSession()));
      await writeFile(path, contents);

      const error = await rejectionOf(store.readSession('staging'));

      expect(error.message).toBe(unreadableMessage(path));
      expect(error.message).not.toContain('secret-in-file-1');
      // Listed as present, so selecting "the only signed-in environment" surfaces the error.
      expect(await store.listSessions()).toStrictEqual(['staging']);
    }

    // Absent is still null, not an error.
    await rm(pointer);
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.listSessions()).toStrictEqual([]);
  });

  it("an id that isn't a lowercase UUID never reaches a path", async () => {
    const base = join(root, 'traversal');
    const store = createOAuthStore(base);
    const pointer = store.sessionPath('staging');

    await mkdir(store.dir, { recursive: true });

    // Path syntax, an uppercase UUID, empty: refused as a pointer, a key, and a write.
    for (const account of [
      { ...ACCOUNT_A, businessId: '../../x' },
      { ...ACCOUNT_A, userId: ACCOUNT_A.userId.toUpperCase() },
      { ...ACCOUNT_A, businessId: '' },
    ]) {
      await writeFile(pointer, JSON.stringify(account));
      expect((await rejectionOf(store.readSession('staging'))).message).toBe(
        unreadableMessage(pointer),
      );
      expect(() => accountKey(account)).toThrow('invalid account id');
      await expect(store.writeSession(oauthSession(account))).rejects.toThrow('invalid account id');
    }

    // File names whose segments aren't lowercase UUIDs aren't accounts.
    const names = [
      'staging.biz-a.user-a.json',
      `staging.${accountKey(ACCOUNT_A).toUpperCase()}.json`,
    ];

    for (const name of names) {
      await writeFile(join(store.dir, name), JSON.stringify(oauthSession()));
    }

    expect(await store.listAccounts('staging')).toStrictEqual([]);
    // Signing out removes the bad pointer and nothing else; nothing was written outside oauth/.
    expect(await store.signOut('staging')).toBe(true);
    expect((await store.signOutAll('staging')).removed).toBe(0);
    expect((await readdir(store.dir)).sort()).toStrictEqual(names.sort());
    expect(await readdir(base)).toStrictEqual(['oauth']);
  });

  it('removeAccount removes one saved account, and the pointer only when it names it', async () => {
    const store = createOAuthStore(join(root, 'remove-one'));

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());

    // Not current: only its file goes.
    expect(await store.removeAccount('staging', ACCOUNT_B)).toStrictEqual({
      removed: true,
      current: false,
    });
    expect(await store.readSession('staging')).toStrictEqual(oauthSession());
    expect(await store.readAccount('staging', ACCOUNT_B)).toBeNull();

    // Current: the pointer goes too.
    expect(await store.removeAccount('staging', ACCOUNT_A)).toStrictEqual({
      removed: true,
      current: true,
    });
    expect(await readdir(store.dir)).toStrictEqual([]);
    expect(await store.removeAccount('staging', ACCOUNT_A)).toStrictEqual({
      removed: false,
      current: false,
    });
  });

  it('a login that lands during a logout keeps its pointer', async () => {
    const base = join(root, 'logout-race');
    const store = createOAuthStore(base);
    const reached = deferred();
    const gate = deferred();

    await signIn(store, oauthSession());

    // Pause logout once it has read the pointer it is removing (the moved-aside copy, or
    // `<env>.json` itself for a logout that reads before it removes).
    hooks.pauseRead = {
      matches: (path) => path === store.sessionPath('staging') || path.endsWith('.signout'),
      reached: () => {
        reached.resolve();
      },
      gate: gate.promise,
    };

    const signingOut = store.signOut('staging');

    await reached.promise;
    // Another terminal signs in to account B meanwhile.
    await signIn(createOAuthStore(base), sessionB());
    gate.resolve();

    expect(await signingOut).toBe(true);
    expect(await store.readSession('staging')).toStrictEqual(sessionB());
    await expect(stat(store.accountPath('staging', ACCOUNT_A))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('a clean-up that runs during a logout spares its moved-aside pointer, however old the pointer was', async () => {
    const base = join(root, 'logout-cleanup-race');
    const store = createOAuthStore(base);
    const reached = deferred();
    const gate = deferred();
    // Seconds, for utimes: a minute past the max age.
    const old = (Date.now() - SIGNOUT_MAX_AGE_MS - 60_000) / 1000;

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());
    // The pointer was written long ago; moving it aside keeps that mtime.
    await utimes(store.sessionPath('staging'), old, old);

    // Pause logout after it has moved the pointer aside, before it reads the moved copy.
    hooks.pauseRead = {
      matches: (path) => path.endsWith('.signout'),
      reached: () => {
        reached.resolve();
      },
      gate: gate.promise,
      before: true,
    };

    const signingOut = store.signOut('staging');

    await reached.promise;
    // Another terminal switches to B meanwhile, which cleans up leftover sign-outs.
    await createOAuthStore(base).setCurrent('staging', ACCOUNT_B);
    gate.resolve();

    // A's file is removed with its tokens, not left behind by a logout that reports success.
    expect(await signingOut).toBe(true);
    await expect(stat(store.accountPath('staging', ACCOUNT_A))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await store.readSession('staging')).toStrictEqual(sessionB());
  });

  it('signOut removes only the current account; signOutAll removes every saved account', async () => {
    const store = createOAuthStore(join(root, 'sign-out-all'));
    const go = oauthSession({ environment: 'go', issuer: 'https://app.go.kizen.com' });

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());
    await signIn(store, go);

    expect(await store.signOut('staging')).toBe(true);
    expect(await store.readSession('staging')).toBeNull();
    expect((await store.listAccounts('staging')).map((entry) => entry.account)).toStrictEqual([
      ACCOUNT_B,
    ]);

    // Not signed in, but an account is saved: it's removed, and reported.
    expect(await store.signOutAll('staging')).toStrictEqual({ signedIn: false, removed: 1 });

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());
    expect(await store.signOutAll('staging')).toStrictEqual({ signedIn: true, removed: 2 });
    expect(await store.signOutAll('staging')).toStrictEqual({ signedIn: false, removed: 0 });
    // Only staging's files went.
    expect((await readdir(store.dir)).sort()).toStrictEqual(
      ['go.json', `go.${accountKey(ACCOUNT_A)}.json`].sort(),
    );
    expect(await store.readSession('go')).toStrictEqual(go);
  });

  it('clean-up removes old leftover sign-outs but keeps every saved account, however old', async () => {
    const store: OAuthStore = createOAuthStore(join(root, 'clean-up'));
    // Milliseconds: a minute past the max age, and a minute short of it.
    const oldMs = Date.now() - SIGNOUT_MAX_AGE_MS - 60_000;
    const recentMs = Date.now() - SIGNOUT_MAX_AGE_MS + 60_000;
    // Seconds, for utimes.
    const old = oldMs / 1000;
    // Pointers a crash left between signOut's rename and its cleanup, aged by the time in their
    // name: old and recent.
    const oldSignout = join(store.dir, `staging.json.${String(oldMs)}-0123456789ab.signout`);
    const recentSignout = join(store.dir, `staging.json.${String(recentMs)}-ba9876543210.signout`);

    // A saved account that isn't current, long untouched.
    await store.writeSession(sessionB());
    await utimes(store.accountPath('staging', ACCOUNT_B), old, old);

    // Every one with an old mtime, so only the name decides.
    for (const file of [oldSignout, recentSignout]) {
      await writeFile(file, JSON.stringify(ACCOUNT_B));
      await utimes(file, old, old);
    }

    await signIn(store, oauthSession());

    expect((await readdir(store.dir)).sort()).toStrictEqual(
      [
        `staging.${accountKey(ACCOUNT_A)}.json`,
        `staging.${accountKey(ACCOUNT_B)}.json`,
        'staging.json',
        `staging.json.${String(recentMs)}-ba9876543210.signout`,
      ].sort(),
    );
  });

  it('pre-existing 0755 oauth dir and 0644 pointer and session files end up 0700/0600 after a sign-in', async () => {
    const store = createOAuthStore(join(root, 'loose'));
    const pointer = store.sessionPath('staging');
    const sessionFile = store.accountPath('staging', ACCOUNT_A);

    await mkdir(store.dir, { recursive: true });
    await chmod(store.dir, 0o755);
    await writeFile(pointer, JSON.stringify(ACCOUNT_A));
    await writeFile(sessionFile, JSON.stringify(oauthSession({ accessToken: 'old' })));

    for (const file of [pointer, sessionFile]) {
      await chmod(file, 0o644);
      expect((await stat(file)).mode & 0o777).toBe(0o644);
    }

    expect((await stat(store.dir)).mode & 0o777).toBe(0o755);

    await signIn(store, oauthSession());

    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);

    for (const file of [pointer, sessionFile]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    expect(await store.readSession('staging')).toStrictEqual(oauthSession());
  });

  it('a write that fails mid-way leaves the previous session readable and no tmp file', async () => {
    const store = createOAuthStore(join(root, 'failed-write'));

    await signIn(store, oauthSession());

    // Serializing throws after the temp file is open, before anything is renamed.
    const poisoned = oauthSession({
      accessToken: {
        toJSON: () => {
          throw new Error('disk on fire');
        },
      } as unknown as string,
    });

    await expect(store.writeSession(poisoned)).rejects.toThrow('disk on fire');
    expect(await store.readSession('staging')).toStrictEqual(oauthSession());
    expect((await readdir(store.dir)).sort()).toStrictEqual([
      `staging.${accountKey(ACCOUNT_A)}.json`,
      'staging.json',
    ]);
  });

  it('concurrent clients.json writes leave a parseable file', async () => {
    const issuers = ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'];

    for (let round = 0; round < 8; round += 1) {
      const base = join(root, 'clients-race', String(round));
      // Separate stores on one directory, as separate `appbuilder` processes would be.
      const stores = issuers.map(() => createOAuthStore(base));

      await stores[0]?.writeClientId('https://kept.test', 'kept');
      await Promise.all(
        stores.map((store, i) =>
          i % 2 === 0
            ? store.writeClientId(issuers[i] ?? '', `${String(i)}-${String(round)}`)
            : store.forgetClientId('https://kept.test'),
        ),
      );

      const dir = join(base, 'oauth');
      const clients = JSON.parse(await readFile(join(dir, 'clients.json'), 'utf-8')) as Record<
        string,
        unknown
      >;

      // Unlocked, so an update can be lost; but every entry that is there is one that was
      // written whole, and no temp file is left behind.
      for (const [issuer, entry] of Object.entries(clients)) {
        const i = issuers.indexOf(issuer);

        expect(entry).toStrictEqual({
          clientId: issuer === 'https://kept.test' ? 'kept' : `${String(i)}-${String(round)}`,
        });
      }

      expect(await readdir(dir)).toStrictEqual(['clients.json']);
    }
  });
});

describe('account lock', () => {
  /** A refresh's next session for account A: what a commit of `refresh-0` would write. */
  const refreshed = oauthSession({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  const lockOf = (store: OAuthStore, account: OAuthAccount = ACCOUNT_A): string =>
    join(store.dir, `staging.${accountKey(account)}.lock`);
  /** Seconds, for utimes: a minute past the stale threshold. */
  const staleTime = (): number => (Date.now() - ACCOUNT_LOCK.staleMs - 60_000) / 1000;
  const noLockFiles = async (store: OAuthStore): Promise<void> => {
    expect((await readdir(store.dir)).filter((name) => name.endsWith('.lock'))).toStrictEqual([]);
  };

  /** Options that never wait out a lock within a test's time, so only a release or takeover ends it. */
  const patient: LockFileOptions = { waitMs: 60_000, staleMs: ACCOUNT_LOCK.staleMs, pollMs: 5 };

  it('the account lock is a separate file beside the account file, never mistaken for an account', () => {
    const store = createOAuthStore(join(root, 'lock-name'));

    expect(lockOf(store)).toBe(store.accountPath('staging', ACCOUNT_A).replace(/\.json$/, '.lock'));
  });

  it('commitRefresh writes only while the file still holds the spent refresh token', async () => {
    const store = createOAuthStore(join(root, 'commit-outcomes'));
    const rotated = oauthSession({ accessToken: 'access-peer', refreshToken: 'refresh-peer' });

    await signIn(store, oauthSession());
    expect(await store.commitRefresh(refreshed, 'refresh-0')).toBe('written');
    expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(refreshed);

    // A peer rotated past refresh-0 (here, to refresh-peer): its tokens are kept.
    await store.writeSession(rotated);
    expect(await store.commitRefresh(refreshed, 'refresh-0')).toBe('rotated');
    expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(rotated);

    // Logged out: nothing is written back.
    expect(await store.removeAccount('staging', ACCOUNT_A)).toStrictEqual({
      removed: true,
      current: true,
    });
    expect(await store.commitRefresh(refreshed, 'refresh-peer')).toBe('gone');
    expect(await store.readAccount('staging', ACCOUNT_A)).toBeNull();
    expect(await readdir(store.dir)).toStrictEqual([]);
  });

  it('a peer rotation that lands while a commit waits on the lock is kept', async () => {
    const store = createOAuthStore(join(root, 'commit-rotated-under-lock'), { lock: patient });
    const rotated = oauthSession({ accessToken: 'access-peer', refreshToken: 'refresh-peer' });
    const waiting = deferred();

    await signIn(store, oauthSession());
    // A peer's commit holds the lock; ours waits on it.
    await writeFile(lockOf(store), '');
    hooks.onCreateTaken = (path) => {
      if (path === lockOf(store)) {
        waiting.resolve();
      }
    };

    const committing = store.commitRefresh(refreshed, 'refresh-0');

    await waiting.promise;
    // The peer writes its rotation, then releases.
    await store.writeSession(rotated);
    await rm(lockOf(store));

    expect(await committing).toBe('rotated');
    expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(rotated);
    await noLockFiles(store);
  });

  it('no lock file remains after a commit or a logout, whether it succeeds or throws', async () => {
    const store = createOAuthStore(join(root, 'lock-cleanup'));

    await signIn(store, oauthSession());
    expect(await store.commitRefresh(refreshed, 'refresh-0')).toBe('written');
    await noLockFiles(store);

    // The write throws once the temp file is open (as in the failed-write test above).
    const poisoned = oauthSession({
      accessToken: {
        toJSON: () => {
          throw new Error('disk on fire');
        },
      } as unknown as string,
    });

    await expect(store.commitRefresh(poisoned, 'refresh-1')).rejects.toThrow('disk on fire');
    expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(refreshed);
    await noLockFiles(store);

    // A logout whose unlink of the account file fails.
    hooks.failUnlink = {
      matches: (path) => path === store.accountPath('staging', ACCOUNT_A),
      error: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    };
    await expect(store.signOut('staging')).rejects.toThrow('EACCES');
    await noLockFiles(store);

    await store.setCurrent('staging', ACCOUNT_A);
    await store.writeSession(oauthSession({ ...ACCOUNT_B }));
    expect(await store.removeAccount('staging', ACCOUNT_B)).toStrictEqual({
      removed: true,
      current: false,
    });
    await noLockFiles(store);
    expect(await store.deleteSession('staging', ACCOUNT_A)).toBe(true);
    await noLockFiles(store);
    await signIn(store, oauthSession());
    expect(await store.signOutAll('staging')).toStrictEqual({ signedIn: true, removed: 1 });
    expect(await store.signOut('staging')).toBe(false);
    expect(await readdir(store.dir)).toStrictEqual([]);
  });

  it("a lock held past the wait doesn't stop a commit or a logout, and isn't removed by them", async () => {
    const store = createOAuthStore(join(root, 'lock-timeout'), {
      lock: { waitMs: 50, pollMs: 5 },
    });
    const foreign = lockOf(store);

    await signIn(store, oauthSession());
    // A live holder (fresh mtime) that never releases within the wait.
    await writeFile(foreign, '');

    expect(await store.commitRefresh(refreshed, 'refresh-0')).toBe('written');
    expect(await store.readAccount('staging', ACCOUNT_A)).toStrictEqual(refreshed);
    expect(await store.signOut('staging')).toBe(true);
    expect(await store.readAccount('staging', ACCOUNT_A)).toBeNull();

    // Only the holder's own lock is left: nothing of ours.
    expect(await readdir(store.dir)).toStrictEqual([`staging.${accountKey(ACCOUNT_A)}.lock`]);

    const run = vi.fn(() => Promise.resolve('ran'));

    expect(
      await withLockFile(foreign, { ...ACCOUNT_LOCK, waitMs: 50, pollMs: 5 }, run),
    ).toStrictEqual({ value: 'ran', held: false });
    expect(run).toHaveBeenCalledOnce();
  });

  it('a stale lock file is taken over at once, not waited out', async () => {
    const store = createOAuthStore(join(root, 'lock-stale'), { lock: patient });

    await signIn(store, oauthSession());
    await writeFile(lockOf(store), '');
    await utimes(lockOf(store), staleTime(), staleTime());

    const started = Date.now();
    const seen: boolean[] = [];

    const result = await withLockFile(lockOf(store), patient, async () => {
      // Held: the file is ours, created fresh.
      seen.push(Date.now() - (await stat(lockOf(store))).mtimeMs < ACCOUNT_LOCK.staleMs);

      return 'ran';
    });

    expect(result).toStrictEqual({ value: 'ran', held: true });
    expect(seen).toStrictEqual([true]);
    // `patient` waits a minute for a live lock; a takeover is immediate.
    expect(Date.now() - started).toBeLessThan(5_000);
    await noLockFiles(store);

    // Through the store too: a commit behind a stale lock writes.
    await writeFile(lockOf(store), '');
    await utimes(lockOf(store), staleTime(), staleTime());
    expect(await store.commitRefresh(refreshed, 'refresh-0')).toBe('written');
    await noLockFiles(store);
  });

  it('a live lock is waited for, and the waiter goes ahead holding it once it is released', async () => {
    const store = createOAuthStore(join(root, 'lock-wait'), { lock: patient });
    const path = lockOf(store);
    const waiting = deferred();
    const run = vi.fn(async () => {
      // The waiter's own lock, while it runs.
      await stat(path);

      return 'ran';
    });

    await mkdir(store.dir, { recursive: true });
    await writeFile(path, '');

    let polls = 0;

    hooks.onCreateTaken = (taken) => {
      if (taken === path && (polls += 1) === 3) {
        waiting.resolve();
      }
    };

    const locked = withLockFile(path, patient, run);

    // It has found the lock taken three times, and hasn't run.
    await waiting.promise;
    expect(run).not.toHaveBeenCalled();
    await rm(path);

    expect(await locked).toStrictEqual({ value: 'ran', held: true });
    expect(run).toHaveBeenCalledOnce();
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("a holder's release leaves a lock that replaced its own alone, whatever its inode", async () => {
    const store = createOAuthStore(join(root, 'lock-successor'));
    const path = lockOf(store);
    const nonces: string[] = [];

    await mkdir(store.dir, { recursive: true });

    const result = await withLockFile(path, ACCOUNT_LOCK, async () => {
      nonces.push(await readFile(path, 'utf-8'));
      // Taken over meanwhile (as stale, after a long pause): another holder's file now, which a
      // file system may give the inode just freed.
      await rm(path);
      await writeFile(path, 'successor');

      return 'ran';
    });

    expect(result).toStrictEqual({ value: 'ran', held: true });
    // While held, the file holds this holder's random nonce.
    expect(nonces).toHaveLength(1);
    expect(nonces[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(await readFile(path, 'utf-8')).toBe('successor');
  });

  it('a release leaves the lock alone when it holds another nonce, even in the same file', async () => {
    const store = createOAuthStore(join(root, 'lock-other-nonce'));
    const path = lockOf(store);
    const other = 'f'.repeat(32);

    await mkdir(store.dir, { recursive: true });

    const before = await withLockFile(path, ACCOUNT_LOCK, async () => {
      const ino = (await stat(path)).ino;

      // Rewritten in place: same inode, so only the content tells it isn't this holder's.
      await writeFile(path, other);

      return ino;
    });

    expect((await stat(path)).ino).toBe(before.value);
    expect(await readFile(path, 'utf-8')).toBe(other);

    // A release of a file still holding its own nonce removes it.
    await rm(path);
    expect(await withLockFile(path, ACCOUNT_LOCK, () => Promise.resolve('ran'))).toStrictEqual({
      value: 'ran',
      held: true,
    });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a run that throws releases the lock and passes the error on', async () => {
    const store = createOAuthStore(join(root, 'lock-throw'));
    const path = lockOf(store);

    await mkdir(store.dir, { recursive: true });
    await expect(
      withLockFile(path, ACCOUNT_LOCK, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('listing, login, switching and logout --all work with lock files present, and clean-up removes only stale ones', async () => {
    const store = createOAuthStore(join(root, 'lock-present'), {
      lock: { waitMs: 50, pollMs: 5 },
    });
    // A stale lock for A, a live one for B, and a stale one in another environment.
    const goLock = join(store.dir, `go.${accountKey(ACCOUNT_A)}.lock`);

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());
    await writeFile(lockOf(store, ACCOUNT_A), '');
    await writeFile(lockOf(store, ACCOUNT_B), '');
    await writeFile(goLock, '');

    for (const path of [lockOf(store, ACCOUNT_A), goLock]) {
      await utimes(path, staleTime(), staleTime());
    }

    expect(
      (await store.listAccounts('staging')).map(({ account, current }) => ({ account, current })),
    ).toStrictEqual([
      { account: ACCOUNT_A, current: true },
      { account: ACCOUNT_B, current: false },
    ]);
    expect(await store.listAccounts('go')).toStrictEqual([]);
    expect(await store.listSessions()).toStrictEqual(['staging']);

    // A switch cleans up: A's stale lock goes; B's live one and go's (another environment) stay.
    await store.setCurrent('staging', ACCOUNT_B);
    expect(await store.readSession('staging')).toStrictEqual(sessionB());
    expect(
      (await readdir(store.dir)).filter((name) => name.endsWith('.lock')).sort(),
    ).toStrictEqual(
      [`go.${accountKey(ACCOUNT_A)}.lock`, `staging.${accountKey(ACCOUNT_B)}.lock`].sort(),
    );

    // A login again to A writes past nothing; logout --all counts accounts, not locks.
    await signIn(store, oauthSession());
    expect(await store.readSession('staging')).toStrictEqual(oauthSession());
    expect(await store.signOutAll('staging')).toStrictEqual({ signedIn: true, removed: 2 });
    expect((await readdir(store.dir)).sort()).toStrictEqual(
      [`go.${accountKey(ACCOUNT_A)}.lock`, `staging.${accountKey(ACCOUNT_B)}.lock`].sort(),
    );
  });
});
