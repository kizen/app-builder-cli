import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AppBuilderConfig {
  credentialMode?: 'global' | 'local';
  activeCredentialProfile?: string;
  lastPath?: string;
  // Which encryption API the Secrets page fetches public keys from.
  // 'auto' derives dev/prod from the plugin's release_environments (KZN-16467).
  encryptionTarget?: 'auto' | 'dev' | 'prod';
}

export async function loadConfig(outputDir: string): Promise<AppBuilderConfig> {
  try {
    const content = await readFile(join(outputDir, 'config.json'), 'utf-8');

    return JSON.parse(content) as AppBuilderConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(outputDir: string, config: AppBuilderConfig): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  await writeFile(join(outputDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}
