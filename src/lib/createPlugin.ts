import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureGitignore } from './gitignore.js';
import { scaffoldArtifactFiles } from './createArtifacts.js';
import type { ArtifactType, ScaffoldedFile } from './createArtifacts.js';
import { copilotFiles } from './createCopilotFiles.js';
import { thumbnailBytes } from './createThumbnail.js';
import type { Environment } from '../../shared/lib/credentials.js';

/**
 * The thumbnail must sit inside `entry`, not at the repo root: the packager
 * only considers files matching `path.startsWith(entryPrefix)` and then strips
 * that prefix before matching `thumbnail.png`. At the root it is invisible, and
 * publish fails with "Thumbnail is required for publishing".
 */
const THUMBNAIL_PATH = 'src/thumbnail.png';

/**
 * Environments the `prod` alias resolves to. A business id issued for either of
 * these is already covered by the default `release_environments: ['prod']`.
 */
const PROD_ENVIRONMENTS: readonly Environment[] = ['go', 'fmo'];

export interface CreatePluginInput {
  targetDir: string;
  name: string;
  apiName: string;
  externalLink: string;
  description: string;
  developerBusinessId: string;
  developerEnvironment: Environment;
  /**
   * Artifact types to scaffold under `src/`. An empty list (the default)
   * reproduces the old behaviour of an empty `src/`, which builds to a plugin
   * with no artifacts at all.
   */
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

  // A business id only exists in the environment it was issued for. Pairing an
  // id keyed to, say, `integration` with the default `['prod']` (which resolves
  // to go + fmo) leaves a preview deploy with no covered target, so it skips
  // every environment and publishes nothing. Retarget the manifest at the
  // environment we actually have an id for. go/fmo ids are already covered by
  // 'prod', so the common case keeps the documented default.
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
    // `developer_business_id` is optional, but an empty string is a hard
    // `manifest/developer-business-id` error while an absent key is fine, so
    // omit it entirely when nothing is configured. When we do have an id, use
    // the per-environment object form: a bare string alongside
    // `release_environments: ['prod']` (which resolves to both `go` and `fmo`)
    // trips the `manifest/developer-business-id-environments` warning, because
    // one business id generally only exists in one environment.
    ...(businessId ? { developer_business_id: { [input.developerEnvironment]: businessId } } : {}),
  };
}

/**
 * Writes scaffolded text files. Directories are created first so the file
 * writes can run concurrently without racing on a shared parent.
 */
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
