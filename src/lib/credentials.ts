import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ENVIRONMENTS = ['go', 'fmo', 'staging', 'integration', 'test1'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface Credentials {
  apiKey: string;
  userId: string;
  businessId: string;
  environment: Environment;
}

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

function parseCredentials(raw: unknown): Credentials {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Credentials must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const env = obj.environment;

  return {
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : '',
    userId: typeof obj.userId === 'string' ? obj.userId : '',
    businessId: typeof obj.businessId === 'string' ? obj.businessId : '',
    environment: isValidEnvironment(env) ? env : 'go',
  };
}

export async function loadCredentialsFromFile(filePath: string): Promise<Credentials> {
  const content = await readFile(filePath, 'utf-8');

  return parseCredentials(JSON.parse(content) as unknown);
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
