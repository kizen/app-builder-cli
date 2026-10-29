import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployablePlugin } from '@kizenapps/packager';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toPublishBody } from './businessAppPayload.js';
import { BusinessAppError } from './businessApps.js';
import { createPlugin } from './createPlugin.js';
import { packageLocalPlugin } from './runBuild.js';
import { rejectionOf } from '../test/oauth.js';

const OPTS = { release: false, sourcePackageId: 'src-zip-id', thumbnailId: 'thumb-id' };

const ALLOWED_KEYS = [
  'name',
  'api_name',
  'engine',
  'description',
  'agentic_description',
  'external_link',
  'config_template',
  'services',
  'base_config',
  'artifacts',
  'catalogs',
  'release_notes',
  'release',
  'source_filesystem_package',
  'thumbnail',
];

const ARTIFACT_KEYS = [
  'data_adornments',
  'floating_frames',
  'custom_blocks',
  'routable_pages',
  'toolbar_items',
  'object_settings_menu_items',
  'calendar_sources',
  'js_action_templates',
  'route_script_templates',
  'automation_action_configs',
];

describe('toPublishBody on real packager output', () => {
  let workDir: string;
  let pluginDir: string;
  let deployable: DeployablePlugin;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'appbuilder-publish-body-'));
    pluginDir = join(workDir, 'plugin');

    await createPlugin({
      targetDir: pluginDir,
      name: 'Acme Widgets',
      apiName: 'acme_widgets',
      externalLink: 'https://example.com/acme',
      description: 'Adds Acme widgets.',
      developerBusinessId: '3f1b5c1e-9f0a-4c2b-8d6a-7e5f4c3b2a10',
      developerEnvironment: 'go',
      artifacts: ['jsAction', 'block'],
    });

    const manifestPath = join(pluginDir, 'kizen.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;

    manifest.setup_assistant = {
      fields: [{ key: 'region', type: 'text', label: 'Region' }],
      actions: ['hello_action'],
    };
    manifest.user_setup_assistant = { actions: ['hello_action'] };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const routeDir = join(pluginDir, 'src', 'routeScripts', 'helloRoute');

    await mkdir(routeDir, { recursive: true });
    await writeFile(
      join(routeDir, 'config.json'),
      JSON.stringify({
        name: 'Hello Route',
        api_name: 'hello_route',
        hint_object_name: 'client_client',
        routes: ['/records/*'],
      }),
    );
    await writeFile(join(routeDir, 'script.js'), 'console.log("route");\n');
    await mkdir(join(pluginDir, 'releaseNotes'), { recursive: true });
    await writeFile(join(pluginDir, 'releaseNotes', '1.0.0.md'), 'First release.\n');

    const packaged = await packageLocalPlugin(pluginDir);
    const [first] = packaged.deployable;

    if (!first) {
      throw new Error('packager produced no plugin');
    }

    deployable = first;
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('the fixture exercises the packager shapes the mapper exists for', () => {
    const assistant = deployable.base_config?.setup_assistant as { actions: unknown[] };

    expect(assistant.actions[0]).toMatchObject({ api_name: 'hello_action' });
    expect(deployable.artifacts.route_scripts).toHaveLength(1);
    expect(deployable.thumbnail).toBeInstanceOf(Uint8Array);
    expect(deployable.developer_business_id).toBeDefined();
    expect(deployable.version).toBe('1.0.0');
  });

  it('toPublishBody renames route_scripts to route_script_templates', () => {
    const body = toPublishBody(deployable, OPTS);

    expect(body.artifacts.route_script_templates).toStrictEqual(deployable.artifacts.route_scripts);
    expect(body.artifacts.route_script_templates[0]).toMatchObject({
      api_name: 'hello_route',
      routes: ['/records/*'],
    });
    expect(body.artifacts).not.toHaveProperty('route_scripts');
    expect(Object.keys(body.artifacts).sort()).toStrictEqual([...ARTIFACT_KEYS].sort());
  });

  it('sends setup-assistant actions exactly as the packager emits them (same as plugin-wizard)', () => {
    const body = toPublishBody(deployable, OPTS);

    expect(body.base_config.setup_assistant).toStrictEqual(deployable.base_config?.setup_assistant);
    expect(body.base_config.user_setup_assistant).toStrictEqual(
      deployable.base_config?.user_setup_assistant,
    );
    expect(body.base_config).toStrictEqual(deployable.base_config);
    const sentActions = (body.base_config.setup_assistant as { actions: unknown[] }).actions;
    const packagedActions = (deployable.base_config?.setup_assistant as { actions: unknown[] })
      .actions;

    expect(sentActions[0]).toMatchObject({ api_name: 'hello_action' });
    expect(sentActions).toStrictEqual(packagedActions);
  });

  it('passes object actions in user_setup_assistant through unchanged too', () => {
    const expanded = {
      ...deployable,
      base_config: {
        ...deployable.base_config,
        user_setup_assistant: { actions: [{ api_name: 'hello_action', script: 'x' }] },
      },
    };

    expect(toPublishBody(expanded, OPTS).base_config.user_setup_assistant).toStrictEqual({
      actions: [{ api_name: 'hello_action', script: 'x' }],
    });
  });

  it('toPublishBody drops developer_business_id, kznFile, thumbnail bytes, published, and version', () => {
    const body = toPublishBody(deployable, OPTS) as unknown as Record<string, unknown>;

    for (const key of [
      'developer_business_id',
      'kznFile',
      'published',
      'version',
      'entry',
      'release_notes_directory',
      'release_environments',
      'block_loading_for_setup',
      'setup_assistant',
      'user_setup_assistant',
      'releaseNotes',
    ]) {
      expect(body).not.toHaveProperty(key);
    }

    expect(body.thumbnail).toBe('thumb-id');
    expect(JSON.stringify(body)).not.toContain('"0":');
  });

  it('carries the pass-through fields, release notes, and the publish fields', () => {
    const body = toPublishBody(deployable, {
      release: true,
      sourcePackageId: 'zip-1',
      thumbnailId: 'img-1',
    });

    expect(body).toMatchObject({
      name: 'Acme Widgets',
      api_name: 'acme_widgets',
      engine: deployable.engine,
      description: 'Adds Acme widgets.',
      external_link: 'https://example.com/acme',
      services: deployable.services,
      release_notes: 'First release.\n',
      release: true,
      source_filesystem_package: 'zip-1',
      thumbnail: 'img-1',
    });
    expect(body.artifacts.js_action_templates).toStrictEqual(
      deployable.artifacts.js_action_templates,
    );
    expect(body.artifacts.custom_blocks).toStrictEqual(deployable.artifacts.custom_blocks);
  });

  it('toPublishBody only emits allow-listed keys', () => {
    const withExtras = {
      ...deployable,
      surprise_field: 'leak',
      github_repo: 'kizen/x',
      artifacts: { ...deployable.artifacts, surprise_artifacts: [{}] },
    } as unknown as DeployablePlugin;
    const body = toPublishBody(withExtras, OPTS);

    for (const key of Object.keys(body)) {
      expect(ALLOWED_KEYS).toContain(key);
    }

    expect(body).not.toHaveProperty('surprise_field');
    expect(body).not.toHaveProperty('github_repo');
    expect(Object.keys(body.artifacts).sort()).toStrictEqual([...ARTIFACT_KEYS].sort());
  });

  it('toPublishBody does not mutate its input', () => {
    const before = structuredClone(deployable);
    const body = toPublishBody(deployable, OPTS);

    expect(deployable).toStrictEqual(before);

    const [field] = (body.base_config.setup_assistant as { fields: { label: string }[] }).fields;

    expect(field).toBeDefined();

    if (field) {
      field.label = 'X';
    }

    (body.artifacts.route_script_templates[0] as { name: string }).name = 'X';
    expect(deployable).toStrictEqual(before);
  });

  it('release without a thumbnail is rejected before any request', async () => {
    const error = await rejectionOf(
      Promise.resolve().then(() =>
        toPublishBody(deployable, { ...OPTS, release: true, thumbnailId: null }),
      ),
      BusinessAppError,
    );

    expect(error.code).toBe('thumbnail_required');
    expect(toPublishBody(deployable, { ...OPTS, thumbnailId: null }).thumbnail).toBeNull();
  });
});
