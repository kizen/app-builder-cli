import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from './config.js';
import type { AppBuilderConfig } from './config.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'appbuilder-config-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRawConfig(contents: string): Promise<void> {
  await writeFile(join(root, 'config.json'), contents, 'utf-8');
}

describe('loadConfig', () => {
  it('returns an empty config when the file does not exist', async () => {
    await expect(loadConfig(join(root, 'missing'))).resolves.toEqual({});
  });

  it('returns an empty config when the directory does not exist', async () => {
    await expect(loadConfig(join(root, 'a', 'b', 'c'))).resolves.toEqual({});
  });

  it('falls back to an empty config on corrupt JSON', async () => {
    await writeRawConfig('{ not json');

    await expect(loadConfig(root)).resolves.toEqual({});
  });

  it('falls back to an empty config on a truncated file', async () => {
    await writeRawConfig('{"credentialMode": "glo');

    await expect(loadConfig(root)).resolves.toEqual({});
  });

  it('falls back to an empty config on an empty file', async () => {
    await writeRawConfig('');

    await expect(loadConfig(root)).resolves.toEqual({});
  });

  it('reads a populated config back', async () => {
    const config: AppBuilderConfig = {
      credentialMode: 'local',
      activeCredentialProfile: 'work',
      lastPath: '/tmp/some-plugin',
      encryptionTarget: 'dev',
    };

    await writeRawConfig(JSON.stringify(config));

    await expect(loadConfig(root)).resolves.toEqual(config);
  });

  it('reads a partial config without inventing defaults', async () => {
    await writeRawConfig('{"lastPath":"/tmp/p"}');

    await expect(loadConfig(root)).resolves.toEqual({ lastPath: '/tmp/p' });
  });
});

describe('saveConfig', () => {
  it('round-trips through loadConfig', async () => {
    const config: AppBuilderConfig = { credentialMode: 'global', encryptionTarget: 'prod' };

    await saveConfig(root, config);

    await expect(loadConfig(root)).resolves.toEqual(config);
  });

  it('creates the output directory when it is missing', async () => {
    const nested = join(root, 'deep', 'nested');

    await saveConfig(nested, { lastPath: '/tmp/x' });

    await expect(loadConfig(nested)).resolves.toEqual({ lastPath: '/tmp/x' });
  });

  it('writes human-readable, two-space-indented JSON', async () => {
    await saveConfig(root, { lastPath: '/tmp/x' });

    expect(await readFile(join(root, 'config.json'), 'utf-8')).toBe('{\n  "lastPath": "/tmp/x"\n}');
  });

  it('replaces a previously saved config rather than merging', async () => {
    await saveConfig(root, { credentialMode: 'local', lastPath: '/tmp/old' });
    await saveConfig(root, { credentialMode: 'global' });

    await expect(loadConfig(root)).resolves.toEqual({ credentialMode: 'global' });
  });

  it('repairs a corrupt config file on the next save', async () => {
    await writeRawConfig('}{');

    await expect(loadConfig(root)).resolves.toEqual({});

    await saveConfig(root, { encryptionTarget: 'dev' });

    await expect(loadConfig(root)).resolves.toEqual({ encryptionTarget: 'dev' });
  });
});
