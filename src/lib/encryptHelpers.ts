import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type EncryptStage = 'dev' | 'prod';

export function envelopeObject(value: string): { encrypted: true; value: string } {
  return { encrypted: true, value };
}

export function compactEnvelope(value: string): string {
  return JSON.stringify(envelopeObject(value));
}

export async function writeEnvelopeFile(path: string, value: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(envelopeObject(value), null, 2)}\n`, 'utf-8');
}

export interface ManifestDefaults {
  apiName?: string;
}

export const DEFAULT_STAGE: EncryptStage = 'prod';

export function isValidStage(stage: string): stage is EncryptStage {
  return stage === 'dev' || stage === 'prod';
}

export function invalidStageMessage(stage: string): string {
  return `Error: --stage must be "dev" or "prod" (got: "${stage}")`;
}

export function resolveStage(stage: string | undefined): {
  stage: EncryptStage;
  wasDefaulted: boolean;
} {
  return {
    stage: stage === 'dev' || stage === 'prod' ? stage : DEFAULT_STAGE,
    wasDefaulted: stage === undefined,
  };
}

export function defaultStageNotice(stage: EncryptStage): string {
  return `No --stage given; defaulting to ${stage} encryption keys (pass --stage dev to override)\n`;
}

export async function readManifestDefaults(cwd: string = process.cwd()): Promise<ManifestDefaults> {
  try {
    const raw = await readFile(join(cwd, 'kizen.json'), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const manifest = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;

    const apiName =
      typeof manifest.api_name === 'string' && manifest.api_name !== ''
        ? manifest.api_name
        : undefined;

    return {
      ...(apiName !== undefined && { apiName }),
    };
  } catch {
    // Not in a plugin directory — fine, the UI will prompt with no defaults.
  }

  return {};
}

export function stripTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf-8');
}
