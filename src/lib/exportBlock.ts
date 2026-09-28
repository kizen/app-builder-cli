import {
  BLOCKS_DIRECTORY_NAME,
  CONFIG_FILE_NAME,
  MANIFEST_FILE_NAME,
  sanitizeToAPIName,
} from '@kizenapps/packager';
import type { Block, DeployablePlugin, FileContent, ValidationIssue } from '@kizenapps/packager';
import { packageLocalPlugin } from './runBuild.js';

export type BlockSelectionFailure = 'not_found' | 'ambiguous' | 'no_blocks';

export type BlockExportReason = BlockSelectionFailure | 'invalid_block';

export interface AvailableBlock {
  pluginApiName: string;
  apiName: string;
}

export type BlockSelection =
  | { ok: true; block: Block; pluginApiName: string }
  | { ok: false; reason: BlockSelectionFailure; available: AvailableBlock[] };

export interface ExportedBlock {
  block: Block;
  pluginApiName: string;
  warnings: ValidationIssue[];
}

const DIMENSION_FIELDS = ['min_w', 'max_w', 'min_h', 'max_h'] as const;

const DIMENSION_RANGES = [
  ['min_w', 'max_w'],
  ['min_h', 'max_h'],
] as const;

const DEFAULT_SIZE_BOUNDS = {
  default_w: ['min_w', 'max_w'],
  default_h: ['min_h', 'max_h'],
} as const;

type DefaultSizeField = keyof typeof DEFAULT_SIZE_BOUNDS;

const DEFAULT_SIZE_FIELDS = Object.keys(DEFAULT_SIZE_BOUNDS) as DefaultSizeField[];

const SIZE_FIELDS = [...DIMENSION_FIELDS, ...DEFAULT_SIZE_FIELDS] as const;

const AUTHORED_FIELDS = [...SIZE_FIELDS, 'host_chrome'] as const;

type AuthoredField = (typeof AUTHORED_FIELDS)[number];

const UNSUPPORTED_SEQUENCES = ['\u0000', '{__ref:'];

export class BlockExportError extends Error {
  readonly reason: BlockExportReason;
  readonly available: AvailableBlock[];
  readonly field: string | undefined;

  constructor(
    reason: BlockExportReason,
    message: string,
    options: { available?: AvailableBlock[]; field?: string } = {},
  ) {
    super(message);
    this.name = 'BlockExportError';
    this.reason = reason;
    this.available = options.available ?? [];
    this.field = options.field;
  }
}

export function formatAvailableBlocks(available: AvailableBlock[]): string {
  const multiplePlugins = new Set(available.map((entry) => entry.pluginApiName)).size > 1;

  return available
    .map((entry) => (multiplePlugins ? `${entry.pluginApiName}/${entry.apiName}` : entry.apiName))
    .join(', ');
}

export function selectBlock(deployable: DeployablePlugin[], apiName?: string): BlockSelection {
  const candidates = deployable.flatMap((plugin) =>
    plugin.artifacts.custom_blocks.map((block) => ({ block, pluginApiName: plugin.api_name })),
  );
  const available = candidates.map(({ block, pluginApiName }) => ({
    pluginApiName,
    apiName: block.api_name,
  }));

  if (candidates.length === 0) {
    return { ok: false, reason: 'no_blocks', available };
  }

  if (apiName === undefined) {
    const [only] = candidates;

    return candidates.length === 1 && only
      ? { ok: true, ...only }
      : { ok: false, reason: 'ambiguous', available };
  }

  const matches = candidates.filter(({ block }) => block.api_name === apiName);
  const [match] = matches;

  if (!match) {
    return { ok: false, reason: 'not_found', available };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      available: matches.map(({ block, pluginApiName }) => ({
        pluginApiName,
        apiName: block.api_name,
      })),
    };
  }

  return { ok: true, ...match };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const hasUnsupportedContent = (value: string): boolean =>
  UNSUPPORTED_SEQUENCES.some((sequence) => value.includes(sequence));

export function findInvalidBlockField(block: Block): string | undefined {
  const raw = block as unknown as Record<string, unknown>;
  const { name, script, styles, event_scripts: eventScripts } = raw;

  if (typeof script !== 'string' || !script.trim()) {
    return 'script';
  }

  if (name !== undefined && typeof name !== 'string') {
    return 'name';
  }

  if (styles !== undefined && typeof styles !== 'string') {
    return 'styles';
  }

  if (eventScripts !== undefined) {
    if (!isRecord(eventScripts)) {
      return 'event_scripts';
    }

    const invalidEntry = Object.entries(eventScripts).find(
      ([eventName, body]) =>
        typeof body !== 'string' || hasUnsupportedContent(eventName) || hasUnsupportedContent(body),
    );

    if (invalidEntry) {
      return `event_scripts.${invalidEntry[0]}`;
    }
  }

  const unsupported = (
    [
      ['name', name],
      ['script', script],
      ['styles', styles],
    ] as const
  ).find(([, value]) => typeof value === 'string' && hasUnsupportedContent(value));

  if (unsupported) {
    return unsupported[0];
  }

  const invalidDimension = DIMENSION_FIELDS.find(
    (field) => raw[field] !== undefined && !isPositiveInteger(raw[field]),
  );

  if (invalidDimension) {
    return invalidDimension;
  }

  const invertedMin = DIMENSION_RANGES.find(([minField, maxField]) => {
    const min = raw[minField];
    const max = raw[maxField];

    return typeof min === 'number' && typeof max === 'number' && min > max;
  });

  if (invertedMin) {
    return invertedMin[0];
  }

  const invalidDefault = DEFAULT_SIZE_FIELDS.find((field) => {
    const value = raw[field];

    if (value === undefined) {
      return false;
    }

    if (typeof value !== 'number' || !isPositiveInteger(value)) {
      return true;
    }

    const [minField, maxField] = DEFAULT_SIZE_BOUNDS[field];
    const min = raw[minField];
    const max = raw[maxField];

    return (typeof min === 'number' && value < min) || (typeof max === 'number' && value > max);
  });

  if (invalidDefault) {
    return invalidDefault;
  }

  if (raw.host_chrome !== undefined && typeof raw.host_chrome !== 'boolean') {
    return 'host_chrome';
  }

  return undefined;
}

export const invalidBlockMessage = (apiName: string, field: string): string => {
  if (field === 'script') {
    return `Block "${apiName}" has no script. Add a non-empty script.js to the block directory.`;
  }

  if (field === 'host_chrome') {
    return `Block "${apiName}" has an invalid host_chrome: it must be true or false.`;
  }

  const range = DIMENSION_RANGES.find(([minField]) => minField === field);

  if (range) {
    return `Block "${apiName}" has an invalid ${field}: it must be a positive integer no greater than ${range[1]}.`;
  }

  if ((DIMENSION_FIELDS as readonly string[]).includes(field)) {
    return `Block "${apiName}" has an invalid ${field}: it must be a positive integer.`;
  }

  if (field in DEFAULT_SIZE_BOUNDS) {
    const [minField, maxField] = DEFAULT_SIZE_BOUNDS[field as DefaultSizeField];

    return `Block "${apiName}" has an invalid ${field}: it must be a positive integer between ${minField} and ${maxField}.`;
  }

  return `Block "${apiName}" has an invalid ${field}: it must be a string without NUL characters or "{__ref:".`;
};

export const selectionError = (
  selection: Extract<BlockSelection, { ok: false }>,
  apiName: string | undefined,
): BlockExportError => {
  const { reason, available } = selection;
  const list = formatAvailableBlocks(available);

  if (reason === 'no_blocks') {
    return new BlockExportError(
      reason,
      'This plugin has no blocks. Scaffold one with `appbuilder create --artifacts block`.',
      { available },
    );
  }

  if (reason === 'not_found') {
    return new BlockExportError(
      reason,
      `No block with api_name "${apiName ?? ''}". Available blocks: ${list}`,
      { available },
    );
  }

  return new BlockExportError(
    reason,
    apiName === undefined
      ? `This plugin has several blocks; pass the api_name of the one to export: ${list}`
      : `More than one plugin has a block with api_name "${apiName}": ${list}`,
    { available },
  );
};

const parseJsonRecord = (content: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const manifestEntries = (files: readonly FileContent[]): Map<string, string> => {
  const manifestFile = files.find((file) => file.path === MANIFEST_FILE_NAME);
  const parsed: unknown = manifestFile ? JSON.parse(manifestFile.content) : [];
  const manifests: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const entries = new Map<string, string>();

  for (const manifest of manifests) {
    if (
      isRecord(manifest) &&
      typeof manifest.api_name === 'string' &&
      typeof manifest.entry === 'string'
    ) {
      entries.set(manifest.api_name, manifest.entry);
    }
  }

  return entries;
};

const authoredBlockConfig = (
  files: readonly FileContent[],
  entry: string,
): Map<string, Partial<Record<AuthoredField, unknown>>> => {
  const prefix = `${entry.replace(/\/+$/, '')}/${BLOCKS_DIRECTORY_NAME}/`;
  const authoredByApiName = new Map<string, Partial<Record<AuthoredField, unknown>>>();

  for (const file of files) {
    if (!file.path.startsWith(prefix)) {
      continue;
    }

    const [directory, fileName, ...rest] = file.path.slice(prefix.length).split('/');

    if (!directory || fileName !== CONFIG_FILE_NAME || rest.length > 0) {
      continue;
    }

    const config = parseJsonRecord(file.content);

    if (!config) {
      continue;
    }

    const apiName =
      typeof config.api_name === 'string' && config.api_name !== ''
        ? config.api_name
        : sanitizeToAPIName(directory);
    const authored: Partial<Record<AuthoredField, unknown>> = {};

    for (const field of AUTHORED_FIELDS) {
      if (config[field] !== undefined) {
        authored[field] = config[field];
      }
    }

    authoredByApiName.set(apiName, authored);
  }

  return authoredByApiName;
};

const withAuthoredConfig = (
  block: Block,
  authored: Partial<Record<AuthoredField, unknown>> = {},
): Block => {
  const packaged = Object.fromEntries(
    Object.entries(block).filter(([key]) => !(AUTHORED_FIELDS as readonly string[]).includes(key)),
  );

  return { ...packaged, ...authored } as unknown as Block;
};

export function applyAuthoredConfig(
  deployable: DeployablePlugin[],
  files: readonly FileContent[],
): DeployablePlugin[] {
  const entries = manifestEntries(files);

  return deployable.map((plugin) => {
    const entry = entries.get(plugin.api_name);
    const authored =
      entry === undefined
        ? new Map<string, Partial<Record<AuthoredField, unknown>>>()
        : authoredBlockConfig(files, entry);

    return {
      ...plugin,
      artifacts: {
        ...plugin.artifacts,
        custom_blocks: plugin.artifacts.custom_blocks.map((block) =>
          withAuthoredConfig(block, authored.get(block.api_name)),
        ),
      },
    };
  });
}

export async function packageBlocks(
  pluginDir: string,
): Promise<{ deployable: DeployablePlugin[]; warnings: ValidationIssue[] }> {
  const { files, deployable, issues } = await packageLocalPlugin(pluginDir);

  return {
    deployable: applyAuthoredConfig(deployable, files),
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}

export async function exportBlock(pluginDir: string, apiName?: string): Promise<ExportedBlock> {
  const { deployable, warnings } = await packageBlocks(pluginDir);
  const selection = selectBlock(deployable, apiName);

  if (!selection.ok) {
    throw selectionError(selection, apiName);
  }

  const invalidField = findInvalidBlockField(selection.block);

  if (invalidField !== undefined) {
    throw new BlockExportError(
      'invalid_block',
      invalidBlockMessage(selection.block.api_name, invalidField),
      { field: invalidField },
    );
  }

  return { block: selection.block, pluginApiName: selection.pluginApiName, warnings };
}
