import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureGitignore } from './gitignore.js';

export interface CreatePluginInput {
  targetDir: string;
  name: string;
  apiName: string;
  externalLink: string;
  description: string;
  developerBusinessId: string;
}

export type PrecheckResult = 'ok' | 'has-manifest' | 'has-kizenapp';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

export async function precheckTargetDir(dir: string): Promise<PrecheckResult> {
  if (await pathExists(join(dir, 'kizen.json'))) {
    return 'has-manifest';
  }

  if (await pathExists(join(dir, '.kizenapp'))) {
    return 'has-kizenapp';
  }

  return 'ok';
}

export async function findAvailableSubDir(parentDir: string, baseName: string): Promise<string> {
  const base = join(parentDir, baseName);

  if (!(await pathExists(base))) {
    return base;
  }

  for (let i = 1; i < 1000; i++) {
    const candidate = join(parentDir, `${baseName}-${String(i)}`);

    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  throw new Error(`Could not find an available directory name for "${baseName}"`);
}

export function buildManifest(input: CreatePluginInput): Record<string, unknown> {
  return {
    name: input.name,
    version: '1.0.0',
    published: true,
    api_name: input.apiName,
    external_link: input.externalLink,
    description: input.description,
    entry: 'src/',
    engine: '1.0.0',
    release_notes_directory: 'releaseNotes/',
    release_environments: ['prod'],
    config_template: {},
    base_config: {},
    developer_business_id: input.developerBusinessId,
  };
}

export async function createPlugin(input: CreatePluginInput): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });

  const manifest = buildManifest(input);

  await writeFile(
    join(input.targetDir, 'kizen.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );

  await mkdir(join(input.targetDir, 'src'), { recursive: true });

  await mkdir(join(input.targetDir, 'releaseNotes'), { recursive: true });

  ensureGitignore(input.targetDir);
}
