import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBundleApiNames, resolveRestorableLastPath, restorablePath } from './lastPath.js';

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'appbuilder-last-path-'));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

// Written compact on purpose: saveConfig pretty-prints, so any rewrite of the
// file changes its bytes even when the parsed content is identical.
async function writeRawConfig(config: Record<string, unknown>): Promise<string> {
  const raw = JSON.stringify(config);

  await writeFile(join(outputDir, 'config.json'), raw, 'utf-8');

  return raw;
}

async function readRawConfig(): Promise<string> {
  return readFile(join(outputDir, 'config.json'), 'utf-8');
}

async function writeBundle(apiNames: string[]): Promise<void> {
  await writeFile(
    join(outputDir, 'bundle.json'),
    JSON.stringify(apiNames.map((api_name) => ({ api_name }))),
    'utf-8',
  );
}

describe('readBundleApiNames', () => {
  it('reads the api names from bundle.json in the output dir', async () => {
    await writeBundle(['demo_app', 'other_app']);

    await expect(readBundleApiNames(outputDir)).resolves.toEqual(['demo_app', 'other_app']);
  });

  it('returns no apps when bundle.json is missing', async () => {
    await expect(readBundleApiNames(outputDir)).resolves.toEqual([]);
  });

  it('returns no apps when bundle.json is unparseable', async () => {
    await writeFile(join(outputDir, 'bundle.json'), '[{"api_name": "demo', 'utf-8');

    await expect(readBundleApiNames(outputDir)).resolves.toEqual([]);
  });
});

describe('restorablePath', () => {
  it('reflects bundle.json as it is now, not as it was on an earlier call', async () => {
    await writeBundle(['demo_app', 'other_app']);

    await expect(restorablePath(outputDir, '/demo_app/sandbox')).resolves.toBe('/demo_app/sandbox');

    // Same outputDir, same path; only the bundle's membership changed.
    await writeBundle(['other_app']);

    await expect(restorablePath(outputDir, '/demo_app/sandbox')).resolves.toBeUndefined();
  });

  it('returns undefined for an undefined path', async () => {
    await writeBundle(['demo_app']);

    await expect(restorablePath(outputDir, undefined)).resolves.toBeUndefined();
  });

  it('does not write config.json', async () => {
    await writeBundle(['other_app']);

    await expect(restorablePath(outputDir, '/demo_app/sandbox')).resolves.toBeUndefined();
    await expect(readRawConfig()).rejects.toThrow();
  });
});

describe('resolveRestorableLastPath', () => {
  it('returns a lastPath on a bundle app unchanged and leaves config.json untouched', async () => {
    await writeBundle(['demo_app']);
    const raw = await writeRawConfig({ credentialMode: 'global', lastPath: '/demo_app/sandbox' });

    await expect(resolveRestorableLastPath(outputDir)).resolves.toBe('/demo_app/sandbox');
    expect(await readRawConfig()).toBe(raw);
  });

  it('drops a lastPath on an unknown app and removes it from config.json, keeping other keys', async () => {
    await writeBundle(['demo_app']);
    await writeRawConfig({
      credentialMode: 'global',
      activeCredentialProfile: 'staging',
      encryptionTarget: 'dev',
      lastPath: '/embed/sandbox',
    });

    await expect(resolveRestorableLastPath(outputDir)).resolves.toBeUndefined();
    expect(JSON.parse(await readRawConfig())).toEqual({
      credentialMode: 'global',
      activeCredentialProfile: 'staging',
      encryptionTarget: 'dev',
    });
  });

  it('drops and heals a lastPath that normalizes onto an unknown app', async () => {
    await writeBundle(['demo_app']);
    await writeRawConfig({
      credentialMode: 'global',
      encryptionTarget: 'dev',
      lastPath: '/demo_app/../embed/sandbox',
    });

    await expect(resolveRestorableLastPath(outputDir)).resolves.toBeUndefined();
    expect(JSON.parse(await readRawConfig())).toEqual({
      credentialMode: 'global',
      encryptionTarget: 'dev',
    });
  });

  it('drops and heals a lastPath when bundle.json is missing', async () => {
    await writeRawConfig({ credentialMode: 'local', lastPath: '/demo_app/sandbox' });

    await expect(resolveRestorableLastPath(outputDir)).resolves.toBeUndefined();
    expect(JSON.parse(await readRawConfig())).toEqual({ credentialMode: 'local' });
  });

  it('drops and heals a lastPath that is not an app route', async () => {
    await writeBundle(['demo_app']);
    await writeRawConfig({ credentialMode: 'local', lastPath: '/demo_app' });

    await expect(resolveRestorableLastPath(outputDir)).resolves.toBeUndefined();
    expect(JSON.parse(await readRawConfig())).toEqual({ credentialMode: 'local' });
  });

  it('returns undefined and leaves config.json untouched when there is no lastPath', async () => {
    await writeBundle(['demo_app']);
    const raw = await writeRawConfig({ credentialMode: 'global', encryptionTarget: 'prod' });

    await expect(resolveRestorableLastPath(outputDir)).resolves.toBeUndefined();
    expect(await readRawConfig()).toBe(raw);
  });

  it.skipIf(process.getuid?.() === 0)(
    'still drops an unknown-app lastPath when config.json is not writable',
    async () => {
      await writeBundle(['demo_app']);
      const raw = await writeRawConfig({ credentialMode: 'global', lastPath: '/embed/sandbox' });

      await chmod(join(outputDir, 'config.json'), 0o444);

      await expect(resolveRestorableLastPath(outputDir)).resolves.toBeUndefined();
      // The heal is best-effort: the read-only file is left as it was.
      expect(await readRawConfig()).toBe(raw);
    },
  );

  it('does not create config.json when none exists', async () => {
    await expect(resolveRestorableLastPath(outputDir)).resolves.toBeUndefined();
    await expect(readRawConfig()).rejects.toThrow();
  });
});
