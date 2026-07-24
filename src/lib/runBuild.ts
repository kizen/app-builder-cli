import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PluginValidationError,
  minifyFiles,
  packagePlugin,
  parseManifestFromFiles,
  transformDeployablePlugin,
  validatePluginApp,
} from '@kizenapps/packager';
import type { DeployablePlugin } from '@kizenapps/packager';
import { readLocalFiles } from './readFiles.js';

export type BuildStepName =
  | 'creating-dir'
  | 'reading-files'
  | 'validating'
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

  onStep?.('validating');

  const issues = validatePluginApp(files);

  if (issues.some((issue) => issue.severity === 'error')) {
    throw new PluginValidationError(issues);
  }

  onStep?.('minifying');

  const minified = await minifyFiles(files);

  onStep?.('packaging');

  const manifests = parseManifestFromFiles(minified);
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
