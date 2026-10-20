import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type * as OsModule from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GLOBAL_CREDENTIALS_DIR, listCredentialProfiles } from './credentials.js';
import { createOAuthStore, type OAuthSession } from './oauthStore.js';
import { oauthSession, rejectionOf } from '../test/oauth.js';

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

describe('oauth store', () => {
  it('uses a temp home, never the real one', () => {
    expect(GLOBAL_CREDENTIALS_DIR).toBe(join(homedir(), '.kizenappbuilder'));
    expect(homedir()).toContain('appbuilder-oauth-home-');
  });

  it('session file is written 0600 in oauth subdirectory and is not listed as a credential profile', async () => {
    const store = createOAuthStore();

    // An API-key profile at the top level, next to the oauth/ directory.
    await mkdir(GLOBAL_CREDENTIALS_DIR, { recursive: true });
    await writeFile(join(GLOBAL_CREDENTIALS_DIR, 'work.json'), '{}');

    await store.writeSession(oauthSession());
    await store.writeSession(
      oauthSession({ environment: 'go', issuer: 'https://app.go.kizen.com' }),
    );
    await store.writeClientId('https://staging.kizen.com', 'client-1');

    const path = join(GLOBAL_CREDENTIALS_DIR, 'oauth', 'staging.json');

    expect(store.sessionPath('staging')).toBe(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(GLOBAL_CREDENTIALS_DIR, 'oauth', 'clients.json'))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(join(GLOBAL_CREDENTIALS_DIR, 'oauth'))).mode & 0o777).toBe(0o700);
    // Nothing OAuth-related lands at the top level, and no temp files are left behind.
    expect((await readdir(GLOBAL_CREDENTIALS_DIR)).sort()).toStrictEqual(['oauth', 'work.json']);
    // No lock files: only the sessions and the client cache.
    expect((await readdir(join(GLOBAL_CREDENTIALS_DIR, 'oauth'))).sort()).toStrictEqual([
      'clients.json',
      'go.json',
      'staging.json',
    ]);

    const profiles = await listCredentialProfiles();

    expect(profiles.map((profile) => profile.name)).toStrictEqual(['credentials', 'work']);
    expect(
      profiles.every((profile) => !profile.path.includes(join(GLOBAL_CREDENTIALS_DIR, 'oauth'))),
    ).toBe(true);
  });

  it('round-trips a session and lists, then deletes it', async () => {
    const store = createOAuthStore(join(homedir(), 'other'));

    expect(await store.readSession('integration')).toBeNull();
    await store.writeSession(oauthSession({ environment: 'integration', expiresAt: 42 }));
    expect(await store.readSession('integration')).toStrictEqual(
      oauthSession({ environment: 'integration', expiresAt: 42 }),
    );
    expect(await store.listSessions()).toStrictEqual(['integration']);
    expect(await store.deleteSession('integration')).toBe(true);
    expect(await store.deleteSession('integration')).toBe(false);
    expect(await store.listSessions()).toStrictEqual([]);
  });

  it('caches client ids per issuer and forgets one without touching the others', async () => {
    const store = createOAuthStore(join(homedir(), 'clients'));

    await store.writeClientId('https://a.test', 'a1');
    await store.writeClientId('https://b.test', 'b1');
    await store.forgetClientId('https://a.test');

    expect(await store.readClientId('https://a.test')).toBeUndefined();
    expect(await store.readClientId('https://b.test')).toBe('b1');
  });

  it('corrupt session file reports an unreadable-session error naming the path', async () => {
    const store = createOAuthStore(join(homedir(), 'corrupt'));
    const path = store.sessionPath('staging');
    const fixtures = [
      // Truncated JSON.
      '{"accessToken": "secret-in-file-1", "refre',
      // Valid JSON, wrong shape.
      JSON.stringify({ accessToken: 'secret-in-file-1' }),
      // A session for another environment under this one's name.
      JSON.stringify(oauthSession({ environment: 'go', accessToken: 'secret-in-file-1' })),
    ];

    await mkdir(store.dir, { recursive: true });

    for (const contents of fixtures) {
      await writeFile(path, contents);

      const error = await rejectionOf(store.readSession('staging'));

      expect(error.message).toBe(
        `The saved staging session at ${path} can't be read. Run \`appbuilder login --env staging\` to sign in again.`,
      );
      expect(error.message).not.toContain('secret-in-file-1');
      // Listed as present, so selecting "the only signed-in environment" surfaces the error.
      expect(await store.listSessions()).toStrictEqual(['staging']);
    }

    // Absent is still null, not an error.
    await rm(path);
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.listSessions()).toStrictEqual([]);
  });

  it('session without loginId reads as unreadable', async () => {
    const store = createOAuthStore(join(homedir(), 'no-login-id'));
    const path = store.sessionPath('staging');
    const withoutLoginId: Partial<OAuthSession> = oauthSession();

    delete withoutLoginId.loginId;

    await mkdir(store.dir, { recursive: true });

    // Missing, empty, and not a string: none may come back with loginId undefined.
    for (const contents of [
      withoutLoginId,
      { ...withoutLoginId, loginId: '' },
      { ...withoutLoginId, loginId: 42 },
    ]) {
      await writeFile(path, JSON.stringify(contents));

      const error = await rejectionOf(store.readSession('staging'));

      expect(error.code).toBe('login_required');
      expect(error.message).toContain("can't be read");
    }

    // The same file with a loginId reads back, so the field is what made it unreadable.
    await writeFile(path, JSON.stringify(oauthSession()));
    expect(await store.readSession('staging')).toStrictEqual(oauthSession());
  });

  it('pre-existing 0755 oauth dir and 0644 session file end up 0700/0600 after a write', async () => {
    const store = createOAuthStore(join(homedir(), 'loose'));
    const path = store.sessionPath('staging');

    await mkdir(store.dir, { recursive: true });
    await chmod(store.dir, 0o755);
    await writeFile(path, JSON.stringify(oauthSession({ accessToken: 'old' })));
    await chmod(path, 0o644);
    expect((await stat(store.dir)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).mode & 0o777).toBe(0o644);

    await store.writeSession(oauthSession());

    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.readSession('staging')).toStrictEqual(oauthSession());
  });

  it('a write that fails mid-way leaves the previous session readable and no tmp file', async () => {
    const store = createOAuthStore(join(homedir(), 'failed-write'));

    await store.writeSession(oauthSession());

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
    expect(await readdir(store.dir)).toStrictEqual(['staging.json']);
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
