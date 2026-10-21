import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import type * as FsPromisesModule from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountKey,
  createOAuthStore,
  SIGNOUT_MAX_AGE_MS,
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

  return { ...fs, readFile, default: { ...fs, readFile } };
});

afterEach(() => {
  hooks.pauseRead = undefined;
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
