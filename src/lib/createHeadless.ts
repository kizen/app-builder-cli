import { ARTIFACT_TYPES } from './createArtifacts.js';
import type { ArtifactType } from './createArtifacts.js';
import { API_NAME_HINT, API_NAME_PATTERN, inferApiName } from './createForm.js';
import type { CreatePluginInput, PrecheckResult } from './createPlugin.js';
import { ENVIRONMENTS } from '../../shared/lib/credentials.js';
import type { Environment } from '../../shared/lib/credentials.js';

export const PLACEHOLDER_DESCRIPTION = 'A hello-world Kizen plugin.';

export interface CreateOptions {
  name?: string;
  apiName?: string;
  description?: string;
  externalLink?: string;
  businessId?: string;
  environment?: string;
  artifacts?: string;
}

export interface HeadlessDefaults {
  businessId: string;
  environment: Environment;
}

export function parseArtifactSelection(raw: string | undefined): ArtifactType[] {
  if (raw === undefined || raw.trim() === '' || raw.trim() === 'all') {
    return [...ARTIFACT_TYPES];
  }

  if (raw.trim() === 'none') {
    return [];
  }

  const requested = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  const unknown = requested.filter((part) => !ARTIFACT_TYPES.includes(part as ArtifactType));

  if (unknown.length > 0) {
    throw new Error(
      `Unknown artifact type(s): ${unknown.join(', ')}. Valid types: ${ARTIFACT_TYPES.join(', ')}, or "all" / "none".`,
    );
  }

  return [...new Set(requested as ArtifactType[])];
}

export function resolveHeadlessInput(
  options: CreateOptions,
  defaults: HeadlessDefaults,
  targetDir: string,
): CreatePluginInput {
  const name = options.name?.trim() ?? '';

  if (name === '') {
    throw new Error('--name is required for a non-interactive run.');
  }

  const apiName = (options.apiName?.trim() ?? '') || inferApiName(name);

  if (!API_NAME_PATTERN.test(apiName)) {
    throw new Error(`api_name "${apiName}" is invalid: ${API_NAME_HINT}. Pass --api-name.`);
  }

  const description = options.description?.trim();

  const developerBusinessId = options.businessId?.trim() ?? defaults.businessId;
  const developerEnvironment = resolveEnvironment(options, defaults);

  return {
    targetDir,
    name,
    apiName,
    externalLink: options.externalLink?.trim() ?? '',
    description:
      description === undefined || description === '' ? PLACEHOLDER_DESCRIPTION : description,
    developerBusinessId,
    developerEnvironment,
    artifacts: parseArtifactSelection(options.artifacts),
  };
}

function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

function resolveEnvironment(options: CreateOptions, defaults: HeadlessDefaults): Environment {
  const requested = options.environment?.trim();

  if (requested !== undefined && requested !== '') {
    if (!isEnvironment(requested)) {
      throw new Error(
        `Unknown environment "${requested}". Valid environments: ${ENVIRONMENTS.join(', ')}.`,
      );
    }

    return requested;
  }

  if (options.businessId !== undefined && defaults.businessId === '') {
    throw new Error(
      '--environment is required alongside --business-id when no credentials are saved, so the id is keyed to the environment that issued it.',
    );
  }

  return defaults.environment;
}

export interface HeadlessDeps {
  precheckTargetDir: (dir: string) => Promise<PrecheckResult>;
  createPlugin: (input: CreatePluginInput) => Promise<void>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

export async function runHeadlessCreate(
  options: CreateOptions,
  defaults: HeadlessDefaults,
  targetDir: string,
  deps: HeadlessDeps,
): Promise<void> {
  let input: CreatePluginInput;

  try {
    input = resolveHeadlessInput(options, defaults, targetDir);
  } catch (err) {
    deps.writeStderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);

    deps.setExitCode(1);

    return;
  }

  const precheck = await deps.precheckTargetDir(targetDir);

  if (precheck !== 'ok') {
    const conflict = precheck === 'has-manifest' ? 'kizen.json' : '.kizenapp/';

    deps.writeStderr(
      `Error: ${targetDir} already contains ${conflict}. Refusing to overwrite an existing plugin.\n`,
    );

    deps.setExitCode(1);

    return;
  }

  try {
    await deps.createPlugin(input);
  } catch (err) {
    deps.writeStderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);

    deps.setExitCode(1);

    return;
  }

  const artifactSummary =
    input.artifacts && input.artifacts.length > 0 ? input.artifacts.join(', ') : 'none';

  deps.writeStdout(`Created plugin ${input.apiName} at ${targetDir}\n`);

  deps.writeStdout(`Artifacts: ${artifactSummary}\n`);

  deps.writeStdout(
    'Thumbnail: src/thumbnail.png (generated placeholder; replace it before publishing)\n',
  );

  if (input.developerBusinessId.trim() === '') {
    deps.writeStderr(
      'Warning: no developer_business_id configured, so this plugin cannot be preview-published yet.\n',
    );
  }
}
