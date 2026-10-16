import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as OsModule from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GLOBAL_CREDENTIALS_DIR, listCredentialProfiles } from './credentials.js';
import { OAuthError } from './oauth.js';
import { createOAuthStore, type OAuthSession, type OAuthStore } from './oauthStore.js';

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

// A pass-through fs whose exclusive `open` can be paused, so a test can stall
// one taker between deciding to create a lock generation and creating it.
const fsHooks = vi.hoisted(() => ({
  beforeExclusiveOpen: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromisesModule>();
  const open = (async (...args: Parameters<typeof fs.open>) => {
    if (args[1] === 'wx' && fsHooks.beforeExclusiveOpen) {
      await fsHooks.beforeExclusiveOpen(String(args[0]));
    }

    return fs.open(...args);
  }) as typeof fs.open;

  return { ...fs, open, default: { ...fs, open } };
});

afterAll(async () => {
  await rm(homedir(), { recursive: true, force: true });
});

const session = (overrides: Partial<OAuthSession> = {}): OAuthSession => ({
  environment: 'staging',
  issuer: 'https://staging.kizen.com',
  clientId: 'client-1',
  tokenEndpoint: 'https://staging.kizen.com/oauth2/token',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 1_000_000,
  scope: 'read write offline_access',
  ...overrides,
});

/** The current (highest-generation, unreleased) lock file for staging. */
async function heldLock(store: OAuthStore): Promise<{ path: string; nonce: string }> {
  const entries = await readdir(store.dir);
  const generations = entries
    .map((entry) => /^staging\.lock\.(0|[1-9]\d*)$/.exec(entry)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const top = Math.max(...generations);

  expect(entries).not.toContain(`staging.lock.${String(top)}.released`);

  const path = join(store.dir, `staging.lock.${String(top)}`);

  return { path, nonce: await readFile(path, 'utf-8') };
}

/** Whether the staging lock can be taken right now (released again if so). */
async function isFree(store: OAuthStore): Promise<boolean> {
  try {
    await (
      await store.acquireLock('staging', { retryMs: 1, waitMs: 0 })
    )();

    return true;
  } catch {
    return false;
  }
}

const ageFile = async (path: string): Promise<void> => {
  const old = new Date(Date.now() - 60_000);

  await utimes(path, old, old);
};

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

    await store.writeSession(session());
    await store.writeSession(session({ environment: 'go', issuer: 'https://app.go.kizen.com' }));
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
    // The clients.json update's lock stays as a released generation.
    expect((await readdir(join(GLOBAL_CREDENTIALS_DIR, 'oauth'))).sort()).toStrictEqual([
      'clients.json',
      'clients.lock.0',
      'clients.lock.0.released',
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
    await store.writeSession(session({ environment: 'integration', expiresAt: 42 }));
    expect(await store.readSession('integration')).toStrictEqual(
      session({ environment: 'integration', expiresAt: 42 }),
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

  it('serializes lock holders', async () => {
    const store = createOAuthStore(join(homedir(), 'locks'));
    const release = await store.acquireLock('staging');
    let second = false;
    const waiting = store.acquireLock('staging', { retryMs: 5 }).then((r) => {
      second = true;

      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second).toBe(false);
    await release();

    const releaseSecond = await waiting;

    expect(second).toBe(true);
    await releaseSecond();
    expect(await isFree(store)).toBe(true);
  });

  it("release after staleMs overrun does not delete the successor's lock", async () => {
    const store = createOAuthStore(join(homedir(), 'takeover'));
    const releaseFirst = await store.acquireLock('staging');
    const firstLock = await heldLock(store);

    // The first holder stalls past the stale window and a second taker takes over.
    await ageFile(firstLock.path);

    const releaseSecond = await store.acquireLock('staging', { retryMs: 5, waitMs: 1000 });
    const secondLock = await heldLock(store);

    expect(secondLock.path).not.toBe(firstLock.path);
    expect(secondLock.nonce).not.toBe(firstLock.nonce);

    // The stalled first holder finishing must not delete or free the second holder's lock.
    await releaseFirst();
    expect(await readFile(secondLock.path, 'utf-8')).toBe(secondLock.nonce);
    expect(await heldLock(store)).toStrictEqual(secondLock);

    // So a third taker still has to wait for the second.
    await expect(store.acquireLock('staging', { retryMs: 5, waitMs: 50 })).rejects.toThrow(
      'Timed out waiting',
    );

    await releaseSecond();
    expect(await isFree(store)).toBe(true);
  });

  it('stale lock taken by concurrent takers yields exactly one holder', async () => {
    const TAKERS = 4;
    const ROUNDS = 40;

    for (let round = 0; round < ROUNDS; round += 1) {
      const base = join(homedir(), 'concurrent', String(round));
      // Separate store instances on one directory, as separate processes would be.
      const abandoned = createOAuthStore(base);

      await abandoned.acquireLock('staging');
      await ageFile((await heldLock(abandoned)).path);

      let holders = 0;
      let maxHolders = 0;
      let completed = 0;

      await Promise.all(
        Array.from({ length: TAKERS }, async () => {
          const release = await createOAuthStore(base).acquireLock('staging', {
            retryMs: 1,
            waitMs: 5000,
          });

          holders += 1;
          maxHolders = Math.max(maxHolders, holders);
          // Hold across real fs round trips so other takers' attempts interleave.
          await readdir(join(base, 'oauth'));
          await stat(join(base, 'oauth'));
          holders -= 1;
          completed += 1;
          await release();
        }),
      );

      expect({ round, maxHolders, completed }).toStrictEqual({
        round,
        maxHolders: 1,
        completed: TAKERS,
      });
    }
  });

  it('lock held by a dead pid is taken over without waiting staleMs', async () => {
    const base = join(homedir(), 'dead-pid');
    const DEAD = 424_242;

    await createOAuthStore(base, { pid: DEAD }).acquireLock('staging');

    const probed: number[] = [];
    const taker = createOAuthStore(base, {
      probeProcess: (pid) => {
        probed.push(pid);

        if (pid === DEAD) {
          throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        }
      },
    });
    // The default 30s staleMs applies; only the dead pid lets this through.
    const release = await taker.acquireLock('staging', { retryMs: 5, waitMs: 1000 });

    expect(probed).toContain(DEAD);
    // The taker really holds it now: a live-pid lock that a third taker must wait for.
    await expect(
      createOAuthStore(base).acquireLock('staging', { retryMs: 5, waitMs: 50 }),
    ).rejects.toThrow('Timed out waiting');
    await release();

    // With the real process.kill probe: a child that has exited.
    const exited = spawn(process.execPath, ['-e', '']);
    const exitedPid = exited.pid ?? 0;

    await once(exited, 'exit');
    expect(exitedPid).toBeGreaterThan(0);

    const realBase = join(homedir(), 'dead-pid-real');

    await createOAuthStore(realBase, { pid: exitedPid }).acquireLock('staging');
    await expect(
      createOAuthStore(realBase).acquireLock('staging', { retryMs: 5, waitMs: 1000 }),
    ).resolves.toBeTypeOf('function');
  });

  it('a slow taker that recreates a deleted generation backs off and waits for the real holder', async () => {
    /**
     * Z decides generation 0 is next and stalls before creating it. Meanwhile A
     * takes and releases 0, and B takes 1 (deleting 0) and holds it. Z then
     * creates 0 successfully, because it was deleted, and must not believe it
     * holds the lock.
     */
    const scenario = async (
      base: string,
      zWaitMs: number,
    ): Promise<{ z: Promise<() => Promise<void>>; releaseB: () => Promise<void> }> => {
      const target = join(base, 'oauth', 'staging.lock.0');
      let paused = false;
      let reached!: () => void;
      let resume!: () => void;
      const atOpen = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });

      fsHooks.beforeExclusiveOpen = async (path) => {
        if (path === target && !paused) {
          paused = true;
          reached();
          await resumed;
        }
      };

      const z = createOAuthStore(base).acquireLock('staging', { retryMs: 5, waitMs: zWaitMs });

      z.catch(() => undefined);
      await atOpen;

      await (
        await createOAuthStore(base).acquireLock('staging')
      )();

      const releaseB = await createOAuthStore(base).acquireLock('staging');

      expect(await readdir(join(base, 'oauth'))).not.toContain('staging.lock.0');
      resume();

      return { z, releaseB };
    };

    try {
      // While B holds generation 1, Z never gets the lock.
      const short = await scenario(join(homedir(), 'slow-taker-short'), 200);

      await expect(short.z).rejects.toThrow('Timed out waiting');
      await short.releaseB();

      // Once B releases, Z gets it, above B's generation.
      const base = join(homedir(), 'slow-taker-long');
      const long = await scenario(base, 5000);
      let zHolds = false;

      void long.z.then(() => (zHolds = true));
      // Z's recreated 0 is marked released: it backed off rather than holding it.
      await vi.waitFor(async () => {
        expect(await readdir(join(base, 'oauth'))).toContain('staging.lock.0.released');
      });
      expect(zHolds).toBe(false);
      await long.releaseB();

      const releaseZ = await long.z;
      const store = createOAuthStore(base);

      expect((await heldLock(store)).path).toBe(join(store.dir, 'staging.lock.2'));
      await releaseZ();
    } finally {
      fsHooks.beforeExclusiveOpen = undefined;
    }
  });

  it('lock dir with a foreign non-canonical generation name still honours waitMs', async () => {
    const store = createOAuthStore(join(homedir(), 'foreign-generation'));

    await mkdir(store.dir, { recursive: true });
    // Not a name this code writes: it must neither win as "generation 7" nor spin.
    await writeFile(join(store.dir, 'staging.lock.007'), '');
    await writeFile(join(store.dir, 'staging.lock.12x'), '');

    const release = await store.acquireLock('staging', { retryMs: 5, waitMs: 200 });

    expect((await heldLock(store)).path).toBe(join(store.dir, 'staging.lock.0'));

    // A waiter behind a real holder still gives up on time.
    const started = Date.now();

    await expect(
      createOAuthStore(join(homedir(), 'foreign-generation')).acquireLock('staging', {
        retryMs: 5,
        waitMs: 200,
      }),
    ).rejects.toThrow('Timed out waiting');
    expect(Date.now() - started).toBeLessThan(2000);
    await release();
  });

  it('lock held by a live pid is not taken over before staleMs', async () => {
    const base = join(homedir(), 'live-pid');
    const OTHER = 515_151;

    await createOAuthStore(base, { pid: OTHER }).acquireLock('staging');

    const alive = (): void => undefined;
    // EPERM: the process exists but belongs to someone else. A clean probe: it's ours.
    const probes: ((pid: number) => void)[] = [
      () => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      },
      alive,
    ];

    for (const probeProcess of probes) {
      await expect(
        createOAuthStore(base, { probeProcess }).acquireLock('staging', {
          retryMs: 5,
          waitMs: 100,
        }),
      ).rejects.toThrow('Timed out waiting for another appbuilder process');
    }

    // The mtime rule still applies to a live pid once the lock is older than staleMs.
    await ageFile((await heldLock(createOAuthStore(base))).path);
    await expect(
      createOAuthStore(base, { probeProcess: alive }).acquireLock('staging', {
        retryMs: 5,
        waitMs: 1000,
      }),
    ).resolves.toBeTypeOf('function');
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
      JSON.stringify(session({ environment: 'go', accessToken: 'secret-in-file-1' })),
    ];

    await mkdir(store.dir, { recursive: true });

    for (const contents of fixtures) {
      await writeFile(path, contents);

      const error = await store.readSession('staging').then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(OAuthError);
      expect((error as OAuthError).message).toBe(
        `The saved staging session at ${path} can't be read. Run \`appbuilder login --env staging\` to sign in again.`,
      );
      expect((error as OAuthError).message).not.toContain('secret-in-file-1');
      // Listed as present, so selecting "the only signed-in environment" surfaces the error.
      expect(await store.listSessions()).toStrictEqual(['staging']);
    }

    // Absent is still null, not an error.
    await rm(path);
    expect(await store.readSession('staging')).toBeNull();
    expect(await store.listSessions()).toStrictEqual([]);
  });

  it('pre-existing 0755 oauth dir and 0644 session file end up 0700/0600 after a write', async () => {
    const store = createOAuthStore(join(homedir(), 'loose'));
    const path = store.sessionPath('staging');

    await mkdir(store.dir, { recursive: true });
    await chmod(store.dir, 0o755);
    await writeFile(path, JSON.stringify(session({ accessToken: 'old' })));
    await chmod(path, 0o644);
    expect((await stat(store.dir)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).mode & 0o777).toBe(0o644);

    await store.writeSession(session());

    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.readSession('staging')).toStrictEqual(session());
  });

  it('a write that fails mid-way leaves the previous session readable and no tmp file', async () => {
    const store = createOAuthStore(join(homedir(), 'failed-write'));

    await store.writeSession(session());

    // Serializing throws after the temp file is open, before anything is renamed.
    const poisoned = session({
      accessToken: {
        toJSON: () => {
          throw new Error('disk on fire');
        },
      } as unknown as string,
    });

    await expect(store.writeSession(poisoned)).rejects.toThrow('disk on fire');
    expect(await store.readSession('staging')).toStrictEqual(session());
    expect(await readdir(store.dir)).toStrictEqual(['staging.json']);
  });

  it('concurrent client registrations for two issuers keep both client ids', async () => {
    for (let round = 0; round < 8; round += 1) {
      const base = join(homedir(), 'clients-race', String(round));
      // Two stores on one directory, as two `appbuilder login` processes would be.
      const a = createOAuthStore(base);
      const b = createOAuthStore(base);

      await Promise.all([
        a.writeClientId('https://a.test', `a-${String(round)}`),
        b.writeClientId('https://b.test', `b-${String(round)}`),
      ]);

      expect(
        JSON.parse(await readFile(join(base, 'oauth', 'clients.json'), 'utf-8')),
      ).toStrictEqual({
        'https://a.test': { clientId: `a-${String(round)}` },
        'https://b.test': { clientId: `b-${String(round)}` },
      });
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
