import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as osModule from 'node:os';
import type * as credentialsModule from './credentials.js';
import type { Credentials } from '../../shared/lib/credentials.js';

// credentials.ts resolves its paths from homedir() at module load, so the fake
// home has to be in place before each dynamic import below.
const state = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>();

  return { ...actual, homedir: () => state.home };
});

type CredentialsModule = typeof credentialsModule;

let mod: CredentialsModule;

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'appbuilder-creds-'));

  vi.resetModules();

  mod = await import('./credentials.js');
});

afterEach(async () => {
  await rm(state.home, { recursive: true, force: true });
});

const VALID: Credentials = {
  apiKey: 'key-123',
  userId: 'user-123',
  businessId: 'biz-123',
  environment: 'staging',
};

async function writeGlobal(contents: string): Promise<void> {
  await mkdir(mod.GLOBAL_CREDENTIALS_DIR, { recursive: true });
  await writeFile(mod.GLOBAL_CREDENTIALS_PATH, contents, 'utf-8');
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('credential paths', () => {
  it('lives in ~/.kizenappbuilder', () => {
    expect(mod.GLOBAL_CREDENTIALS_DIR).toBe(join(state.home, '.kizenappbuilder'));
    expect(mod.GLOBAL_CREDENTIALS_PATH).toBe(
      join(state.home, '.kizenappbuilder', 'credentials.json'),
    );
  });

  it('derives profile paths as <name>.json in the same directory', () => {
    expect(mod.getProfilePath('work')).toBe(join(mod.GLOBAL_CREDENTIALS_DIR, 'work.json'));
  });

  it('names the default profile after the default file', () => {
    expect(mod.getProfilePath(mod.DEFAULT_PROFILE_NAME)).toBe(mod.GLOBAL_CREDENTIALS_PATH);
  });
});

describe('loadCredentialsFromFile parsing', () => {
  it('reads a fully valid credentials file', async () => {
    await writeGlobal(JSON.stringify(VALID));

    await expect(mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH)).resolves.toEqual(VALID);
  });

  it('coerces missing string fields to empty strings', async () => {
    await writeGlobal('{"environment":"go"}');

    await expect(mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH)).resolves.toEqual({
      apiKey: '',
      userId: '',
      businessId: '',
      environment: 'go',
    });
  });

  it('coerces non-string values to empty strings', async () => {
    await writeGlobal(
      JSON.stringify({ apiKey: 42, userId: null, businessId: { a: 1 }, environment: 'fmo' }),
    );

    await expect(mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH)).resolves.toEqual({
      apiKey: '',
      userId: '',
      businessId: '',
      environment: 'fmo',
    });
  });

  it('defaults an unknown environment to go', async () => {
    await writeGlobal(JSON.stringify({ ...VALID, environment: 'not-an-env' }));

    const loaded = await mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH);

    expect(loaded.environment).toBe('go');
    expect(loaded.apiKey).toBe('key-123');
  });

  it('defaults a missing or non-string environment to go', async () => {
    for (const environment of [undefined, 7, null, ['staging']]) {
      await writeGlobal(JSON.stringify({ apiKey: 'k', environment }));

      const loaded = await mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH);

      expect(loaded.environment).toBe('go');
    }
  });

  it('accepts every known environment', async () => {
    for (const environment of mod.ENVIRONMENTS) {
      await writeGlobal(JSON.stringify({ ...VALID, environment }));

      const loaded = await mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH);

      expect(loaded.environment).toBe(environment);
    }
  });

  it('drops unknown keys', async () => {
    await writeGlobal(JSON.stringify({ ...VALID, extra: 'nope' }));

    await expect(mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH)).resolves.toEqual(VALID);
  });

  it('rejects JSON that is not an object', async () => {
    for (const raw of ['null', '"a string"', '42', 'true']) {
      await writeGlobal(raw);

      await expect(mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH)).rejects.toThrow(
        'Credentials must be a JSON object',
      );
    }
  });

  it('rejects a missing file', async () => {
    await expect(mod.loadCredentialsFromFile(join(state.home, 'nope.json'))).rejects.toThrow();
  });

  it('rejects corrupt JSON', async () => {
    await writeGlobal('{ not json');

    await expect(mod.loadCredentialsFromFile(mod.GLOBAL_CREDENTIALS_PATH)).rejects.toThrow();
  });
});

describe('loadGlobalCredentials', () => {
  it('returns null when no credentials have been saved', async () => {
    await expect(mod.loadGlobalCredentials()).resolves.toBeNull();
  });

  it('returns null instead of throwing on corrupt credentials', async () => {
    await writeGlobal('{ not json');

    await expect(mod.loadGlobalCredentials()).resolves.toBeNull();
  });

  it('returns null instead of throwing on a non-object payload', async () => {
    await writeGlobal('null');

    await expect(mod.loadGlobalCredentials()).resolves.toBeNull();
  });

  it('returns the saved credentials', async () => {
    await mod.saveGlobalCredentials(VALID);

    await expect(mod.loadGlobalCredentials()).resolves.toEqual(VALID);
  });
});

describe('saveGlobalCredentials permissions', () => {
  it('creates the credentials directory as owner-only (0o700)', async () => {
    await mod.saveGlobalCredentials(VALID);

    expect(await modeOf(mod.GLOBAL_CREDENTIALS_DIR)).toBe(0o700);
  });

  it('writes the credentials file as owner-only (0o600)', async () => {
    await mod.saveGlobalCredentials(VALID);

    expect(await modeOf(mod.GLOBAL_CREDENTIALS_PATH)).toBe(0o600);
  });

  it('writes indented JSON', async () => {
    await mod.saveGlobalCredentials(VALID);

    expect(await readFile(mod.GLOBAL_CREDENTIALS_PATH, 'utf-8')).toBe(
      JSON.stringify(VALID, null, 2),
    );
  });

  it('overwrites previously saved credentials', async () => {
    await mod.saveGlobalCredentials(VALID);
    await mod.saveGlobalCredentials({ ...VALID, apiKey: 'key-456', environment: 'go' });

    await expect(mod.loadGlobalCredentials()).resolves.toEqual({
      ...VALID,
      apiKey: 'key-456',
      environment: 'go',
    });
  });
});

describe('credential profiles', () => {
  it('lists only the default profile when nothing has been saved', async () => {
    await expect(mod.listCredentialProfiles()).resolves.toEqual([
      { name: 'credentials', path: mod.GLOBAL_CREDENTIALS_PATH, isDefault: true },
    ]);
  });

  it('always reports the default profile first', async () => {
    await mod.saveCredentialProfile('alpha', VALID);

    const profiles = await mod.listCredentialProfiles();

    expect(profiles[0]).toEqual({
      name: mod.DEFAULT_PROFILE_NAME,
      path: mod.GLOBAL_CREDENTIALS_PATH,
      isDefault: true,
    });
  });

  it('lists saved profiles without duplicating the default', async () => {
    await mod.saveGlobalCredentials(VALID);
    await mod.saveCredentialProfile('work', VALID);
    await mod.saveCredentialProfile('personal', VALID);

    const profiles = await mod.listCredentialProfiles();

    expect(profiles.map((p) => p.name).sort()).toEqual(['credentials', 'personal', 'work']);
    expect(profiles.filter((p) => p.isDefault)).toHaveLength(1);
    expect(profiles.find((p) => p.name === 'work')?.path).toBe(mod.getProfilePath('work'));
  });

  it('ignores non-JSON files in the credentials directory', async () => {
    await mkdir(mod.GLOBAL_CREDENTIALS_DIR, { recursive: true });
    await writeFile(join(mod.GLOBAL_CREDENTIALS_DIR, 'notes.txt'), 'hi', 'utf-8');
    await writeFile(join(mod.GLOBAL_CREDENTIALS_DIR, 'config.json.bak'), '{}', 'utf-8');

    const profiles = await mod.listCredentialProfiles();

    expect(profiles.map((p) => p.name)).toEqual(['credentials']);
  });

  it('saves the default profile name to the global credentials path', async () => {
    await mod.saveCredentialProfile(mod.DEFAULT_PROFILE_NAME, VALID);

    await expect(mod.loadGlobalCredentials()).resolves.toEqual(VALID);
    await expect(mod.loadCredentialProfile(mod.DEFAULT_PROFILE_NAME)).resolves.toEqual(VALID);
  });

  it('writes named profiles owner-only', async () => {
    await mod.saveCredentialProfile('work', VALID);

    expect(await modeOf(mod.GLOBAL_CREDENTIALS_DIR)).toBe(0o700);
    expect(await modeOf(mod.getProfilePath('work'))).toBe(0o600);
  });

  it('round-trips a named profile', async () => {
    await mod.saveCredentialProfile('work', { ...VALID, environment: 'test1' });

    await expect(mod.loadCredentialProfile('work')).resolves.toEqual({
      ...VALID,
      environment: 'test1',
    });
  });

  it('returns null for a profile that does not exist', async () => {
    await expect(mod.loadCredentialProfile('missing')).resolves.toBeNull();
  });

  it('returns null for a corrupt profile', async () => {
    await mkdir(mod.GLOBAL_CREDENTIALS_DIR, { recursive: true });
    await writeFile(mod.getProfilePath('broken'), '{ not json', 'utf-8');

    await expect(mod.loadCredentialProfile('broken')).resolves.toBeNull();
  });

  it('keeps profiles independent of each other', async () => {
    await mod.saveCredentialProfile('a', { ...VALID, apiKey: 'a-key' });
    await mod.saveCredentialProfile('b', { ...VALID, apiKey: 'b-key' });

    await expect(mod.loadCredentialProfile('a')).resolves.toMatchObject({ apiKey: 'a-key' });
    await expect(mod.loadCredentialProfile('b')).resolves.toMatchObject({ apiKey: 'b-key' });
  });
});
