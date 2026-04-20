import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { minifyFiles, packagePlugin, transformDeployablePlugin } from '@kizenapps/packager';
import type { DeployablePlugin } from '@kizenapps/packager';
import { readLocalFiles } from './readFiles.js';

const REQUIRED_MANIFEST_FIELDS = ['name', 'api_name', 'version', 'entry'] as const;

type ParsedManifest = Parameters<typeof packagePlugin>[1];

function validateManifestObject(manifest: Record<string, unknown>, index?: number): void {
  const label = index === undefined ? 'kizen.json' : `kizen.json entry #${String(index + 1)}`;

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    const value = manifest[field];

    if (typeof value !== 'string' || value === '') {
      throw new Error(
        `${label} is missing required field "${field}" (expected a non-empty string).`,
      );
    }
  }
}

function parseManifest(content: string): ParsedManifest {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    throw new Error(`kizen.json is not valid JSON: ${detail}`);
  }

  if (Array.isArray(parsed)) {
    parsed.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`kizen.json entry #${String(i + 1)} is not a JSON object.`);
      }

      validateManifestObject(entry as Record<string, unknown>, i);
    });

    return parsed as ParsedManifest;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('kizen.json must be a JSON object (or array of objects).');
  }

  validateManifestObject(parsed as Record<string, unknown>);

  return parsed as ParsedManifest;
}

export type BuildStepName =
  | 'creating-dir'
  | 'reading-files'
  | 'minifying'
  | 'packaging'
  | 'writing-bundle';

interface ReleaseNote {
  version: string;
  notes: string;
}

type SerializableDeployablePlugin = Omit<DeployablePlugin, 'thumbnail' | 'kznFile'> & {
  thumbnail: string | null;
  kznFile: string | null;
  allReleaseNotes: ReleaseNote[];
};

const serializePlugin = (
  plugin: DeployablePlugin,
  allReleaseNotes: ReleaseNote[],
): SerializableDeployablePlugin => ({
  ...plugin,
  thumbnail: plugin.thumbnail ? Buffer.from(plugin.thumbnail).toString('base64') : null,
  kznFile: plugin.kznFile ? Buffer.from(plugin.kznFile).toString('base64') : null,
  allReleaseNotes,
});

export interface BuildResult {
  bundleSize: number;
}

export async function runBuild(
  pluginDir: string,
  outputDir: string,
  onStep?: (step: BuildStepName) => void,
): Promise<BuildResult> {
  await mkdir(outputDir, { recursive: true });

  onStep?.('reading-files');

  const files = await readLocalFiles(pluginDir);

  onStep?.('minifying');

  const minified = await minifyFiles(files);

  onStep?.('packaging');

  const manifestFile = minified.find((f) => f.path === 'kizen.json');

  if (!manifestFile) {
    throw new Error('kizen.json not found in plugin directory.');
  }

  const manifests = parseManifest(manifestFile.content);
  const packaged = packagePlugin(minified, manifests);
  const deployable = Object.values(packaged).map(transformDeployablePlugin);

  onStep?.('writing-bundle');

  const bundle = deployable.map((plugin) => {
    const notesDir = plugin.release_notes_directory?.replace(/\/$/, '');
    const allReleaseNotes: ReleaseNote[] = notesDir
      ? files
          .filter((f) => f.path.startsWith(notesDir + '/') && f.path.endsWith('.md') && f.content)
          .map((f) => ({
            version: f.path.slice(f.path.lastIndexOf('/') + 1, -3),
            notes: f.content,
          }))
          .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
      : [];

    return serializePlugin(plugin, allReleaseNotes);
  });

  const jsonStr = JSON.stringify(bundle, null, 2);

  // Report the size of the plugin bundle excluding the informational release
  // notes, so "bundle: 12KB" reflects actual plugin code rather than long
  // markdown changelogs.
  const stripReleaseNotes = (key: string, value: unknown): unknown =>
    key === 'allReleaseNotes' ? undefined : value;
  const bundleSize = Buffer.byteLength(JSON.stringify(bundle, stripReleaseNotes, 2), 'utf-8');

  await writeFile(join(outputDir, 'bundle.json'), jsonStr, 'utf-8');

  return { bundleSize };
}
