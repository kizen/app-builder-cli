import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureGitignore } from './gitignore.js';
import { scaffoldArtifactFiles } from './createArtifacts.js';
import type { ArtifactType, ScaffoldedFile } from './createArtifacts.js';
import { copilotFiles } from './createCopilotFiles.js';
import { thumbnailBytes } from './createThumbnail.js';
import type { Environment } from '../../shared/lib/credentials.js';

const THUMBNAIL_PATH = 'src/thumbnail.png';

const PROD_ENVIRONMENTS: readonly Environment[] = ['go', 'fmo'];

export interface CreatePluginInput {
  targetDir: string;
  name: string;
  apiName: string;
  externalLink: string;
  description: string;
  developerBusinessId: string;
  developerEnvironment: Environment;
  artifacts?: readonly ArtifactType[];
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
  const businessId = input.developerBusinessId.trim();

  const targetEnvironments =
    businessId !== '' && !PROD_ENVIRONMENTS.includes(input.developerEnvironment)
      ? [input.developerEnvironment]
      : ['prod'];

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
    release_environments: targetEnvironments,
    config_template: {},
    base_config: {},
    ...(businessId ? { developer_business_id: { [input.developerEnvironment]: businessId } } : {}),
  };
}

async function writeScaffoldedFiles(
  targetDir: string,
  scaffolded: readonly ScaffoldedFile[],
): Promise<void> {
  const files = scaffolded.map((file) => ({
    fullPath: join(targetDir, ...file.path.split('/')),
    content: file.content,
  }));

  const directories = new Set(files.map((file) => dirname(file.fullPath)));

  await Promise.all([...directories].map((dir) => mkdir(dir, { recursive: true })));

  await Promise.all(files.map((file) => writeFile(file.fullPath, file.content, 'utf-8')));
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

  await Promise.all([
    writeScaffoldedFiles(input.targetDir, scaffoldArtifactFiles(input.artifacts ?? [])),
    writeScaffoldedFiles(input.targetDir, copilotFiles()),
    writeFile(join(input.targetDir, ...THUMBNAIL_PATH.split('/')), thumbnailBytes(input.apiName)),
  ]);

  ensureGitignore(input.targetDir);
}
