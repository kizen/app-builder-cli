import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import type * as FsPromisesModule from 'node:fs/promises';
import { homedir } from 'node:os';
import type * as OsModule from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_CREDENTIALS_DIR, listCredentialProfiles } from './credentials.js';
import {
  accountKey,
  createOAuthStore,
  MAX_ID_BYTES,
  SIGNOUT_MAX_AGE_MS,
  type OAuthAccount,
  type OAuthSession,
  type OAuthStore,
} from './oauthStore.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  accountOf,
  ISSUER,
  oauthSession,
  deferred,
  rejectionOf,
  signIn,
} from '../test/oauth.js';

/**
 * When set, the next `readFile` of a path it matches completes the read, then waits on `gate`
 * before returning: a pause inside a store call, between its read and what it does next.
 */
const hooks = vi.hoisted(() => ({
  pauseRead: undefined as
    | { matches: (path: string) => boolean; reached: () => void; gate: Promise<void> }
    | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromisesModule>();
  const readFile = async (...args: Parameters<typeof fs.readFile>): Promise<string | Buffer> => {
    const result = await fs.readFile(...args);
    const pause = hooks.pauseRead;

    if (pause !== undefined && typeof args[0] === 'string' && pause.matches(args[0])) {
      hooks.pauseRead = undefined;
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

// Point the home directory at a fresh temp dir before credentials.ts computes
// GLOBAL_CREDENTIALS_DIR, so the real ~/.kizenappbuilder is never touched and
// listCredentialProfiles reads the same directory the store writes under.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof OsModule>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appbuilder-oauth-home-'));

  return { ...os, homedir: () => home, default: { ...os, homedir: () => home } };
});

afterAll(async () => {
  await rm(homedir(), { recursive: true, force: true });
});

/** Lowercase hex, as the store encodes each id in a file name. */
const hex = (id: string): string => Buffer.from(id, 'utf-8').toString('hex');

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

/** A file name from an earlier unreleased build: `<env>.<uuid>.json`. */
const LEGACY_ID = '00000000-0000-4000-8000-00000000000a';

const unreadableMessage = (path: string): string =>
  `The saved staging session at ${path} can't be read. Run \`appbuilder login --env staging\` to sign in again.`;

describe('oauth store', () => {
  it('uses a temp home, never the real one', () => {
    expect(GLOBAL_CREDENTIALS_DIR).toBe(join(homedir(), '.kizenappbuilder'));
    expect(homedir()).toContain('appbuilder-oauth-home-');
  });

  it('pointer and account files are written 0600 in a 0700 oauth subdirectory and are not listed as credential profiles', async () => {
    const store = createOAuthStore();

    // An API-key profile at the top level, next to the oauth/ directory.
    await mkdir(GLOBAL_CREDENTIALS_DIR, { recursive: true });
    await writeFile(join(GLOBAL_CREDENTIALS_DIR, 'work.json'), '{}');

    await signIn(store, oauthSession());
    await signIn(store, oauthSession({ environment: 'go', issuer: 'https://app.go.kizen.com' }));
    await store.writeClientId('https://staging.kizen.com', 'client-1');

    const oauthDir = join(GLOBAL_CREDENTIALS_DIR, 'oauth');
    const pointer = join(oauthDir, 'staging.json');
    const accountFile = join(oauthDir, `staging.${hex('biz-a')}.${hex('user-a')}.json`);

    expect(accountKey(ACCOUNT_A)).toBe(`${hex('biz-a')}.${hex('user-a')}`);
    expect(store.sessionPath('staging')).toBe(pointer);
    expect(store.accountPath('staging', ACCOUNT_A)).toBe(accountFile);
    expect(JSON.parse(await readFile(pointer, 'utf-8'))).toStrictEqual(ACCOUNT_A);
    // The identity labels are stored with the tokens.
    expect(JSON.parse(await readFile(accountFile, 'utf-8'))).toStrictEqual(oauthSession());

    for (const file of [pointer, accountFile, join(oauthDir, 'clients.json')]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    expect((await stat(oauthDir)).mode & 0o777).toBe(0o700);
    // Nothing OAuth-related lands at the top level, and no temp files are left behind.
    expect((await readdir(GLOBAL_CREDENTIALS_DIR)).sort()).toStrictEqual(['oauth', 'work.json']);
    // No lock files: only the pointers, the accounts and the client cache.
    expect((await readdir(oauthDir)).sort()).toStrictEqual(
      [
        'clients.json',
        `go.${accountKey(ACCOUNT_A)}.json`,
        'go.json',
        `staging.${accountKey(ACCOUNT_A)}.json`,
        'staging.json',
      ].sort(),
    );

    const profiles = await listCredentialProfiles();

    expect(profiles.map((profile) => profile.name)).toStrictEqual(['credentials', 'work']);
    expect(profiles.every((profile) => !profile.path.includes(oauthDir))).toBe(true);
  });

  it('round-trips a session through the pointer, lists it, and signs out', async () => {
    const store = createOAuthStore(join(homedir(), 'other'));
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
    const store = createOAuthStore(join(homedir(), 'in-place'));

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
    const store = createOAuthStore(join(homedir(), 'delete-one'));

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
    const store = createOAuthStore(join(homedir(), 'list'));
    const unreadableAccount: OAuthAccount = { businessId: 'biz-c', userId: 'user-c' };
    const unreadablePath = store.accountPath('staging', unreadableAccount);

    expect(await store.listAccounts('staging')).toStrictEqual([]);

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());
    await signIn(store, oauthSession({ environment: 'go', issuer: 'https://app.go.kizen.com' }));
    await writeFile(unreadablePath, '{"accessToken": "secret-in-file", "tr');
    // Not account files: a temp file, a moved-aside pointer, a legacy session, the client cache.
    await writeFile(join(store.dir, `staging.${accountKey(ACCOUNT_B)}.json.abc.tmp`), '{}');
    await writeFile(
      join(store.dir, 'staging.json.0123456789ab.signout'),
      JSON.stringify(ACCOUNT_B),
    );
    await writeFile(join(store.dir, `staging.${LEGACY_ID}.json`), JSON.stringify(oauthSession()));
    await store.writeClientId(ISSUER, 'client-1');

    // Sorted by business name (or id), case-insensitively.
    expect(await store.listAccounts('staging')).toStrictEqual([
      { account: ACCOUNT_A, session: oauthSession(), current: true },
      { account: unreadableAccount, session: undefined, current: false },
      { account: ACCOUNT_B, session: sessionB(), current: false },
    ]);

    // An unreadable pointer marks nothing current, and the accounts are still listed.
    await writeFile(store.sessionPath('staging'), '{"trunc');
    expect(
      (await store.listAccounts('staging')).map(({ account, current }) => [account, current]),
    ).toStrictEqual([
      [ACCOUNT_A, false],
      [unreadableAccount, false],
      [ACCOUNT_B, false],
    ]);
  });

  it('caches client ids per issuer and forgets one without touching the others', async () => {
    const store = createOAuthStore(join(homedir(), 'clients'));

    await store.writeClientId('https://a.test', 'a1');
    await store.writeClientId('https://b.test', 'b1');
    await store.forgetClientId('https://a.test');

    expect(await store.readClientId('https://a.test')).toBeUndefined();
    expect(await store.readClientId('https://b.test')).toBe('b1');
  });

  it('corrupt pointer or session file reports an unreadable-session error naming the path', async () => {
    const store = createOAuthStore(join(homedir(), 'corrupt'));
    const pointer = store.sessionPath('staging');
    const sessionFile = store.accountPath('staging', ACCOUNT_A);
    const fixtures: [path: string, contents: string][] = [
      // Truncated JSON.
      [pointer, '{"accessToken": "secret-in-file-1", "refre'],
      [sessionFile, '{"accessToken": "secret-in-file-1", "refre'],
      // Valid JSON, wrong shape.
      [pointer, JSON.stringify({ accessToken: 'secret-in-file-1' })],
      [sessionFile, JSON.stringify({ accessToken: 'secret-in-file-1' })],
      // A pointer with an extra key.
      [pointer, JSON.stringify({ ...ACCOUNT_A, accessToken: 'secret-in-file-1' })],
      // A session for another environment under this one's name.
      [
        sessionFile,
        JSON.stringify(oauthSession({ environment: 'go', accessToken: 'secret-in-file-1' })),
      ],
      // A session for another account than the one its file (and the pointer) names.
      [sessionFile, JSON.stringify(sessionB({ accessToken: 'secret-in-file-1' }))],
      [
        sessionFile,
        JSON.stringify(oauthSession({ userId: 'user-other', accessToken: 'secret-in-file-1' })),
      ],
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

  it('session without valid account ids reads as unreadable', async () => {
    const store = createOAuthStore(join(homedir(), 'no-account'));
    const path = store.accountPath('staging', ACCOUNT_A);
    const withoutIds: Partial<OAuthSession> = oauthSession();

    delete withoutIds.businessId;
    delete withoutIds.userId;

    await mkdir(store.dir, { recursive: true });
    await writeFile(store.sessionPath('staging'), JSON.stringify(ACCOUNT_A));

    // Missing, empty, or not strings: none may come back.
    for (const contents of [
      withoutIds,
      { ...withoutIds, businessId: 'biz-a' },
      { ...withoutIds, businessId: '', userId: 'user-a' },
      { ...withoutIds, businessId: 'biz-a', userId: 42 },
    ]) {
      await writeFile(path, JSON.stringify(contents));

      const error = await rejectionOf(store.readSession('staging'));

      expect(error.code).toBe('login_required');
      expect(error.message).toContain("can't be read");
    }

    // The same file with its ids reads back, so the ids are what made it unreadable.
    await writeFile(path, JSON.stringify(oauthSession()));
    expect(await store.readSession('staging')).toStrictEqual(oauthSession());
  });

  it('an account key that fails validation is never used in a path', async () => {
    const base = join(homedir(), 'traversal');
    const store = createOAuthStore(base);
    // Readable sessions wherever a bad id would lead if it were joined into a path raw: the
    // credentials dir above oauth/, a subdirectory of oauth/, and inside oauth/ itself.
    const bait = JSON.stringify(oauthSession({ accessToken: 'secret-outside' }));
    const baitFiles = [
      join(base, 'x.json'),
      join(store.dir, 'staging..json'),
      join(store.dir, 'staging.sub', 'x.json'),
      join(store.dir, 'staging.x.user-a.json'),
    ];

    await mkdir(join(store.dir, 'staging.sub'), { recursive: true });

    for (const file of baitFiles) {
      await writeFile(file, bait);
    }

    // Path syntax is a valid id, but only ever reaches a path hex-encoded: the pointer
    // names a file inside oauth/ that doesn't exist, and nothing outside it is read or written.
    for (const id of ['../x', '/../../x', 'sub/x', '..', `x.json/../../x`]) {
      const account = { businessId: id, userId: '../user-a' };
      const path = store.accountPath('staging', account);

      expect(path).toBe(join(store.dir, `staging.${hex(id)}.${hex('../user-a')}.json`));
      await writeFile(store.sessionPath('staging'), JSON.stringify(account));
      expect(await store.readSession('staging')).toBeNull();
      await store.writeSession(oauthSession(account));
      expect(await store.readSession('staging')).toStrictEqual(oauthSession(account));
      expect(await store.deleteSession('staging', account)).toBe(true);
    }

    // Anything else fails validation before a path is built.
    const badIds: unknown[] = [
      '',
      'a\u0000b',
      'line\nbreak',
      '\ud800',
      'x'.repeat(MAX_ID_BYTES + 1),
      'é'.repeat(28),
      42,
      null,
    ];

    for (const bad of badIds) {
      for (const account of [
        { businessId: bad, userId: 'user-a' },
        { businessId: 'biz-a', userId: bad },
      ] as OAuthAccount[]) {
        await writeFile(store.sessionPath('staging'), JSON.stringify(account));

        const error = await rejectionOf(store.readSession('staging'));

        expect(error.code).toBe('login_required');
        expect(error.message).toBe(unreadableMessage(store.sessionPath('staging')));
        expect(await store.listSessions()).toStrictEqual(['staging']);
        // Nothing builds a path from it either.
        expect(() => store.accountPath('staging', account)).toThrow('invalid account id');
        expect(() => accountKey(account)).toThrow('invalid account id');
        await expect(store.readAccount('staging', account)).rejects.toThrow('invalid account id');
        await expect(store.setCurrent('staging', account)).rejects.toThrow('invalid account id');
        await expect(store.deleteSession('staging', account)).rejects.toThrow('invalid account id');
        await expect(store.writeSession(oauthSession(account))).rejects.toThrow(
          'invalid account id',
        );
      }
    }

    // File names that aren't the canonical encoding of valid ids aren't accounts: raw ids,
    // uppercase hex (the same bytes, spelled non-canonically), an odd length, a `0x` prefix, one
    // that decodes to a control character, and three segments.
    for (const name of [
      'staging.biz-a.user-a.json',
      `staging.${hex('biz-a').toUpperCase()}.${hex('user-a')}.json`,
      `staging.${hex('biz-a')}0.${hex('user-a')}.json`,
      `staging.0x${hex('biz-a')}.${hex('user-a')}.json`,
      `staging.${hex('\u0001')}.${hex('user-a')}.json`,
      `staging.${hex('biz-a')}.${hex('user-a')}.${hex('x')}.json`,
    ]) {
      await writeFile(join(store.dir, name), bait);
    }

    expect(await store.listAccounts('staging')).toStrictEqual([]);

    // Signing out removes the bad pointer and nothing it seemed to name.
    expect(await store.signOut('staging')).toBe(true);
    expect((await store.signOutAll('staging')).removed).toBe(0);

    for (const file of baitFiles) {
      expect(await readFile(file, 'utf-8')).toBe(bait);
    }
  });

  it('accepts ids in any safe format, not just UUIDs', async () => {
    const store = createOAuthStore(join(homedir(), 'formats'));
    const account = { businessId: 'Biz.With/Odd Chars:1', userId: 'ユーザー' };

    await signIn(store, oauthSession(account));

    expect(await store.readSession('staging')).toStrictEqual(oauthSession(account));
    expect(store.accountPath('staging', account)).toBe(
      join(store.dir, `staging.${hex(account.businessId)}.${hex(account.userId)}.json`),
    );
    expect((await store.listAccounts('staging')).map((entry) => entry.account)).toStrictEqual([
      account,
    ]);
  });

  it('account keys stay distinct when compared case-insensitively', () => {
    // Under base64url these two were `YWJj` and `YWJJ`: one file on a case-insensitive disk.
    const pair = [
      { businessId: 'abc', userId: 'u' },
      { businessId: 'abI', userId: 'u' },
    ];
    const randomId = (): string =>
      Array.from({ length: 1 + Math.floor(Math.random() * 20) }, () =>
        String.fromCharCode(33 + Math.floor(Math.random() * 94)),
      ).join('');
    const batch = Array.from({ length: 500 }, () => ({
      businessId: randomId(),
      userId: randomId(),
    }));
    const accounts = [...pair, ...batch];
    const distinct = new Set(accounts.map((account) => JSON.stringify(account)));
    const keys = accounts.map((account) => accountKey(account));

    // Keys are already lowercase, and distinct accounts never share one, ignoring case.
    expect(keys.every((key) => key === key.toLowerCase())).toBe(true);
    expect(new Set(keys.map((key) => key.toLowerCase())).size).toBe(distinct.size);
    expect(accountKey(pair[0] as OAuthAccount).toLowerCase()).not.toBe(
      accountKey(pair[1] as OAuthAccount).toLowerCase(),
    );
  });

  it('two accounts whose old encodings collide case-insensitively both survive a write and a delete', async () => {
    const store = createOAuthStore(join(homedir(), 'case-collision'));
    const lower = oauthSession({ businessId: 'abc', userId: 'u', accessToken: 'access-abc' });
    const upper = oauthSession({ businessId: 'abI', userId: 'u', accessToken: 'access-abI' });

    await store.writeSession(lower);
    await signIn(store, upper);

    expect(await store.readAccount('staging', lower)).toStrictEqual(lower);
    expect(await store.readSession('staging')).toStrictEqual(upper);
    expect(await store.listAccounts('staging')).toHaveLength(2);

    expect(await store.deleteSession('staging', lower)).toBe(true);
    expect(await store.readAccount('staging', lower)).toBeNull();
    expect(await store.readSession('staging')).toStrictEqual(upper);
  });

  it('the longest ids still make a file name that fits, temp file included', async () => {
    const store = createOAuthStore(join(homedir(), 'longest'));
    // Multi-byte characters count by their UTF-8 bytes.
    const longest = { businessId: 'x'.repeat(MAX_ID_BYTES), userId: 'é'.repeat(27) + 'y' };
    const name = `integration.${accountKey(longest)}.json`;

    expect(Buffer.byteLength(`${name}.0123456789ab.tmp`)).toBe(255);
    // A real write: an over-long name would fail with ENAMETOOLONG.
    await signIn(store, oauthSession({ environment: 'integration', ...longest }));
    expect(await store.readSession('integration')).toMatchObject(longest);
    expect(() => accountKey({ businessId: 'x'.repeat(MAX_ID_BYTES + 1), userId: 'u' })).toThrow(
      'invalid account id',
    );
  });

  it('removeAccount removes one saved account, and the pointer only when it names it', async () => {
    const store = createOAuthStore(join(homedir(), 'remove-one'));

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

  it("files from earlier builds don't crash anything, and login or logout cleans them up", async () => {
    const store = createOAuthStore(join(homedir(), 'old-format'));
    const legacyFile = join(store.dir, `staging.${LEGACY_ID}.json`);
    const legacyGo = join(store.dir, `go.${LEGACY_ID}.json`);
    const legacySession = JSON.stringify({ ...oauthSession(), loginId: LEGACY_ID });

    // Earlier builds kept the whole session in <env>.json, and then a `{ loginId }` pointer to
    // <env>.<uuid>.json. Both pointers read as unreadable; the uuid files are ignored.
    await mkdir(store.dir, { recursive: true });

    for (const pointer of [legacySession, JSON.stringify({ loginId: LEGACY_ID })]) {
      await writeFile(store.sessionPath('staging'), pointer);
      await writeFile(legacyFile, legacySession);

      const error = await rejectionOf(store.readSession('staging'));

      expect(error.code).toBe('login_required');
      expect(error.message).toBe(unreadableMessage(store.sessionPath('staging')));
      expect(await store.listSessions()).toStrictEqual(['staging']);
      expect(await store.listAccounts('staging')).toStrictEqual([]);
    }

    // Signing in replaces the pointer and deletes the old session file, whatever its age.
    await writeFile(legacyGo, legacySession);
    await signIn(store, sessionB());
    expect(await store.readSession('staging')).toStrictEqual(sessionB());
    expect((await readdir(store.dir)).sort()).toStrictEqual(
      [`go.${LEGACY_ID}.json`, `staging.${accountKey(ACCOUNT_B)}.json`, 'staging.json'].sort(),
    );

    // Logging out cleans up too, unreadable pointer and all.
    await writeFile(store.sessionPath('staging'), JSON.stringify({ loginId: LEGACY_ID }));
    await writeFile(legacyFile, legacySession);
    expect(await store.signOut('staging')).toBe(true);
    // The saved account stays: an unreadable pointer names none of them.
    expect((await readdir(store.dir)).sort()).toStrictEqual(
      [`go.${LEGACY_ID}.json`, `staging.${accountKey(ACCOUNT_B)}.json`].sort(),
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable pointer or session file gives the can't-be-read error and is still listed",
    async () => {
      const store = createOAuthStore(join(homedir(), 'eacces'));
      const go = oauthSession({ environment: 'go', issuer: 'https://app.go.kizen.com' });

      await signIn(store, oauthSession());
      await signIn(store, go);

      // chmod 000 makes readFile fail with EACCES (root ignores it, hence the skip).
      for (const path of [store.sessionPath('staging'), store.accountPath('staging', ACCOUNT_A)]) {
        await chmod(path, 0o000);

        try {
          const error = await rejectionOf(store.readSession('staging'));

          expect(error.code).toBe('login_required');
          expect(error.message).toBe(unreadableMessage(path));
          // Still listed, and the other environment is unaffected.
          expect(await store.listSessions()).toStrictEqual(['go', 'staging']);
          expect(await store.readSession('go')).toStrictEqual(go);
        } finally {
          await chmod(path, 0o600);
        }
      }
    },
  );

  it('a login that lands during a logout keeps its pointer', async () => {
    const base = join(homedir(), 'logout-race');
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

  it('a switch that lands during logout --business of the current account signs out and never restores the pointer', async () => {
    const base = join(homedir(), 'remove-race');
    const store = createOAuthStore(base);
    const reached = deferred();
    const gate = deferred();

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());

    // Pause removeAccount once it has read the pointer (naming A, the account being removed).
    hooks.pauseRead = {
      matches: (path) => path === store.sessionPath('staging'),
      reached: () => {
        reached.resolve();
      },
      gate: gate.promise,
    };

    const removing = store.removeAccount('staging', ACCOUNT_A);

    await reached.promise;
    // Another terminal switches to B meanwhile.
    await createOAuthStore(base).setCurrent('staging', ACCOUNT_B);
    gate.resolve();

    // B's pointer went with it, and stays gone; B's file stays saved.
    expect(await removing).toStrictEqual({ removed: true, current: true });
    await expect(stat(store.sessionPath('staging'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.readAccount('staging', ACCOUNT_A)).toBeNull();
    expect(await store.readAccount('staging', ACCOUNT_B)).toStrictEqual(sessionB());
  });

  it('a logout while logout --business holds the pointer aside finds nobody signed in, and nobody is afterwards', async () => {
    const base = join(homedir(), 'remove-race-logout');
    const store = createOAuthStore(base);
    const readPointer = { reached: deferred(), gate: deferred() };
    const readMoved = { reached: deferred(), gate: deferred() };

    await store.writeSession(sessionB());
    await signIn(store, oauthSession());

    hooks.pauseRead = {
      matches: (path) => path === store.sessionPath('staging'),
      reached: () => {
        readPointer.reached.resolve();
      },
      gate: readPointer.gate.promise,
    };

    const removing = store.removeAccount('staging', ACCOUNT_A);

    await readPointer.reached.promise;
    // A switch to B lands, then removeAccount moves B's pointer aside and pauses reading it.
    await createOAuthStore(base).setCurrent('staging', ACCOUNT_B);
    hooks.pauseRead = {
      matches: (path) => path.endsWith('.signout'),
      reached: () => {
        readMoved.reached.resolve();
      },
      gate: readMoved.gate.promise,
    };
    readPointer.gate.resolve();
    await readMoved.reached.promise;

    // A plain logout elsewhere sees no pointer: "not signed in".
    expect(await createOAuthStore(base).signOut('staging')).toBe(false);
    readMoved.gate.resolve();

    expect(await removing).toStrictEqual({ removed: true, current: true });
    // Nothing put B back behind that logout's answer.
    await expect(stat(store.sessionPath('staging'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.listSessions()).toStrictEqual([]);
    expect(await store.readAccount('staging', ACCOUNT_B)).toStrictEqual(sessionB());
  });

  it("signOut surfaces a session file it can't remove", async () => {
    const store = createOAuthStore(join(homedir(), 'stuck'));
    const stuck = store.accountPath('staging', ACCOUNT_A);

    // A non-empty directory where the session file should be: unlink fails, and not with ENOENT.
    await mkdir(stuck, { recursive: true });
    await writeFile(join(stuck, 'x'), '');
    await writeFile(store.sessionPath('staging'), JSON.stringify(ACCOUNT_A));

    await expect(store.signOut('staging')).rejects.toMatchObject({
      code: expect.stringMatching(/^(EPERM|EISDIR)$/) as unknown,
    });
    // The pointer is gone, and no moved-aside copy is left.
    expect(await readdir(store.dir)).toStrictEqual([`staging.${accountKey(ACCOUNT_A)}.json`]);
  });

  it('signOut removes only the current account; signOutAll removes every saved account', async () => {
    const store = createOAuthStore(join(homedir(), 'sign-out-all'));
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

  it('clean-up removes old leftover sign-outs and legacy files but keeps every saved account, however old', async () => {
    const store: OAuthStore = createOAuthStore(join(homedir(), 'clean-up'));
    // Seconds, for utimes: a minute past the max age, and a minute short of it.
    const old = (Date.now() - SIGNOUT_MAX_AGE_MS - 60_000) / 1000;
    const recent = (Date.now() - SIGNOUT_MAX_AGE_MS + 60_000) / 1000;
    const tmpFile = join(store.dir, `staging.${accountKey(ACCOUNT_B)}.json.abc.tmp`);
    // Pointers a crash left between signOut's rename and its cleanup: old, recent, and old in
    // another environment.
    const oldSignout = join(store.dir, 'staging.json.0123456789ab.signout');
    const recentSignout = join(store.dir, 'staging.json.ba9876543210.signout');
    const goSignout = join(store.dir, 'go.json.0123456789ab.signout');
    const setAge = async (path: string, seconds: number): Promise<void> => {
      await utimes(path, seconds, seconds);
    };

    // A saved account that isn't current, long untouched, and one in another environment.
    await store.writeSession(sessionB());
    await setAge(store.accountPath('staging', ACCOUNT_B), old);
    await store.writeSession(oauthSession({ environment: 'go' }));
    await setAge(store.accountPath('go', ACCOUNT_A), old);
    // Not session files, however old: a temp file and the client cache.
    await writeFile(tmpFile, '{}');
    await setAge(tmpFile, old);
    await store.writeClientId(ISSUER, 'client-1');
    await setAge(join(store.dir, 'clients.json'), old);

    for (const [file, age] of [
      [oldSignout, old],
      [recentSignout, recent],
      [goSignout, old],
    ] as const) {
      await writeFile(file, JSON.stringify(ACCOUNT_B));
      await setAge(file, age);
    }

    await store.writeSession(oauthSession());
    await setAge(store.accountPath('staging', ACCOUNT_A), old);
    await store.setCurrent('staging', ACCOUNT_A);

    expect((await readdir(store.dir)).sort()).toStrictEqual(
      [
        'clients.json',
        'go.json.0123456789ab.signout',
        `go.${accountKey(ACCOUNT_A)}.json`,
        `staging.${accountKey(ACCOUNT_A)}.json`,
        `staging.${accountKey(ACCOUNT_B)}.json`,
        `staging.${accountKey(ACCOUNT_B)}.json.abc.tmp`,
        'staging.json',
        'staging.json.ba9876543210.signout',
      ].sort(),
    );

    // Logout cleans up too: the current account goes with the pointer, account B stays saved.
    await setAge(recentSignout, old);
    expect(await store.signOut('staging')).toBe(true);
    expect((await readdir(store.dir)).sort()).toStrictEqual(
      [
        'clients.json',
        'go.json.0123456789ab.signout',
        `go.${accountKey(ACCOUNT_A)}.json`,
        `staging.${accountKey(ACCOUNT_B)}.json`,
        `staging.${accountKey(ACCOUNT_B)}.json.abc.tmp`,
      ].sort(),
    );
    expect(await store.readAccount('staging', ACCOUNT_B)).toStrictEqual(sessionB());
  });

  it('pre-existing 0755 oauth dir and 0644 pointer and session files end up 0700/0600 after a sign-in', async () => {
    const store = createOAuthStore(join(homedir(), 'loose'));
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
    const store = createOAuthStore(join(homedir(), 'failed-write'));

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
      `staging.${accountKey(accountOf(oauthSession()))}.json`,
      'staging.json',
    ]);
  });

  it('concurrent clients.json writes leave a parseable file', async () => {
    const issuers = ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'];

    for (let round = 0; round < 8; round += 1) {
      const base = join(homedir(), 'clients-race', String(round));
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

  it('a corrupt clients.json is replaced on the next registration', async () => {
    const store = createOAuthStore(join(homedir(), 'clients-corrupt'));

    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'clients.json'), '{not json');

    expect(await store.readClientId('https://a.test')).toBeUndefined();
    await store.writeClientId('https://a.test', 'a1');
    expect(await store.readClientId('https://a.test')).toBe('a1');
  });
});
