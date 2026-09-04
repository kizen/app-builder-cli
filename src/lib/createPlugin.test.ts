import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildManifest,
  createPlugin,
  findAvailableSubDir,
  precheckTargetDir,
} from './createPlugin.js';
import type { CreatePluginInput } from './createPlugin.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'appbuilder-create-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function validInput(overrides: Partial<CreatePluginInput> = {}): CreatePluginInput {
  return {
    targetDir: join(root, 'my_plugin'),
    name: 'My Plugin',
    apiName: 'my_plugin',
    externalLink: 'https://example.com/my-plugin',
    description: 'Does a useful thing.',
    developerBusinessId: '11111111-2222-3333-4444-555555555555',
    developerEnvironment: 'go',
    ...overrides,
  };
}

describe('buildManifest', () => {
  it('produces the full kizen.json shape from populated input', () => {
    expect(buildManifest(validInput())).toEqual({
      name: 'My Plugin',
      version: '1.0.0',
      published: true,
      api_name: 'my_plugin',
      external_link: 'https://example.com/my-plugin',
      description: 'Does a useful thing.',
      entry: 'src/',
      engine: '1.0.0',
      release_notes_directory: 'releaseNotes/',
      release_environments: ['prod'],
      config_template: {},
      base_config: {},
      developer_business_id: { go: '11111111-2222-3333-4444-555555555555' },
    });
  });

  it('maps camelCase input onto snake_case manifest keys', () => {
    const manifest = buildManifest(
      validInput({
        apiName: 'other_api_name',
        externalLink: 'https://example.com/other',
        developerBusinessId: 'biz-9',
      }),
    );

    expect(manifest.api_name).toBe('other_api_name');
    expect(manifest.external_link).toBe('https://example.com/other');
    expect(manifest.developer_business_id).toEqual({ go: 'biz-9' });
  });

  it('omits developer_business_id entirely when no id is configured', () => {
    expect(buildManifest(validInput({ developerBusinessId: '' }))).not.toHaveProperty(
      'developer_business_id',
    );
  });

  it('omits developer_business_id when the configured id is only whitespace', () => {
    expect(buildManifest(validInput({ developerBusinessId: '   ' }))).not.toHaveProperty(
      'developer_business_id',
    );
  });

  it.each(['go', 'fmo', 'staging', 'integration', 'test1'] as const)(
    'keys the business id by the %s environment',
    (environment) => {
      const manifest = buildManifest(
        validInput({ developerBusinessId: 'biz-1', developerEnvironment: environment }),
      );

      expect(manifest.developer_business_id).toEqual({ [environment]: 'biz-1' });
    },
  );

  it('never emits a bare-string developer_business_id', () => {
    const manifest = buildManifest(validInput());

    expect(typeof manifest.developer_business_id).not.toBe('string');
  });

  it.each(['integration', 'staging', 'test1'] as const)(
    'targets %s when the business id was issued there',
    (environment) => {
      const manifest = buildManifest(
        validInput({ developerBusinessId: 'biz-1', developerEnvironment: environment }),
      );

      expect(manifest.release_environments).toEqual([environment]);
      expect(manifest.developer_business_id).toEqual({ [environment]: 'biz-1' });
    },
  );

  it.each(['go', 'fmo'] as const)('keeps the prod default for a %s business id', (environment) => {
    const manifest = buildManifest(
      validInput({ developerBusinessId: 'biz-1', developerEnvironment: environment }),
    );

    expect(manifest.release_environments).toEqual(['prod']);
  });

  it('keeps the prod default when there is no business id to target', () => {
    const manifest = buildManifest(
      validInput({ developerBusinessId: '', developerEnvironment: 'integration' }),
    );

    expect(manifest.release_environments).toEqual(['prod']);
    expect(manifest).not.toHaveProperty('developer_business_id');
  });

  it('never leaks targetDir into the manifest', () => {
    expect(buildManifest(validInput())).not.toHaveProperty('targetDir');
  });

  it('serializes to valid JSON', () => {
    const manifest = buildManifest(validInput());

    expect(JSON.parse(JSON.stringify(manifest)) as unknown).toEqual(manifest);
  });

  it('returns a fresh object graph each call', () => {
    const a = buildManifest(validInput());
    const b = buildManifest(validInput());

    expect(a).not.toBe(b);
    expect(a.config_template).not.toBe(b.config_template);
  });
});

describe('precheckTargetDir', () => {
  it('returns "ok" for an empty directory', async () => {
    await expect(precheckTargetDir(root)).resolves.toBe('ok');
  });

  it('returns "ok" for a directory that does not exist', async () => {
    await expect(precheckTargetDir(join(root, 'nope'))).resolves.toBe('ok');
  });

  it('returns "ok" for unrelated files', async () => {
    await writeFile(join(root, 'README.md'), '# hi\n', 'utf-8');

    await expect(precheckTargetDir(root)).resolves.toBe('ok');
  });

  it('returns "has-manifest" when kizen.json exists', async () => {
    await writeFile(join(root, 'kizen.json'), '{}', 'utf-8');

    await expect(precheckTargetDir(root)).resolves.toBe('has-manifest');
  });

  it('returns "has-kizenapp" when only .kizenapp exists', async () => {
    await mkdir(join(root, '.kizenapp'));

    await expect(precheckTargetDir(root)).resolves.toBe('has-kizenapp');
  });

  it('reports the manifest first when both conflicts are present', async () => {
    await writeFile(join(root, 'kizen.json'), '{}', 'utf-8');
    await mkdir(join(root, '.kizenapp'));

    await expect(precheckTargetDir(root)).resolves.toBe('has-manifest');
  });
});

describe('findAvailableSubDir', () => {
  it('returns the base name when nothing collides', async () => {
    await expect(findAvailableSubDir(root, 'my_plugin')).resolves.toBe(join(root, 'my_plugin'));
  });

  it('appends -1 on the first collision', async () => {
    await mkdir(join(root, 'my_plugin'));

    await expect(findAvailableSubDir(root, 'my_plugin')).resolves.toBe(join(root, 'my_plugin-1'));
  });

  it('counts up past consecutive collisions', async () => {
    await mkdir(join(root, 'my_plugin'));
    await mkdir(join(root, 'my_plugin-1'));
    await mkdir(join(root, 'my_plugin-2'));

    await expect(findAvailableSubDir(root, 'my_plugin')).resolves.toBe(join(root, 'my_plugin-3'));
  });

  it('fills the first gap in the numbering', async () => {
    await mkdir(join(root, 'my_plugin'));
    await mkdir(join(root, 'my_plugin-2'));

    await expect(findAvailableSubDir(root, 'my_plugin')).resolves.toBe(join(root, 'my_plugin-1'));
  });

  it('collides on files as well as directories', async () => {
    await writeFile(join(root, 'my_plugin'), 'not a directory', 'utf-8');

    await expect(findAvailableSubDir(root, 'my_plugin')).resolves.toBe(join(root, 'my_plugin-1'));
  });

  it('returns an absolute path under the parent directory', async () => {
    const result = await findAvailableSubDir(root, 'my_plugin');

    expect(result.startsWith(root)).toBe(true);
    expect(basename(result)).toBe('my_plugin');
  });
});

describe('createPlugin', () => {
  it('scaffolds the manifest, directories and gitignore entry', async () => {
    const input = validInput();

    await createPlugin(input);

    const manifest = JSON.parse(
      await readFile(join(input.targetDir, 'kizen.json'), 'utf-8'),
    ) as Record<string, unknown>;

    expect(manifest).toEqual(buildManifest(input));

    await expect(precheckTargetDir(input.targetDir)).resolves.toBe('has-manifest');

    for (const dir of ['src', 'releaseNotes']) {
      expect((await stat(join(input.targetDir, dir))).isDirectory()).toBe(true);
    }

    const gitignore = await readFile(join(input.targetDir, '.gitignore'), 'utf-8');

    expect(gitignore.split('\n').map((line) => line.trim())).toContain('.kizenapp/');
  });

  it('scaffolds the Copilot instruction files', async () => {
    const input = validInput();

    await createPlugin(input);

    for (const file of [
      '.github/copilot-instructions.md',
      '.github/instructions/security.instructions.md',
      '.github/instructions/version-discipline.instructions.md',
    ]) {
      const content = await readFile(join(input.targetDir, ...file.split('/')), 'utf-8');

      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('scaffolds a thumbnail inside the entry directory, as a real PNG', async () => {
    const input = validInput();

    await createPlugin(input);

    const bytes = await readFile(join(input.targetDir, 'src', 'thumbnail.png'));

    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('writes the manifest with a trailing newline', async () => {
    const input = validInput();

    await createPlugin(input);

    expect(await readFile(join(input.targetDir, 'kizen.json'), 'utf-8')).toMatch(/\n$/);
  });

  it('creates intermediate parent directories', async () => {
    const input = validInput({ targetDir: join(root, 'a', 'b', 'my_plugin') });

    await createPlugin(input);

    await expect(precheckTargetDir(input.targetDir)).resolves.toBe('has-manifest');
  });
});
