/**
 * Non-interactive `appbuilder create` (KZN-17594, AC 2.2 / 3.1).
 *
 * Mirrors the `encrypt` command's split: all decision logic lives here as pure,
 * dependency-injected functions so it can be tested without Ink or a TTY, and
 * `src/commands/create.ts` only wires real I/O into it.
 */
import { ARTIFACT_TYPES } from './createArtifacts.js';
import type { ArtifactType } from './createArtifacts.js';
import { inferApiName } from './createForm.js';
import type { CreatePluginInput, PrecheckResult } from './createPlugin.js';
import type { Environment } from '../../shared/lib/credentials.js';

/**
 * Placeholder used when a non-interactive run supplies no description. The
 * manifest schema rejects an empty description, and a headless caller has no
 * way to be prompted for one.
 */
export const PLACEHOLDER_DESCRIPTION = 'A hello-world Kizen plugin.';

/** Same rule the packager enforces as `manifest/api-name-format`. */
const API_NAME_PATTERN = /^[a-z_][a-z0-9_]+$/;

const API_NAME_HINT =
  'must start with a letter or underscore and contain only lowercase letters, numbers, or underscores (minimum 2 characters)';

export interface CreateOptions {
  name?: string;
  apiName?: string;
  description?: string;
  externalLink?: string;
  businessId?: string;
  artifacts?: string;
}

export interface HeadlessDefaults {
  businessId: string;
  environment: Environment;
}

/**
 * Resolves `--artifacts`. Omitted means "one of each type", which is what makes
 * a headless run produce a deployable shell rather than an empty `src/`.
 */
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

/**
 * Builds the createPlugin input from flags, filling in the defaults a prompt
 * would otherwise collect. Throws with an actionable message when a value the
 * scaffold genuinely cannot invent is missing.
 */
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

  return {
    targetDir,
    name,
    apiName,
    externalLink: options.externalLink?.trim() ?? '',
    description:
      description === undefined || description === '' ? PLACEHOLDER_DESCRIPTION : description,
    developerBusinessId: options.businessId?.trim() ?? defaults.businessId,
    developerEnvironment: defaults.environment,
    artifacts: parseArtifactSelection(options.artifacts),
  };
}

export interface HeadlessDeps {
  precheckTargetDir: (dir: string) => Promise<PrecheckResult>;
  createPlugin: (input: CreatePluginInput) => Promise<void>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

/**
 * Runs a full non-interactive scaffold. Returns without throwing on expected
 * failures (bad flags, occupied directory); the exit code carries the result.
 */
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
    // Real I/O failures (permission denied, disk full, the directory vanishing
    // between the precheck and the write) get the same clean treatment as bad
    // flags, rather than escaping as an unhandled rejection with a stack trace
    // and no exit code of our own.
    deps.writeStderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);

    deps.setExitCode(1);

    return;
  }

  const artifactSummary =
    input.artifacts && input.artifacts.length > 0 ? input.artifacts.join(', ') : 'none';

  deps.writeStdout(`Created plugin ${input.apiName} at ${targetDir}\n`);

  deps.writeStdout(`Artifacts: ${artifactSummary}\n`);

  // Generated so the shell can publish at all; nobody has chosen artwork yet.
  deps.writeStdout(
    'Thumbnail: src/thumbnail.png (generated placeholder; replace it before publishing)\n',
  );

  if (input.developerBusinessId.trim() === '') {
    // Not fatal: a business id is only required to preview-publish, and it's a
    // real per-developer value the scaffold can't fabricate.
    deps.writeStderr(
      'Warning: no developer_business_id configured, so this plugin cannot be preview-published yet.\n',
    );
  }
}
