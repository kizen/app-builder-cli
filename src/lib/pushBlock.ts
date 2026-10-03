import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Block, RoutablePage } from '@kizenapps/packager';
import { cleanCredentialId } from '../../shared/lib/credentials.js';
import { isMissingFileError, isRecord } from './guards.js';
import {
  BLOCK_SIZE_FIELDS,
  type CreateDashletBody,
  type CustomCodeContent,
  type CustomCodeView,
  type DashboardType,
  type DashletLayout,
  type EventScriptEntry,
  type PushMapEntry,
  type Surface,
  type UpdateDashletBody,
  type WireDashboard,
  type WireDashlet,
} from './kizenTypes.js';

export const PUSH_NAME_PREFIX = 'appbuilder:';

export const PUSH_MAP_RELATIVE_PATH = '.kizenapp/pushes.json';

type DimensionKey = (typeof BLOCK_SIZE_FIELDS)[number];

const PUSH_MAP_STRING_FIELDS = [
  'environment',
  'businessId',
  'pluginApiName',
  'blockApiName',
  'dashboardId',
  'dashletId',
  'contentHash',
  'pushedAt',
] as const satisfies readonly (keyof PushMapEntry)[];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function withoutCustomObject(record: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...record };

  delete rest.custom_object;

  return rest;
}

export function pushKey(pluginApiName: string, blockApiName: string): string {
  return `${PUSH_NAME_PREFIX}${pluginApiName}/${blockApiName}`;
}

export function parsePushKey(name: string): { pluginApiName: string; blockApiName: string } | null {
  if (!name.startsWith(PUSH_NAME_PREFIX)) {
    return null;
  }

  const parts = name.slice(PUSH_NAME_PREFIX.length).split('/');

  if (parts.length !== 2) {
    return null;
  }

  const [pluginApiName, blockApiName] = parts;

  if (!pluginApiName || !blockApiName) {
    return null;
  }

  return { pluginApiName, blockApiName };
}

function pickDimensions(source: Record<string, unknown>): Partial<Record<DimensionKey, number>> {
  const dimensions: Partial<Record<DimensionKey, number>> = {};

  for (const key of BLOCK_SIZE_FIELDS) {
    const value = source[key];

    if (isFiniteNumber(value)) {
      dimensions[key] = value;
    }
  }

  return dimensions;
}

function pickHostChrome(source: Record<string, unknown>): { host_chrome?: boolean } {
  return typeof source.host_chrome === 'boolean' ? { host_chrome: source.host_chrome } : {};
}

const toEventScriptEntries = (eventScripts: Record<string, string>): EventScriptEntry[] =>
  Object.entries(eventScripts).map(([name, script]) => ({ name, script }));

export function toCustomCodeView(page: RoutablePage): CustomCodeView {
  return {
    api_name: page.api_name,
    name: page.name,
    type: page.type,
    ...(page.script !== '' && { script: page.script }),
    ...(page.html !== '' && { html: page.html }),
    ...(page.css !== '' && { css: page.css }),
    event_scripts: toEventScriptEntries(page.event_scripts),
  };
}

export function toCustomCodeViews(views: readonly RoutablePage[]): { views?: CustomCodeView[] } {
  return views.length > 0 ? { views: views.map(toCustomCodeView) } : {};
}

export function toCustomCodeContent(
  block: Block,
  views: readonly RoutablePage[] = [],
): CustomCodeContent {
  return {
    kind: 'custom_code',
    version: 1,
    name: block.name,
    script: block.script,
    styles: block.styles,
    event_scripts: toEventScriptEntries(block.event_scripts),
    ...pickDimensions(block as unknown as Record<string, unknown>),
    ...pickHostChrome(block as unknown as Record<string, unknown>),
    ...toCustomCodeViews(views),
  };
}

export function buildDashletConfig(args: {
  content: CustomCodeContent;
  objectId: string;
}): Record<string, unknown> {
  return {
    object_id: args.objectId,
    entity_type: 'static_content',
    report_type: 'html',
    chart_type: 'html',
    content: args.content,
    fe_extra_info: {},
  };
}

export function computeMaxBottom(dashlets: readonly WireDashlet[]): number {
  let maxBottom = 0;

  for (const dashlet of dashlets) {
    const layout: unknown = dashlet.layout;

    if (!isRecord(layout)) {
      continue;
    }

    const { y, h } = layout;

    if (!isFiniteNumber(y) || !isFiniteNumber(h)) {
      continue;
    }

    maxBottom = Math.max(maxBottom, y + h);
  }

  return maxBottom;
}

export function computeCreateLayout(
  dashlets: readonly WireDashlet[],
  content: CustomCodeContent,
  layoutId: string,
): DashletLayout {
  const w = clamp(content.default_w ?? content.min_w ?? 6, content.min_w ?? 1, content.max_w ?? 12);
  const h = clamp(content.default_h ?? content.min_h ?? 3, content.min_h ?? 1, content.max_h ?? 99);

  return {
    i: layoutId,
    x: 0,
    y: computeMaxBottom(dashlets),
    w: clamp(w, 2, 12),
    h: clamp(h, 1, 99),
  };
}

export function buildCreateBody(args: {
  pluginApiName: string;
  blockApiName: string;
  content: CustomCodeContent;
  dashlets: readonly WireDashlet[];
  objectId: string;
  layoutId: string;
}): CreateDashletBody {
  return {
    name: pushKey(args.pluginApiName, args.blockApiName),
    layout: computeCreateLayout(args.dashlets, args.content, args.layoutId),
    config: buildDashletConfig({
      content: args.content,
      objectId: args.objectId,
    }),
  };
}

export function buildUpdateBody(
  existing: WireDashlet,
  content: CustomCodeContent,
): UpdateDashletBody {
  const rawConfig: unknown = existing.config;
  const config = withoutCustomObject(isRecord(rawConfig) ? rawConfig : {});

  return {
    config: {
      ...config,
      content,
    },
  };
}

function contentOf(dashlet: WireDashlet): unknown {
  const config: unknown = dashlet.config;

  return isRecord(config) ? config.content : undefined;
}

export function isCustomCodeDashlet(dashlet: WireDashlet): boolean {
  const config: unknown = dashlet.config;

  if (!isRecord(config) || config.chart_type !== 'html') {
    return false;
  }

  const content = config.content;

  return isRecord(content) && content.kind === 'custom_code';
}

export function findCustomCodeDashlets(dashboard: Pick<WireDashboard, 'dashlets'>): WireDashlet[] {
  return dashboard.dashlets.filter(isCustomCodeDashlet);
}

export function customCodeName(dashlet: WireDashlet): string {
  const content = contentOf(dashlet);

  if (isRecord(content) && typeof content.name === 'string') {
    return content.name;
  }

  return dashlet.name;
}

const stringOr = (candidate: unknown): string => (typeof candidate === 'string' ? candidate : '');

function normalizeEventScripts(value: unknown): EventScriptEntry[] {
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((entry) => ({ name: stringOr(entry.name), script: stringOr(entry.script) }));
  }

  if (isRecord(value)) {
    return Object.entries(value).map(([name, script]) => ({ name, script: stringOr(script) }));
  }

  return [];
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }

    return sorted;
  }

  return value;
}

function nameOf(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }

  return '';
}

// Missing optional strings hash as '' so a round-trip that adds or drops an
// empty script/html/css doesn't read as drift.
function normalizeViews(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((view) => ({
    api_name: stringOr(view.api_name),
    name: nameOf(view.name),
    type: stringOr(view.type),
    script: stringOr(view.script),
    html: stringOr(view.html),
    css: stringOr(view.css),
    event_scripts: normalizeEventScripts(view.event_scripts),
  }));
}

export function canonicalContentHash(content: unknown): string {
  const source = isRecord(content) ? content : {};
  const views = normalizeViews(source.views);
  // `views` joins the canonical form only when non-empty, so content without
  // views hashes exactly as it did before views existed (pushes.json stays valid).
  const canonical = {
    name: nameOf(source.name),
    script: typeof source.script === 'string' ? source.script : '',
    styles: typeof source.styles === 'string' ? source.styles : '',
    event_scripts: normalizeEventScripts(source.event_scripts),
    ...pickDimensions(source),
    ...pickHostChrome(source),
    ...(views.length > 0 && { views }),
  };

  return createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(canonical)))
    .digest('hex');
}

export type TargetMatch =
  | { kind: 'map'; dashlet: WireDashlet; entry: PushMapEntry }
  | { kind: 'name'; dashlet: WireDashlet }
  | { kind: 'ambiguous'; dashlets: WireDashlet[] }
  | { kind: 'none' };

export function matchPushTarget(args: {
  dashboardId: string;
  dashlets: readonly WireDashlet[];
  pluginApiName: string;
  blockApiName: string;
  entry: PushMapEntry | undefined;
}): TargetMatch {
  const { entry } = args;

  if (entry?.dashboardId === args.dashboardId) {
    const mapped = args.dashlets.find((dashlet) => dashlet.id === entry.dashletId);

    if (mapped && isCustomCodeDashlet(mapped)) {
      return { kind: 'map', dashlet: mapped, entry };
    }
  }

  const key = pushKey(args.pluginApiName, args.blockApiName);
  const named = args.dashlets.filter(
    (dashlet) => dashlet.name === key && isCustomCodeDashlet(dashlet),
  );
  const [first] = named;

  if (named.length === 1 && first) {
    return { kind: 'name', dashlet: first };
  }

  if (named.length > 1) {
    return { kind: 'ambiguous', dashlets: named };
  }

  return { kind: 'none' };
}

export function detectDrift(dashlet: WireDashlet, entry: PushMapEntry | undefined): boolean {
  if (entry?.dashletId !== dashlet.id) {
    return false;
  }

  return canonicalContentHash(contentOf(dashlet)) !== entry.contentHash;
}

export interface PushMapKey {
  environment: string;
  businessId: string;
  pluginApiName: string;
  blockApiName: string;
}

function matchesKey(entry: PushMapKey, key: PushMapKey): boolean {
  return (
    entry.environment === key.environment &&
    entry.businessId === key.businessId &&
    entry.pluginApiName === key.pluginApiName &&
    entry.blockApiName === key.blockApiName
  );
}

export function findPushMapEntry(
  entries: readonly PushMapEntry[],
  key: PushMapKey,
): PushMapEntry | undefined {
  return entries.find((entry) => matchesKey(entry, key));
}

export function upsertPushMapEntry(
  entries: readonly PushMapEntry[],
  entry: PushMapEntry,
): PushMapEntry[] {
  const index = entries.findIndex((candidate) => matchesKey(candidate, entry));

  if (index === -1) {
    return [...entries, entry];
  }

  return entries.map((candidate, candidateIndex) => (candidateIndex === index ? entry : candidate));
}

export function removePushMapEntry(
  entries: readonly PushMapEntry[],
  key: PushMapKey,
): PushMapEntry[] {
  return entries.filter((entry) => !matchesKey(entry, key));
}

function toPushMapEntry(value: unknown): PushMapEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const field of PUSH_MAP_STRING_FIELDS) {
    if (typeof value[field] !== 'string') {
      return null;
    }
  }

  const record = value as Record<(typeof PUSH_MAP_STRING_FIELDS)[number], string>;

  return {
    environment: record.environment,
    businessId: cleanCredentialId(record.businessId),
    pluginApiName: record.pluginApiName,
    blockApiName: record.blockApiName,
    dashboardId: record.dashboardId,
    dashletId: record.dashletId,
    contentHash: record.contentHash,
    pushedAt: record.pushedAt,
  };
}

const pushedAtTime = (entry: PushMapEntry): number => Date.parse(entry.pushedAt) || 0;

function latestPerKey(entries: readonly PushMapEntry[]): PushMapEntry[] {
  const byKey = new Map<string, PushMapEntry>();

  for (const entry of entries) {
    const id = [entry.environment, entry.businessId, entry.pluginApiName, entry.blockApiName].join(
      '\u0000',
    );
    const current = byKey.get(id);

    if (current === undefined || pushedAtTime(entry) > pushedAtTime(current)) {
      byKey.set(id, entry);
    }
  }

  return [...byKey.values()];
}

const pushMapErrorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function readPushMap(pluginDir: string): Promise<PushMapEntry[]> {
  let raw: string;

  try {
    raw = await readFile(join(pluginDir, PUSH_MAP_RELATIVE_PATH), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw new Error(
      `Couldn't read ${PUSH_MAP_RELATIVE_PATH}: ${pushMapErrorDetail(error)}. Fix its permissions, or delete it to start a fresh push map.`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${PUSH_MAP_RELATIVE_PATH} is not valid JSON (${pushMapErrorDetail(error)}). Fix it, or delete it to start a fresh push map.`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `${PUSH_MAP_RELATIVE_PATH} must contain a JSON array of push entries. Fix it, or delete it to start a fresh push map.`,
    );
  }

  return latestPerKey(
    parsed.map(toPushMapEntry).filter((entry): entry is PushMapEntry => entry !== null),
  );
}

export async function writePushMap(
  pluginDir: string,
  entries: readonly PushMapEntry[],
): Promise<void> {
  const filePath = join(pluginDir, PUSH_MAP_RELATIVE_PATH);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

const DASHBOARD_TYPE_TO_SURFACE: Record<DashboardType, Surface> = {
  generic_dashboard: 'dashboard',
  homepage: 'homepage',
  chart_group: 'chart_group',
};

const SURFACE_TO_DASHBOARD_TYPE: Record<Surface, DashboardType> = {
  dashboard: 'generic_dashboard',
  homepage: 'homepage',
  chart_group: 'chart_group',
};

export function dashboardTypeToSurface(type: DashboardType): Surface {
  return DASHBOARD_TYPE_TO_SURFACE[type];
}

export function surfaceToDashboardType(surface: Surface): DashboardType {
  return SURFACE_TO_DASHBOARD_TYPE[surface];
}

export function buildDashboardUrl(args: {
  appBaseUrl: string;
  surface: Surface;
  dashboardId: string;
  customObject?: { id: string; fetchUrl?: string } | null;
}): string {
  const base = args.appBaseUrl.replace(/\/+$/, '');
  const id = args.dashboardId;

  if (args.surface === 'homepage') {
    return `${base}/home/${id}`;
  }

  if (args.surface === 'chart_group' && args.customObject) {
    if (args.customObject.fetchUrl === 'client') {
      return `${base}/clients/charts/${id}`;
    }

    return `${base}/custom-objects/${args.customObject.id}/charts/${id}`;
  }

  return `${base}/dashboard/${id}`;
}
