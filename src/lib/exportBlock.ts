import {
  BLOCKS_DIRECTORY_NAME,
  CONFIG_FILE_NAME,
  MANIFEST_FILE_NAME,
  sanitizeToAPIName,
} from '@kizenapps/packager';
import type {
  Block,
  DeployablePlugin,
  FileContent,
  RoutablePage,
  ValidationIssue,
} from '@kizenapps/packager';
import { isRecord, normalizeEntryDir } from './guards.js';
import { BLOCK_SIZE_FIELDS, type CustomCodeView } from './kizenTypes.js';
import { toCustomCodeViews } from './pushBlock.js';
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
  /** The owning plugin's packaged views/ components, sorted by api_name. */
  views: RoutablePage[];
  warnings: ValidationIssue[];
}

/** Packaged views/ components per plugin api_name. */
export type ViewsByPlugin = Record<string, RoutablePage[]>;

export interface PackagedBlocks {
  deployable: DeployablePlugin[];
  views: ViewsByPlugin;
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

const AUTHORED_FIELDS = [...BLOCK_SIZE_FIELDS, 'host_chrome'] as const;

type AuthoredField = (typeof AUTHORED_FIELDS)[number];

const UNSUPPORTED_SEQUENCES = ['\u0000', '{__ref:'];

// @kizenapps/packager 0.9.0 uses "views" internally but doesn't export the constant.
const VIEWS_DIRECTORY_NAME = 'views';

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

export interface InvalidViewField {
  view: string;
  field: string;
}

const VIEW_STRING_FIELDS = ['api_name', 'name', 'script', 'html', 'css'] as const;

const isUnsupportedString = (value: unknown): boolean =>
  typeof value !== 'string' || hasUnsupportedContent(value);

// Views ride inside the same custom_code content as the block, so they get the
// same NUL / "{__ref:" guard. The packager copies config.name through unchecked,
// so a non-string name is rejected here too.
export function findInvalidViewField(views: readonly RoutablePage[]): InvalidViewField | undefined {
  for (const view of views) {
    const raw = view as unknown as Record<string, unknown>;
    const label = typeof raw.api_name === 'string' ? raw.api_name : String(raw.api_name);
    const invalidString = VIEW_STRING_FIELDS.find((field) => isUnsupportedString(raw[field]));

    if (invalidString) {
      return { view: label, field: invalidString };
    }

    const eventScripts = raw.event_scripts;

    if (!isRecord(eventScripts)) {
      return { view: label, field: 'event_scripts' };
    }

    const invalidEntry = Object.entries(eventScripts).find(
      ([eventName, body]) => hasUnsupportedContent(eventName) || isUnsupportedString(body),
    );

    if (invalidEntry) {
      return { view: label, field: `event_scripts.${invalidEntry[0]}` };
    }
  }

  return undefined;
}

export const invalidViewFieldPath = ({ view, field }: InvalidViewField): string =>
  `views.${view}.${field}`;

export const invalidViewMessage = (blockApiName: string, invalid: InvalidViewField): string =>
  `Block "${blockApiName}" can't carry view ${JSON.stringify(invalid.view)}: its ${invalid.field} must be a string without NUL characters or "{__ref:".`;

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

export type BlockSelectionVerb = 'export' | 'push';

const selectionMessage = (
  { reason, available }: Extract<BlockSelection, { ok: false }>,
  apiName: string | undefined,
  verb: BlockSelectionVerb,
): string => {
  const list = formatAvailableBlocks(available);

  if (reason === 'no_blocks') {
    return 'This plugin has no blocks. Scaffold one with `appbuilder create --artifacts block`.';
  }

  if (reason === 'not_found') {
    return `No block with api_name "${apiName ?? ''}". Available blocks: ${list}`;
  }

  return apiName === undefined
    ? `This plugin has several blocks; pass the api_name of the one to ${verb}: ${list}`
    : `More than one plugin has a block with api_name "${apiName}": ${list}`;
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

// The root-relative directory of one component kind under a plugin entry, e.g.
// "src/blocks". An entry of "", "." or "./" is the plugin root.
const componentRoot = (entry: string, dirName: string): string => {
  const entryDir = normalizeEntryDir(entry);

  return entryDir === '' ? dirName : `${entryDir}/${dirName}`;
};

interface ComponentDirectories {
  /** Every component directory with at least one file, .DS_Store aside. */
  directories: Set<string>;
  /** Each directory's parsed config.json, in file order. */
  configs: [directory: string, config: Record<string, unknown>][];
}

const componentDirectories = (
  files: readonly FileContent[],
  entry: string,
  dirName: string,
): ComponentDirectories => {
  const prefix = `${componentRoot(entry, dirName)}/`;
  const directories = new Set<string>();
  const configs: ComponentDirectories['configs'] = [];

  for (const file of files) {
    if (!file.path.startsWith(prefix) || file.path.endsWith('.DS_Store')) {
      continue;
    }

    const [directory, fileName, ...rest] = file.path.slice(prefix.length).split('/');

    if (!directory) {
      continue;
    }

    directories.add(directory);

    if (fileName === CONFIG_FILE_NAME && rest.length === 0) {
      const config = parseJsonRecord(file.content);

      if (config) {
        configs.push([directory, config]);
      }
    }
  }

  return { directories, configs };
};

// The packager's api_name for a component: config.api_name, else the sanitized directory.
const componentApiName = (config: Record<string, unknown>, directory: string): string =>
  typeof config.api_name === 'string' && config.api_name !== ''
    ? config.api_name
    : sanitizeToAPIName(directory);

const authoredBlockConfig = (
  files: readonly FileContent[],
  entry: string,
): Map<string, Partial<Record<AuthoredField, unknown>>> => {
  const authoredByApiName = new Map<string, Partial<Record<AuthoredField, unknown>>>();

  for (const [directory, config] of componentDirectories(files, entry, BLOCKS_DIRECTORY_NAME)
    .configs) {
    const apiName = componentApiName(config, directory);
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

const viewKey = (apiName: unknown, name: unknown): string =>
  JSON.stringify([String(apiName), String(name)]);

// The packager merges pages/ and views/ into one routable_pages list with no
// source marker, so rebuild each view's packaged (api_name, name) from the
// source tree the same way the packager does and match on that pair.
const authoredViewKeys = (files: readonly FileContent[], entry: string): Set<string> => {
  const { directories, configs } = componentDirectories(files, entry, VIEWS_DIRECTORY_NAME);
  const configByDirectory = new Map(configs);
  const keys = new Set<string>();

  for (const directory of directories) {
    const config = configByDirectory.get(directory) ?? {};

    keys.add(viewKey(componentApiName(config, directory), config.name || directory));
  }

  return keys;
};

// name is typed string but the packager copies config.name through unchecked.
const compareViews = (a: RoutablePage, b: RoutablePage): number =>
  a.api_name.localeCompare(b.api_name) ||
  String(a.name as unknown).localeCompare(String(b.name as unknown));

export const VIEWS_UNMATCHED_RULE = 'appbuilder/views-unmatched';

export function collectViews(
  deployable: readonly DeployablePlugin[],
  files: readonly FileContent[],
): { views: ViewsByPlugin; warnings: ValidationIssue[] } {
  const entries = manifestEntries(files);
  const views: ViewsByPlugin = {};
  const warnings: ValidationIssue[] = [];

  for (const plugin of deployable) {
    const entry = entries.get(plugin.api_name);
    const keys = entry === undefined ? new Set<string>() : authoredViewKeys(files, entry);
    const matched = plugin.artifacts.routable_pages
      .filter((page) => keys.has(viewKey(page.api_name, page.name)))
      .sort(compareViews);

    // A packager change to how views are named would otherwise drop them silently.
    if (matched.length !== keys.size && entry !== undefined) {
      warnings.push({
        rule: VIEWS_UNMATCHED_RULE,
        severity: 'warning',
        message: `Found ${String(keys.size)} ${VIEWS_DIRECTORY_NAME}/ components but matched ${String(matched.length)} packaged views; the pushed block carries only the matched ones.`,
        path: componentRoot(entry, VIEWS_DIRECTORY_NAME),
        pluginApiName: plugin.api_name,
      });
    }

    views[plugin.api_name] = matched;
  }

  return { views, warnings };
}

export function viewsFor(views: ViewsByPlugin, pluginApiName: string): RoutablePage[] {
  return Object.hasOwn(views, pluginApiName) ? (views[pluginApiName] ?? []) : [];
}

/** The JSON `block export` prints: the packaged block plus its plugin's views, when any. */
export function toExportJson(exported: ExportedBlock): Block & { views?: CustomCodeView[] } {
  return { ...exported.block, ...toCustomCodeViews(exported.views) };
}

export async function packageBlocks(pluginDir: string): Promise<PackagedBlocks> {
  const { files, deployable, issues } = await packageLocalPlugin(pluginDir);
  const collected = collectViews(deployable, files);

  return {
    deployable: applyAuthoredConfig(deployable, files),
    views: collected.views,
    warnings: [...issues.filter((issue) => issue.severity === 'warning'), ...collected.warnings],
  };
}

export type PackagedBlockResolution =
  | { ok: true; value: ExportedBlock }
  | {
      ok: false;
      reason: BlockExportReason;
      message: string;
      available: AvailableBlock[];
      field?: string;
    };

/**
 * Selects one block from packaged plugins and validates it and its plugin's views.
 * `verb` only changes the "several blocks" message ("one to export" / "one to push").
 */
export function resolvePackagedBlock(
  { deployable, views, warnings }: PackagedBlocks,
  apiName: string | undefined,
  verb: BlockSelectionVerb,
): PackagedBlockResolution {
  const selection = selectBlock(deployable, apiName);

  if (!selection.ok) {
    return {
      ok: false,
      reason: selection.reason,
      message: selectionMessage(selection, apiName, verb),
      available: selection.available,
    };
  }

  const invalidField = findInvalidBlockField(selection.block);

  if (invalidField !== undefined) {
    return {
      ok: false,
      reason: 'invalid_block',
      message: invalidBlockMessage(selection.block.api_name, invalidField),
      available: [],
      field: invalidField,
    };
  }

  const blockViews = viewsFor(views, selection.pluginApiName);
  const invalidView = findInvalidViewField(blockViews);

  if (invalidView !== undefined) {
    return {
      ok: false,
      reason: 'invalid_block',
      message: invalidViewMessage(selection.block.api_name, invalidView),
      available: [],
      field: invalidViewFieldPath(invalidView),
    };
  }

  return {
    ok: true,
    value: {
      block: selection.block,
      pluginApiName: selection.pluginApiName,
      views: blockViews,
      warnings,
    },
  };
}

export async function exportBlock(pluginDir: string, apiName?: string): Promise<ExportedBlock> {
  const resolved = resolvePackagedBlock(await packageBlocks(pluginDir), apiName, 'export');

  if (!resolved.ok) {
    throw new BlockExportError(resolved.reason, resolved.message, resolved);
  }

  return resolved.value;
}
