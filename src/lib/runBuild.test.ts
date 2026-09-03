import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginValidationError, validatePluginApp } from '@kizenapps/packager';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlugin } from './createPlugin.js';
import { ARTIFACT_TYPES } from './createArtifacts.js';
import { readLocalFiles } from './readFiles.js';
import { runBuild } from './runBuild.js';

/**
 * A plausible developer business id. The bootstrap path is only meaningful when
 * the wizard-optional fields are actually filled in, so every plugin created
 * here supplies a real description and a real business id.
 */
const DEVELOPER_BUSINESS_ID = '3f1b5c1e-9f0a-4c2b-8d6a-7e5f4c3b2a10';

const PLUGIN_NAME = 'Acme Widgets';
const PLUGIN_API_NAME = 'acme_widgets';
const PLUGIN_DESCRIPTION = 'Adds Acme widget tooling to Kizen.';
const PLUGIN_EXTERNAL_LINK = 'https://example.com/acme-widgets';

/**
 * Keys every bundle entry carries: the manifest fields written by createPlugin,
 * plus the packaging fields transformDeployablePlugin adds and the
 * allReleaseNotes list runBuild attaches.
 */
const EXPECTED_BUNDLE_KEYS = [
  'name',
  'version',
  'published',
  'api_name',
  'external_link',
  'description',
  'entry',
  'engine',
  'release_notes_directory',
  'release_environments',
  'config_template',
  'base_config',
  'developer_business_id',
  'artifacts',
  'thumbnail',
  'kznFile',
  'services',
  'allReleaseNotes',
];

interface BundleReleaseNote {
  version: string;
  notes: string;
}

interface BundleEntry {
  name: string;
  version: string;
  api_name: string;
  external_link: string;
  description: string;
  entry: string;
  engine: string;
  release_notes_directory: string;
  developer_business_id: string;
  artifacts: Record<string, unknown[]>;
  thumbnail: string | null;
  kznFile: string | null;
  releaseNotes?: string;
  allReleaseNotes: BundleReleaseNote[];
}

describe('runBuild', () => {
  let workDir: string;
  let pluginDir: string;
  let outputDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'appbuilder-runbuild-'));
    pluginDir = join(workDir, 'plugin');
    outputDir = join(pluginDir, '.kizenapp');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** Bootstraps a plugin the way the CLI wizard does, with every field filled in. */
  const bootstrapPlugin = async (): Promise<void> => {
    await createPlugin({
      targetDir: pluginDir,
      name: PLUGIN_NAME,
      apiName: PLUGIN_API_NAME,
      externalLink: PLUGIN_EXTERNAL_LINK,
      description: PLUGIN_DESCRIPTION,
      developerBusinessId: DEVELOPER_BUSINESS_ID,
      developerEnvironment: 'go',
    });
  };

  const writeReleaseNote = async (fileName: string, body: string): Promise<void> => {
    await mkdir(join(pluginDir, 'releaseNotes'), { recursive: true });
    await writeFile(join(pluginDir, 'releaseNotes', fileName), body, 'utf-8');
  };

  const readBundle = async (): Promise<BundleEntry[]> => {
    const raw = await readFile(join(outputDir, 'bundle.json'), 'utf-8');

    return JSON.parse(raw) as BundleEntry[];
  };

  const readManifest = async (): Promise<Record<string, unknown>> => {
    const raw = await readFile(join(pluginDir, 'kizen.json'), 'utf-8');

    return JSON.parse(raw) as Record<string, unknown>;
  };

  const bundleFileSize = async (): Promise<number> => {
    const stats = await stat(join(outputDir, 'bundle.json'));

    return stats.size;
  };

  const buildAndExpectRejection = async (): Promise<unknown> => {
    return runBuild(pluginDir, outputDir).then(
      () => null,
      (error: unknown) => error,
    );
  };

  describe('bootstrap path', () => {
    it('turns a freshly created plugin into a parseable bundle.json', async () => {
      await bootstrapPlugin();

      const result = await runBuild(pluginDir, outputDir);
      const bundle = await readBundle();

      expect(bundle).toHaveLength(1);
      expect(result.bundleSize).toBeGreaterThan(0);
    });

    it('carries the expected manifest keys through to the bundle entry', async () => {
      await bootstrapPlugin();
      await runBuild(pluginDir, outputDir);

      const [entry] = await readBundle();

      expect(entry).toBeDefined();
      expect(Object.keys(entry ?? {})).toEqual(expect.arrayContaining(EXPECTED_BUNDLE_KEYS));
    });

    it('preserves the wizard-supplied identity fields verbatim', async () => {
      await bootstrapPlugin();
      await runBuild(pluginDir, outputDir);

      const [entry] = await readBundle();

      expect(entry).toMatchObject({
        api_name: PLUGIN_API_NAME,
        name: PLUGIN_NAME,
        description: PLUGIN_DESCRIPTION,
        developer_business_id: { go: DEVELOPER_BUSINESS_ID },
        external_link: PLUGIN_EXTERNAL_LINK,
        version: '1.0.0',
        entry: 'src/',
        engine: '1.0.0',
        release_notes_directory: 'releaseNotes/',
      });
    });

    it('scaffolds a plugin with no validation errors and no warnings', async () => {
      await bootstrapPlugin();

      const issues = validatePluginApp(await readLocalFiles(pluginDir));

      expect(issues).toEqual([]);
    });

    it('stays validation-clean when no business id is configured', async () => {
      await createPlugin({
        targetDir: pluginDir,
        name: PLUGIN_NAME,
        apiName: PLUGIN_API_NAME,
        externalLink: PLUGIN_EXTERNAL_LINK,
        description: PLUGIN_DESCRIPTION,
        developerBusinessId: '',
        developerEnvironment: 'go',
      });

      const issues = validatePluginApp(await readLocalFiles(pluginDir));

      expect(issues).toEqual([]);
    });

    it('builds a full artifact scaffold with no errors and no warnings', async () => {
      await createPlugin({
        targetDir: pluginDir,
        name: PLUGIN_NAME,
        apiName: PLUGIN_API_NAME,
        externalLink: PLUGIN_EXTERNAL_LINK,
        description: PLUGIN_DESCRIPTION,
        developerBusinessId: DEVELOPER_BUSINESS_ID,
        developerEnvironment: 'go',
        artifacts: ARTIFACT_TYPES,
      });

      const issues = validatePluginApp(await readLocalFiles(pluginDir));

      expect(issues).toEqual([]);

      await expect(runBuild(pluginDir, outputDir)).resolves.toBeDefined();
    });

    it('emits every webapp-required artifact field, non-blank', async () => {
      const required: Record<string, readonly string[]> = {
        floating_frames: ['api_name', 'name', 'title', 'type'],
        custom_blocks: ['api_name', 'name'],
        data_adornments: ['field_type'],
        routable_pages: ['api_name', 'name', 'type'],
        toolbar_items: ['api_name', 'label', 'script'],
        object_settings_menu_items: ['api_name', 'label', 'script'],
        js_action_templates: ['api_name', 'name', 'hint_object_name'],
      };

      await createPlugin({
        targetDir: pluginDir,
        name: PLUGIN_NAME,
        apiName: PLUGIN_API_NAME,
        externalLink: PLUGIN_EXTERNAL_LINK,
        description: PLUGIN_DESCRIPTION,
        developerBusinessId: DEVELOPER_BUSINESS_ID,
        developerEnvironment: 'go',
        artifacts: ARTIFACT_TYPES,
      });

      await runBuild(pluginDir, outputDir);

      const [entry] = await readBundle();
      const artifacts = (entry as unknown as { artifacts: Record<string, unknown> }).artifacts;

      for (const [collection, fields] of Object.entries(required)) {
        const raw = artifacts[collection];
        const items = Array.isArray(raw) ? raw : Object.values(raw ?? {});

        expect(items, `${collection} should be scaffolded`).toHaveLength(1);

        for (const item of items as Record<string, unknown>[]) {
          for (const field of fields) {
            expect(item[field], `${collection}.${field}`).toBeTruthy();
          }
        }
      }
    });

    it('carries the scaffolded thumbnail into the bundle', async () => {
      await bootstrapPlugin();
      await runBuild(pluginDir, outputDir);

      const [entry] = await readBundle();

      expect(entry?.thumbnail).not.toBeNull();
    });

    it('carries stylesheets and event scripts into the bundle', async () => {
      await createPlugin({
        targetDir: pluginDir,
        name: PLUGIN_NAME,
        apiName: PLUGIN_API_NAME,
        externalLink: PLUGIN_EXTERNAL_LINK,
        description: PLUGIN_DESCRIPTION,
        developerBusinessId: DEVELOPER_BUSINESS_ID,
        developerEnvironment: 'go',
        artifacts: ARTIFACT_TYPES,
      });

      await runBuild(pluginDir, outputDir);

      const [entry] = await readBundle();
      const artifacts = (entry as unknown as { artifacts: Record<string, unknown> }).artifacts;

      const only = (collection: string): Record<string, unknown> => {
        const raw = artifacts[collection];
        const items = Array.isArray(raw) ? raw : Object.values(raw ?? {});

        return items[0] as Record<string, unknown>;
      };

      expect(only('floating_frames').css).toBeTruthy();
      expect(only('custom_blocks').styles).toBeTruthy();

      const page = only('routable_pages');

      expect(page.css).toBeTruthy();

      expect(Object.keys(page.event_scripts as Record<string, string>)).toEqual(['greet']);
      expect((page.event_scripts as Record<string, string>).greet).toBeTruthy();
    });

    it('emits empty artifact collections for a scaffold with no components', async () => {
      await bootstrapPlugin();
      await runBuild(pluginDir, outputDir);

      const [entry] = await readBundle();

      expect(entry?.kznFile).toBeNull();

      for (const [collection, items] of Object.entries(entry?.artifacts ?? {})) {
        expect(items, `artifacts.${collection}`).toEqual([]);
      }
    });
  });

  describe('invalid manifest', () => {
    it('rejects with a validation error naming the missing api_name', async () => {
      await bootstrapPlugin();

      const manifest = await readManifest();

      delete manifest.api_name;
      await writeFile(
        join(pluginDir, 'kizen.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        'utf-8',
      );

      const thrown = await buildAndExpectRejection();

      expect(thrown).toBeInstanceOf(PluginValidationError);

      const { issues } = thrown as PluginValidationError;
      const apiNameIssue = issues.find((issue) => issue.message.includes('api_name'));

      expect(apiNameIssue).toBeDefined();
      expect(apiNameIssue?.severity).toBe('error');
      expect(apiNameIssue?.rule).toBe('manifest/required-field');
      expect(apiNameIssue?.message).toContain('api_name is required');
    });

    it('writes no bundle.json when validation fails', async () => {
      await bootstrapPlugin();

      const manifest = await readManifest();

      delete manifest.api_name;
      await writeFile(
        join(pluginDir, 'kizen.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        'utf-8',
      );

      await buildAndExpectRejection();

      await expect(stat(join(outputDir, 'bundle.json'))).rejects.toThrow();
    });
  });

  describe('release notes collection', () => {
    it('orders notes by descending version, comparing version segments numerically', async () => {
      await bootstrapPlugin();

      for (const version of ['0.9.0', '1.0.0', '1.0.9', '1.0.10', '2.0.0']) {
        await writeReleaseNote(`${version}.md`, `# ${version}\n\nNotes for ${version}.\n`);
      }

      await runBuild(pluginDir, outputDir);

      const [entry] = await readBundle();

      // A plain lexicographic sort would put 1.0.9 ahead of 1.0.10.
      expect(entry?.allReleaseNotes.map((note) => note.version)).toEqual([
        '2.0.0',
        '1.0.10',
        '1.0.9',
        '1.0.0',
        '0.9.0',
      ]);
      expect(entry?.allReleaseNotes[0]?.notes).toBe('# 2.0.0\n\nNotes for 2.0.0.\n');
    });

    it('collects only markdown files from the release notes directory', async () => {
      await bootstrapPlugin();
      await writeReleaseNote('1.0.0.md', '# 1.0.0\n');
      await writeReleaseNote('NOTES.txt', 'not a release note');
      await writeFile(join(pluginDir, 'src', 'stray.md'), '# not a release note\n', 'utf-8');

      await runBuild(pluginDir, outputDir);

      const [entry] = await readBundle();

      expect(entry?.allReleaseNotes.map((note) => note.version)).toEqual(['1.0.0']);
    });
  });

  describe('reported bundle size', () => {
    it('excludes allReleaseNotes content while bundle.json still carries it', async () => {
      await bootstrapPlugin();

      // 1.0.0 matches the manifest version, so the packager ships it as the
      // entry's own `releaseNotes` field. 0.9.0 is historical changelog and
      // reaches the bundle only through `allReleaseNotes`, which is what the
      // size accounting is supposed to leave out — so vary that one.
      await writeReleaseNote('1.0.0.md', '# 1.0.0\n');
      await writeReleaseNote('0.9.0.md', '# 0.9.0\n');

      const small = await runBuild(pluginDir, outputDir);
      const smallFileSize = await bundleFileSize();

      const longChangelog = `# 0.9.0\n\n${'x'.repeat(50_000)}\n`;

      await writeReleaseNote('0.9.0.md', longChangelog);

      const large = await runBuild(pluginDir, outputDir);
      const largeFileSize = await bundleFileSize();

      // The changelog really did land in the written bundle...
      expect(largeFileSize).toBeGreaterThan(smallFileSize + 45_000);

      // ...but it is not counted in the size reported to the user.
      expect(large.bundleSize).toBe(small.bundleSize);
    });

    it('reports a size smaller than the written bundle when release notes are present', async () => {
      await bootstrapPlugin();
      await writeReleaseNote('0.9.0.md', `# 0.9.0\n\n${'x'.repeat(20_000)}\n`);

      const result = await runBuild(pluginDir, outputDir);

      expect(result.bundleSize).toBeLessThan((await bundleFileSize()) - 20_000);
    });
  });
});
