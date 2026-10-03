import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ENVIRONMENTS,
  normalizeCredentialIds,
  type Environment,
  type Credentials,
} from '../../shared/lib/credentials.js';
export {
  ENVIRONMENTS,
  normalizeCredentialIds,
  type Environment,
  type Credentials,
} from '../../shared/lib/credentials.js';

export interface CredentialProfile {
  name: string;
  path: string;
  isDefault: boolean;
}

export const GLOBAL_CREDENTIALS_DIR = join(homedir(), '.kizenappbuilder');
export const GLOBAL_CREDENTIALS_PATH = join(GLOBAL_CREDENTIALS_DIR, 'credentials.json');
export const DEFAULT_PROFILE_NAME = 'credentials';

function isValidEnvironment(value: unknown): value is Environment {
  return ENVIRONMENTS.includes(value as Environment);
}

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export type EnvironmentSource = 'explicit' | 'missing' | 'invalid';

export interface DetailedCredentials {
  credentials: Credentials;
  environmentSource: EnvironmentSource;
}

function environmentSourceOf(env: unknown): EnvironmentSource {
  if (isValidEnvironment(env)) {
    return 'explicit';
  }

  return env === undefined || env === null || env === '' ? 'missing' : 'invalid';
}

function parseCredentials(raw: unknown): DetailedCredentials {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Credentials must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const env = trimString(obj.environment);

  return {
    credentials: {
      ...normalizeCredentialIds(obj),
      environment: isValidEnvironment(env) ? env : 'go',
    },
    environmentSource: environmentSourceOf(env),
  };
}

export async function loadCredentialsDetailed(filePath: string): Promise<DetailedCredentials> {
  const content = await readFile(filePath, 'utf-8');

  return parseCredentials(JSON.parse(content) as unknown);
}

export async function loadCredentialsFromFile(filePath: string): Promise<Credentials> {
  return (await loadCredentialsDetailed(filePath)).credentials;
}

export async function loadGlobalCredentials(): Promise<Credentials | null> {
  try {
    return await loadCredentialsFromFile(GLOBAL_CREDENTIALS_PATH);
  } catch {
    return null;
  }
}

export async function saveGlobalCredentials(credentials: Credentials): Promise<void> {
  await mkdir(dirname(GLOBAL_CREDENTIALS_PATH), { recursive: true, mode: 0o700 });

  await writeFile(GLOBAL_CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function getProfilePath(name: string): string {
  return join(GLOBAL_CREDENTIALS_DIR, `${name}.json`);
}

export async function listCredentialProfiles(): Promise<CredentialProfile[]> {
  const profiles: CredentialProfile[] = [
    { name: DEFAULT_PROFILE_NAME, path: GLOBAL_CREDENTIALS_PATH, isDefault: true },
  ];

  try {
    const entries = await readdir(GLOBAL_CREDENTIALS_DIR);

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }

      const name = entry.slice(0, -5);

      if (name === DEFAULT_PROFILE_NAME) {
        continue;
      }

      profiles.push({ name, path: join(GLOBAL_CREDENTIALS_DIR, entry), isDefault: false });
    }
  } catch {
    // directory doesn't exist yet — only the default profile
  }

  return profiles;
}

export async function saveCredentialProfile(name: string, credentials: Credentials): Promise<void> {
  if (name === DEFAULT_PROFILE_NAME) {
    await saveGlobalCredentials(credentials);

    return;
  }

  await mkdir(GLOBAL_CREDENTIALS_DIR, { recursive: true, mode: 0o700 });

  await writeFile(getProfilePath(name), JSON.stringify(credentials, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export async function loadCredentialProfile(name: string): Promise<Credentials | null> {
  try {
    return await loadCredentialsFromFile(getProfilePath(name));
  } catch {
    return null;
  }
}

export async function listLoadableCredentialProfiles(): Promise<CredentialProfile[]> {
  const profiles = await listCredentialProfiles();
  const loadable = await Promise.all(
    profiles.map((profile) =>
      loadCredentialsDetailed(profile.path).then(
        () => true,
        () => false,
      ),
    ),
  );

  return profiles.filter((_, index) => loadable[index] === true);
}
