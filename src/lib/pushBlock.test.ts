import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Block, RoutablePage } from '@kizenapps/packager';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CustomCodeContent, DashletLayout, PushMapEntry, WireDashlet } from './kizenTypes.js';
import {
  PUSH_MAP_RELATIVE_PATH,
  PUSH_NAME_PREFIX,
  buildCreateBody,
  buildDashboardUrl,
  buildDashletConfig,
  buildUpdateBody,
  canonicalContentHash,
  computeCreateLayout,
  computeMaxBottom,
  customCodeName,
  dashboardTypeToSurface,
  detectDrift,
  findCustomCodeDashlets,
  findPushMapEntry,
  isCustomCodeDashlet,
  matchPushTarget,
  parsePushKey,
  pushKey,
  readPushMap,
  removePushMapEntry,
  surfaceToDashboardType,
  toCustomCodeContent,
  toCustomCodeView,
  upsertPushMapEntry,
  writePushMap,
} from './pushBlock.js';

const makeBlock = (overrides: Partial<Block> = {}): Block => ({
  name: 'Sales Widget',
  api_name: 'sales_widget',
  min_w: 4,
  max_w: 8,
  min_h: 2,
  max_h: 6,
  event_scripts: { onLoad: 'load();', onClick: 'click();' },
  script: 'this.outputUI("hi");',
  styles: '.a { color: red; }',
  when: '',
  ...overrides,
});

const makeContent = (overrides: Partial<CustomCodeContent> = {}): CustomCodeContent => ({
  kind: 'custom_code',
  version: 1,
  name: 'Block',
  script: 'run();',
  styles: '',
  event_scripts: [],
  ...overrides,
});

const customCodeConfig = (content: unknown = makeContent()): Record<string, unknown> => ({
  object_id: 'obj-1',
  entity_type: 'static_content',
  report_type: 'html',
  chart_type: 'html',
  content,
  fe_extra_info: { custom_styles_enabled: true, dashlet_style_config: { drop_shadow: false } },
});

const makeDashlet = (overrides: Partial<WireDashlet> = {}): WireDashlet => ({
  id: 'dashlet-1',
  name: 'Some dashlet',
  layout: { i: 'l1', x: 0, y: 0, w: 6, h: 3 },
  config: customCodeConfig(),
  dashboard: 'dash-1',
  ...overrides,
});

const makeEntry = (overrides: Partial<PushMapEntry> = {}): PushMapEntry => ({
  environment: 'staging',
  businessId: 'biz-1',
  pluginApiName: 'acme',
  blockApiName: 'sales_widget',
  dashboardId: 'dash-1',
  dashletId: 'dashlet-1',
  contentHash: 'hash',
  pushedAt: '2026-09-25T00:00:00.000Z',
  ...overrides,
});

const CAMEL_CASE_KEYS = [
  'eventScripts',
  'feExtraInfo',
  'objectId',
  'entityType',
  'reportType',
  'chartType',
  'customStylesEnabled',
  'dashletStyleConfig',
  'dropShadow',
  'minW',
  'maxW',
  'minH',
  'maxH',
  'defaultW',
  'defaultH',
  'hostChrome',
  'customObject',
];

const expectWireSafe = (value: unknown): void => {
  const json = JSON.stringify(value);

  expect(json).not.toContain('custom_object');

  for (const key of CAMEL_CASE_KEYS) {
    expect(json).not.toContain(`"${key}"`);
  }
};

describe('push keys', () => {
  it('builds and parses the dashlet name key', () => {
    expect(PUSH_NAME_PREFIX).toBe('appbuilder:');
    expect(pushKey('acme', 'sales_widget')).toBe('appbuilder:acme/sales_widget');
    expect(parsePushKey('appbuilder:acme/sales_widget')).toStrictEqual({
      pluginApiName: 'acme',
      blockApiName: 'sales_widget',
    });
  });

  it('rejects names that are not push keys', () => {
    expect(parsePushKey('acme/sales_widget')).toBeNull();
    expect(parsePushKey('appbuilder:acme')).toBeNull();
    expect(parsePushKey('appbuilder:/block')).toBeNull();
    expect(parsePushKey('appbuilder:acme/')).toBeNull();
    expect(parsePushKey('appbuilder:a/b/c')).toBeNull();
  });
});

describe('toCustomCodeContent', () => {
  it('produces snake_case content with event scripts as an array', () => {
    const content = toCustomCodeContent(makeBlock());

    expect(content).toStrictEqual({
      kind: 'custom_code',
      version: 1,
      name: 'Sales Widget',
      script: 'this.outputUI("hi");',
      styles: '.a { color: red; }',
      event_scripts: [
        { name: 'onLoad', script: 'load();' },
        { name: 'onClick', script: 'click();' },
      ],
      min_w: 4,
      max_w: 8,
      min_h: 2,
      max_h: 6,
    });
    expectWireSafe(content);
  });

  it('omits undefined dimensions', () => {
    const block = makeBlock({ event_scripts: {} }) as unknown as Record<string, unknown>;

    delete block.min_w;
    delete block.max_h;

    const content = toCustomCodeContent(block as unknown as Block);

    expect(content).toStrictEqual({
      kind: 'custom_code',
      version: 1,
      name: 'Sales Widget',
      script: 'this.outputUI("hi");',
      styles: '.a { color: red; }',
      event_scripts: [],
      max_w: 8,
      min_h: 2,
    });
    expect(Object.keys(content)).not.toContain('min_w');
    expect(Object.keys(content)).not.toContain('max_h');
    expect(Object.keys(content)).not.toContain('default_w');
    expect(Object.keys(content)).not.toContain('default_h');
  });

  it('carries default_w and default_h in snake_case when the block sets them', () => {
    const block = { ...makeBlock({ event_scripts: {} }), default_w: 6, default_h: 4 };
    const content = toCustomCodeContent(block as unknown as Block);

    expect(content).toStrictEqual({
      kind: 'custom_code',
      version: 1,
      name: 'Sales Widget',
      script: 'this.outputUI("hi");',
      styles: '.a { color: red; }',
      event_scripts: [],
      min_w: 4,
      max_w: 8,
      min_h: 2,
      max_h: 6,
      default_w: 6,
      default_h: 4,
    });
    expectWireSafe(content);
  });
});

describe('toCustomCodeContent host_chrome', () => {
  const withHostChrome = (hostChrome: unknown): Block =>
    ({ ...makeBlock({ event_scripts: {} }), host_chrome: hostChrome }) as unknown as Block;

  it.each([false, true])('carries host_chrome %o in snake_case', (hostChrome) => {
    const content = toCustomCodeContent(withHostChrome(hostChrome));

    expect(content).toStrictEqual({
      kind: 'custom_code',
      version: 1,
      name: 'Sales Widget',
      script: 'this.outputUI("hi");',
      styles: '.a { color: red; }',
      event_scripts: [],
      min_w: 4,
      max_w: 8,
      min_h: 2,
      max_h: 6,
      host_chrome: hostChrome,
    });
    expectWireSafe(content);
  });

  it('omits host_chrome when the block does not set it', () => {
    expect(Object.keys(toCustomCodeContent(makeBlock()))).not.toContain('host_chrome');
  });

  it.each(['false', 0, null])('omits a non-boolean host_chrome of %o', (hostChrome) => {
    expect(Object.keys(toCustomCodeContent(withHostChrome(hostChrome)))).not.toContain(
      'host_chrome',
    );
  });
});

describe('buildDashletConfig', () => {
  it('builds the exact static_content config', () => {
    const content = makeContent();
    const config = buildDashletConfig({ content, objectId: 'obj-9' });

    expect(config).toStrictEqual({
      object_id: 'obj-9',
      entity_type: 'static_content',
      report_type: 'html',
      chart_type: 'html',
      content,
      fe_extra_info: {},
    });
    expectWireSafe(config);
  });
});

describe('buildCreateBody', () => {
  it('builds the full create body', () => {
    const content = toCustomCodeContent(makeBlock());
    const body = buildCreateBody({
      pluginApiName: 'acme',
      blockApiName: 'sales_widget',
      content,
      dashlets: [
        makeDashlet({ layout: { i: 'a', x: 0, y: 0, w: 6, h: 4 } }),
        makeDashlet({ layout: { i: 'b', x: 6, y: 2, w: 6, h: 5 } }),
      ],
      objectId: 'obj-1',
      layoutId: 'layout-uuid',
    });

    expect(body).toStrictEqual({
      name: 'appbuilder:acme/sales_widget',
      layout: { i: 'layout-uuid', x: 0, y: 7, w: 4, h: 2 },
      config: {
        object_id: 'obj-1',
        entity_type: 'static_content',
        report_type: 'html',
        chart_type: 'html',
        content: {
          kind: 'custom_code',
          version: 1,
          name: 'Sales Widget',
          script: 'this.outputUI("hi");',
          styles: '.a { color: red; }',
          event_scripts: [
            { name: 'onLoad', script: 'load();' },
            { name: 'onClick', script: 'click();' },
          ],
          min_w: 4,
          max_w: 8,
          min_h: 2,
          max_h: 6,
        },
        fe_extra_info: {},
      },
    });
    expectWireSafe(body);
  });
});

describe('buildCreateBody host_chrome', () => {
  it('sends host_chrome false in the created content', () => {
    const content = makeContent({ host_chrome: false });
    const body = buildCreateBody({
      pluginApiName: 'acme',
      blockApiName: 'sales_widget',
      content,
      dashlets: [],
      objectId: 'obj-1',
      layoutId: 'layout-uuid',
    });

    expect(body.config.content).toStrictEqual(content);
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty('config.content.host_chrome', false);
  });
});

describe('layout', () => {
  it('computes max bottom, ignoring null and non-finite layouts', () => {
    expect(computeMaxBottom([])).toBe(0);
    expect(computeMaxBottom([makeDashlet({ layout: null })])).toBe(0);
    expect(
      computeMaxBottom([
        makeDashlet({ layout: { i: 'a', x: 0, y: 3, w: 6, h: 4 } }),
        makeDashlet({ layout: null }),
        makeDashlet({ layout: { i: 'b', x: 0, y: Number.NaN, w: 6, h: 100 } }),
        makeDashlet({ layout: { i: 'c', x: 0, y: 1, w: 6, h: Number.POSITIVE_INFINITY } }),
      ]),
    ).toBe(7);
  });

  it('places the new dashlet below the max bottom at x 0', () => {
    const layout = computeCreateLayout(
      [makeDashlet({ layout: { i: 'a', x: 4, y: 10, w: 6, h: 2 } })],
      makeContent(),
      'id',
    );

    expect(layout).toStrictEqual({ i: 'id', x: 0, y: 12, w: 6, h: 3 });
  });

  it('starts at y 0 when all layouts are null', () => {
    expect(computeCreateLayout([makeDashlet({ layout: null })], makeContent(), 'id').y).toBe(0);
  });

  it('clamps width and height', () => {
    const layoutFor = (content: Partial<CustomCodeContent>): DashletLayout =>
      computeCreateLayout([], makeContent(content), 'id');

    expect(layoutFor({ min_w: 1 }).w).toBe(2);
    expect(layoutFor({ min_w: 20 }).w).toBe(12);
    expect(layoutFor({ max_w: 4 }).w).toBe(4);
    expect(layoutFor({}).w).toBe(6);
    expect(layoutFor({}).h).toBe(3);
    expect(layoutFor({ max_h: 2 }).h).toBe(2);
    expect(layoutFor({ min_h: 0 }).h).toBe(1);
    expect(layoutFor({ min_h: 200 }).h).toBe(99);
  });

  it('starts at default_w and default_h when set', () => {
    const layout = computeCreateLayout(
      [],
      makeContent({ min_w: 3, min_h: 3, default_w: 6, default_h: 4 }),
      'id',
    );

    expect(layout).toStrictEqual({ i: 'id', x: 0, y: 0, w: 6, h: 4 });
  });

  it('clamps the defaults into min and max, then into the grid', () => {
    const layoutFor = (content: Partial<CustomCodeContent>): DashletLayout =>
      computeCreateLayout([], makeContent(content), 'id');

    expect(layoutFor({ min_w: 4, default_w: 2 }).w).toBe(4);
    expect(layoutFor({ max_w: 5, default_w: 9 }).w).toBe(5);
    expect(layoutFor({ default_w: 1 }).w).toBe(2);
    expect(layoutFor({ default_w: 20 }).w).toBe(12);
    expect(layoutFor({ max_w: 20, default_w: 16 }).w).toBe(12);
    expect(layoutFor({ min_h: 3, default_h: 2 }).h).toBe(3);
    expect(layoutFor({ max_h: 4, default_h: 8 }).h).toBe(4);
    expect(layoutFor({ default_h: 12 }).h).toBe(12);
    expect(layoutFor({ default_h: 150 }).h).toBe(99);
    expect(layoutFor({ max_h: 200, default_h: 150 }).h).toBe(99);
  });

  it('matches the previous min-based sizing for every valid min/max pair when no default is set', () => {
    const range = (to: number): number[] => Array.from({ length: to }, (_, index) => index + 1);
    const validPairs = (values: number[]): [number | undefined, number | undefined][] => {
      const options = [undefined, ...values];

      return options.flatMap((min) =>
        options
          .filter((max) => min === undefined || max === undefined || min <= max)
          .map((max): [number | undefined, number | undefined] => [min, max]),
      );
    };

    const widthPairs = validPairs(range(13));
    const heightPairs = validPairs(range(100));

    for (const [min, max] of widthPairs) {
      const content = makeContent({
        ...(min === undefined ? {} : { min_w: min }),
        ...(max === undefined ? {} : { max_w: max }),
      });
      const previous = Math.min(Math.max(Math.min(min ?? 6, max ?? 12), 2), 12);

      expect({ min, max, w: computeCreateLayout([], content, 'id').w }).toStrictEqual({
        min,
        max,
        w: previous,
      });
    }

    for (const [min, max] of heightPairs) {
      const content = makeContent({
        ...(min === undefined ? {} : { min_h: min }),
        ...(max === undefined ? {} : { max_h: max }),
      });
      const previous = Math.min(Math.max(Math.min(min ?? 3, max ?? 99), 1), 99);

      expect({ min, max, h: computeCreateLayout([], content, 'id').h }).toStrictEqual({
        min,
        max,
        h: previous,
      });
    }

    expect(widthPairs).toHaveLength(1 + 13 + 13 + (13 * 14) / 2);
    expect(heightPairs).toHaveLength(1 + 100 + 100 + (100 * 101) / 2);
  });
});

describe('buildUpdateBody', () => {
  const existing = makeDashlet({
    name: 'appbuilder:acme/sales_widget',
    config: {
      object_id: 'obj-existing',
      entity_type: 'static_content',
      report_type: 'html',
      chart_type: 'html',
      extra_key: { nested: true },
      custom_object: 'should-be-stripped',
      content: makeContent({ script: 'old();' }),
      fe_extra_info: {
        custom_styles_enabled: false,
        theme: 'dark',
        dashlet_style_config: { drop_shadow: true, border: 'thin' },
      },
    },
  });

  it('keeps existing config and carries stored style keys over untouched', () => {
    const content = makeContent({ script: 'new();' });
    const body = buildUpdateBody(existing, content);

    expect(body).toStrictEqual({
      config: {
        object_id: 'obj-existing',
        entity_type: 'static_content',
        report_type: 'html',
        chart_type: 'html',
        extra_key: { nested: true },
        content,
        fe_extra_info: {
          custom_styles_enabled: false,
          theme: 'dark',
          dashlet_style_config: { drop_shadow: true, border: 'thin' },
        },
      },
    });
    expect(Object.keys(body)).toStrictEqual(['config']);
    expect(JSON.stringify(body)).not.toContain('custom_object');
  });

  it('never sends a layout, even when the content carries default sizes', () => {
    const content = makeContent({ default_w: 6, default_h: 4 });
    const body = buildUpdateBody(existing, content);

    expect(Object.keys(body)).toStrictEqual(['config']);
    expect(body.config.content).toStrictEqual(content);
  });

  it('adds no style keys when nothing exists', () => {
    const body = buildUpdateBody(makeDashlet({ config: null }), makeContent());

    expect(body).toStrictEqual({ config: { content: makeContent() } });
  });

  const storedWith = (content: CustomCodeContent): WireDashlet =>
    makeDashlet({ config: customCodeConfig(content) });

  it('replaces stored host_chrome false with true', () => {
    const body = buildUpdateBody(
      storedWith(makeContent({ host_chrome: false })),
      makeContent({ host_chrome: true }),
    );

    expect(body.config.content).toStrictEqual(makeContent({ host_chrome: true }));
  });

  it('replaces stored host_chrome true with false', () => {
    const body = buildUpdateBody(
      storedWith(makeContent({ host_chrome: true })),
      makeContent({ host_chrome: false }),
    );

    expect(body.config.content).toStrictEqual(makeContent({ host_chrome: false }));
  });

  it('drops a stored host_chrome when the new content no longer sets it', () => {
    const body = buildUpdateBody(storedWith(makeContent({ host_chrome: false })), makeContent());

    expect(body.config.content).toStrictEqual(makeContent());
    expect(Object.keys(body.config.content as object)).not.toContain('host_chrome');
  });
});

describe('custom-code detection', () => {
  it('detects html custom_code dashlets', () => {
    expect(isCustomCodeDashlet(makeDashlet())).toBe(true);
  });

  it('rejects null or malformed config and content', () => {
    expect(isCustomCodeDashlet(makeDashlet({ config: null }))).toBe(false);
    expect(isCustomCodeDashlet(makeDashlet({ config: { chart_type: 'html' } }))).toBe(false);
    expect(
      isCustomCodeDashlet(makeDashlet({ config: { chart_type: 'html', content: null } })),
    ).toBe(false);
    expect(
      isCustomCodeDashlet(makeDashlet({ config: { chart_type: 'html', content: 'custom_code' } })),
    ).toBe(false);
    expect(
      isCustomCodeDashlet(makeDashlet({ config: 'nope' as unknown as Record<string, unknown> })),
    ).toBe(false);
  });

  it('rejects non-html charts and other content kinds', () => {
    expect(
      isCustomCodeDashlet(
        makeDashlet({ config: { chart_type: 'bar', content: { kind: 'custom_code' } } }),
      ),
    ).toBe(false);
    expect(
      isCustomCodeDashlet(
        makeDashlet({ config: { chart_type: 'html', content: { kind: 'plugin' } } }),
      ),
    ).toBe(false);
  });

  it('filters a dashboard down to custom-code dashlets', () => {
    const custom = makeDashlet({ id: 'a' });
    const other = makeDashlet({ id: 'b', config: { chart_type: 'bar' } });

    expect(findCustomCodeDashlets({ dashlets: [custom, other] })).toStrictEqual([custom]);
  });

  it('names a custom-code dashlet from its content, else the dashlet name', () => {
    expect(
      customCodeName(makeDashlet({ config: customCodeConfig(makeContent({ name: 'X' })) })),
    ).toBe('X');
    expect(customCodeName(makeDashlet({ name: 'Fallback', config: null }))).toBe('Fallback');
    expect(
      customCodeName(makeDashlet({ name: 'Fallback', config: { content: { name: 42 } } })),
    ).toBe('Fallback');
  });
});

describe('matchPushTarget', () => {
  const key = pushKey('acme', 'sales_widget');
  const base = { dashboardId: 'dash-1', pluginApiName: 'acme', blockApiName: 'sales_widget' };

  it('prefers the push map entry over a name match', () => {
    const mapped = makeDashlet({ id: 'mapped', name: 'Renamed by user' });
    const named = makeDashlet({ id: 'named', name: key });
    const entry = makeEntry({ dashletId: 'mapped' });

    expect(matchPushTarget({ ...base, dashlets: [named, mapped], entry })).toStrictEqual({
      kind: 'map',
      dashlet: mapped,
      entry,
    });
  });

  it('ignores a map entry for another dashboard', () => {
    const named = makeDashlet({ id: 'named', name: key });
    const entry = makeEntry({ dashboardId: 'dash-other', dashletId: 'named' });

    expect(matchPushTarget({ ...base, dashlets: [named], entry })).toStrictEqual({
      kind: 'name',
      dashlet: named,
    });
  });

  it('falls back to name when the mapped dashlet was deleted', () => {
    const named = makeDashlet({ id: 'named', name: key });
    const entry = makeEntry({ dashletId: 'deleted' });

    expect(matchPushTarget({ ...base, dashlets: [named], entry })).toStrictEqual({
      kind: 'name',
      dashlet: named,
    });
  });

  it('falls back to name when the mapped dashlet is no longer custom code', () => {
    const mapped = makeDashlet({ id: 'mapped', config: { chart_type: 'bar' } });
    const named = makeDashlet({ id: 'named', name: key });

    expect(
      matchPushTarget({
        ...base,
        dashlets: [mapped, named],
        entry: makeEntry({ dashletId: 'mapped' }),
      }),
    ).toStrictEqual({ kind: 'name', dashlet: named });
  });

  it('reports ambiguity for two same-name dashlets', () => {
    const first = makeDashlet({ id: 'a', name: key });
    const second = makeDashlet({ id: 'b', name: key });

    expect(matchPushTarget({ ...base, dashlets: [first, second], entry: undefined })).toStrictEqual(
      {
        kind: 'ambiguous',
        dashlets: [first, second],
      },
    );
  });

  it('ignores same-name dashlets that are not custom code', () => {
    const custom = makeDashlet({ id: 'a', name: key });
    const notCustom = makeDashlet({ id: 'b', name: key, config: null });

    expect(
      matchPushTarget({ ...base, dashlets: [custom, notCustom], entry: undefined }),
    ).toStrictEqual({ kind: 'name', dashlet: custom });
  });

  it('returns none when nothing matches', () => {
    expect(
      matchPushTarget({ ...base, dashlets: [makeDashlet({ name: 'other' })], entry: undefined }),
    ).toStrictEqual({ kind: 'none' });
    expect(matchPushTarget({ ...base, dashlets: [], entry: makeEntry() })).toStrictEqual({
      kind: 'none',
    });
  });
});

describe('canonicalContentHash', () => {
  it('is a sha256 hex digest', () => {
    expect(canonicalContentHash(makeContent())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key order', () => {
    const content = makeContent({ event_scripts: [{ name: 'a', script: 'b' }], min_w: 2 });
    const reordered = Object.fromEntries(Object.entries(content).reverse());

    expect(canonicalContentHash(reordered)).toBe(canonicalContentHash(content));
    expect(canonicalContentHash({ ...content, event_scripts: [{ script: 'b', name: 'a' }] })).toBe(
      canonicalContentHash(content),
    );
  });

  it('matches between block content and wire content', () => {
    const content = toCustomCodeContent(makeBlock());
    const wire = {
      ...JSON.parse(JSON.stringify(content)),
      extra_server_key: 'ignored',
      version: 7,
      kind: 'other',
    } as Record<string, unknown>;

    expect(canonicalContentHash(wire)).toBe(canonicalContentHash(content));
  });

  it('accepts event scripts as a record', () => {
    const content = toCustomCodeContent(makeBlock());

    expect(canonicalContentHash({ ...content, event_scripts: makeBlock().event_scripts })).toBe(
      canonicalContentHash(content),
    );
  });

  it('trims the name and defaults styles to empty', () => {
    const content = makeContent({ name: 'Block', styles: '' });
    const withoutStyles: Record<string, unknown> = { ...content };

    delete withoutStyles.styles;

    expect(canonicalContentHash({ ...content, name: '  Block  ' })).toBe(
      canonicalContentHash(content),
    );
    expect(canonicalContentHash(withoutStyles)).toBe(canonicalContentHash(content));
  });

  it('changes when the script changes', () => {
    expect(canonicalContentHash(makeContent({ script: 'a();' }))).not.toBe(
      canonicalContentHash(makeContent({ script: 'b();' })),
    );
  });

  it('changes when dimensions change', () => {
    expect(canonicalContentHash(makeContent({ min_w: 2 }))).not.toBe(
      canonicalContentHash(makeContent()),
    );
  });

  it('changes when default sizes change', () => {
    expect(canonicalContentHash(makeContent({ default_w: 6 }))).not.toBe(
      canonicalContentHash(makeContent()),
    );
    expect(canonicalContentHash(makeContent({ default_h: 4 }))).not.toBe(
      canonicalContentHash(makeContent({ default_h: 5 })),
    );
  });

  it('keeps the previous hash for content without default sizes', () => {
    const content = makeContent({ min_w: 3, max_w: 8, min_h: 2, max_h: 6 });
    const previous = createHash('sha256')
      .update(
        JSON.stringify({
          event_scripts: [],
          max_h: 6,
          max_w: 8,
          min_h: 2,
          min_w: 3,
          name: 'Block',
          script: 'run();',
          styles: '',
        }),
      )
      .digest('hex');

    expect(canonicalContentHash(content)).toBe(previous);
  });

  it('keeps the pre-host_chrome hash for content without host_chrome', () => {
    const content = {
      kind: 'custom_code',
      version: 1,
      name: 'Hero',
      script: 'root.textContent = "hi";',
      styles: '.a{color:red}',
      event_scripts: [{ name: 'refresh', script: 'x()' }],
      min_w: 2,
      default_w: 4,
    };

    expect(canonicalContentHash(content)).toBe(
      '0e110f94d4e19a28dad53c67307c77a8f1b12c5ded696d9272c0ee35b99edaff',
    );
  });

  it('changes when host_chrome is set, and differs between true and false', () => {
    const absent = canonicalContentHash(makeContent());
    const off = canonicalContentHash(makeContent({ host_chrome: false }));
    const on = canonicalContentHash(makeContent({ host_chrome: true }));

    expect(off).not.toBe(absent);
    expect(on).not.toBe(absent);
    expect(on).not.toBe(off);
  });

  it.each(['false', 0, null])('ignores a non-boolean host_chrome of %o', (hostChrome) => {
    expect(canonicalContentHash({ ...makeContent(), host_chrome: hostChrome })).toBe(
      canonicalContentHash(makeContent()),
    );
  });

  it('hashes non-object input as the defaults', () => {
    const defaults = canonicalContentHash({});

    expect(canonicalContentHash(null)).toBe(defaults);
    expect(canonicalContentHash('text')).toBe(defaults);
    expect(canonicalContentHash([1, 2])).toBe(defaults);
  });
});

describe('detectDrift', () => {
  const content = makeContent({ script: 'pushed();' });
  const dashlet = makeDashlet({ config: customCodeConfig(content) });
  const hash = canonicalContentHash(content);

  it('is false when the dashlet content matches the recorded hash', () => {
    expect(detectDrift(dashlet, makeEntry({ contentHash: hash }))).toBe(false);
  });

  it('is true when the dashlet content was edited', () => {
    const edited = makeDashlet({
      config: customCodeConfig(makeContent({ script: 'edited();' })),
    });

    expect(detectDrift(edited, makeEntry({ contentHash: hash }))).toBe(true);
  });

  it('is false for a dashlet pushed with packager-filled sizes when the local block now has authored sizes only', () => {
    const previouslyPushed = makeContent({ min_w: 1, max_w: 12, min_h: 1, max_h: 12 });
    const stored = makeDashlet({ config: customCodeConfig(previouslyPushed) });
    const entry = makeEntry({ contentHash: canonicalContentHash(previouslyPushed) });
    const authoredNow = makeContent({ default_w: 6 });

    expect(canonicalContentHash(authoredNow)).not.toBe(entry.contentHash);
    expect(detectDrift(stored, entry)).toBe(false);
  });

  it('is false for a dashlet holding the content sent with host_chrome false', () => {
    const sent = toCustomCodeContent({
      ...makeBlock(),
      host_chrome: false,
    } as unknown as Block);
    const stored = makeDashlet({
      config: customCodeConfig(JSON.parse(JSON.stringify(sent)) as unknown),
    });

    expect(sent.host_chrome).toBe(false);
    expect(detectDrift(stored, makeEntry({ contentHash: canonicalContentHash(sent) }))).toBe(false);
  });

  it('is true when host_chrome was changed in Kizen since the push', () => {
    const sent = makeContent({ host_chrome: false });
    const entry = makeEntry({ contentHash: canonicalContentHash(sent) });

    expect(detectDrift(makeDashlet({ config: customCodeConfig(makeContent()) }), entry)).toBe(true);
    expect(
      detectDrift(
        makeDashlet({ config: customCodeConfig(makeContent({ host_chrome: true })) }),
        entry,
      ),
    ).toBe(true);
  });

  it('is false with no entry or a different dashlet', () => {
    expect(detectDrift(dashlet, undefined)).toBe(false);
    expect(detectDrift(dashlet, makeEntry({ dashletId: 'other', contentHash: 'x' }))).toBe(false);
  });
});

describe('push map entries', () => {
  const key = {
    environment: 'staging',
    businessId: 'biz-1',
    pluginApiName: 'acme',
    blockApiName: 'sales_widget',
  };

  it('upserts by environment, business, plugin and block', () => {
    const original = makeEntry({ contentHash: 'old' });
    const otherBusiness = makeEntry({ businessId: 'biz-2' });
    const otherBlock = makeEntry({ blockApiName: 'other' });
    const replacement = makeEntry({ contentHash: 'new', dashletId: 'dashlet-2' });
    const entries = [otherBusiness, original, otherBlock];

    const updated = upsertPushMapEntry(entries, replacement);

    expect(updated).toStrictEqual([otherBusiness, replacement, otherBlock]);
    expect(entries).toStrictEqual([otherBusiness, original, otherBlock]);
    expect(findPushMapEntry(updated, key)).toBe(replacement);
  });

  it('appends when no entry has the key', () => {
    const existing = makeEntry({ environment: 'prod' });
    const added = makeEntry();

    expect(upsertPushMapEntry([existing], added)).toStrictEqual([existing, added]);
  });

  it('finds nothing for a missing key', () => {
    expect(findPushMapEntry([makeEntry({ environment: 'prod' })], key)).toBeUndefined();
  });

  it('removes only the matching entry', () => {
    const kept = makeEntry({ environment: 'prod' });

    expect(removePushMapEntry([makeEntry(), kept], key)).toStrictEqual([kept]);
  });
});

describe('push map file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'push-map-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a missing file as empty', async () => {
    expect(PUSH_MAP_RELATIVE_PATH).toBe('.kizenapp/pushes.json');
    await expect(readPushMap(dir)).resolves.toStrictEqual([]);
  });

  it('reads a missing .kizenapp directory as empty', async () => {
    await expect(readPushMap(join(dir, 'nested'))).resolves.toStrictEqual([]);
  });

  it('throws on invalid JSON, naming the push map', async () => {
    await mkdir(join(dir, '.kizenapp'), { recursive: true });
    await writeFile(join(dir, PUSH_MAP_RELATIVE_PATH), '{not json', 'utf8');

    await expect(readPushMap(dir)).rejects.toThrow(
      /^\.kizenapp\/pushes\.json is not valid JSON \(.+\)\. Fix it, or delete it/,
    );
  });

  it.each(['{"a":1}', 'null', '"entries"'])('throws on a non-array top level %s', async (raw) => {
    await mkdir(join(dir, '.kizenapp'), { recursive: true });
    await writeFile(join(dir, PUSH_MAP_RELATIVE_PATH), raw, 'utf8');

    await expect(readPushMap(dir)).rejects.toThrow(
      '.kizenapp/pushes.json must contain a JSON array of push entries.',
    );
  });

  it('throws when the push map exists but cannot be read', async () => {
    await mkdir(join(dir, PUSH_MAP_RELATIVE_PATH), { recursive: true });

    await expect(readPushMap(dir)).rejects.toThrow(/^Couldn't read \.kizenapp\/pushes\.json: /);
  });

  it('drops entries missing required string fields', async () => {
    const valid = makeEntry();
    const missingHash: Record<string, unknown> = { ...makeEntry({ blockApiName: 'x' }) };

    delete missingHash.contentHash;

    await mkdir(join(dir, '.kizenapp'), { recursive: true });
    await writeFile(
      join(dir, PUSH_MAP_RELATIVE_PATH),
      JSON.stringify([valid, missingHash, null, 'str', { ...valid, dashletId: 5 }]),
      'utf8',
    );

    await expect(readPushMap(dir)).resolves.toStrictEqual([valid]);
  });

  it('matches a stored CRLF-padded businessId to a trimmed key and re-saves it clean', async () => {
    const stale = { ...makeEntry(), businessId: 'biz-1\r\r' };
    const key = {
      environment: 'staging',
      businessId: 'biz-1',
      pluginApiName: 'acme',
      blockApiName: 'sales_widget',
    };

    await mkdir(join(dir, '.kizenapp'), { recursive: true });
    await writeFile(join(dir, PUSH_MAP_RELATIVE_PATH), JSON.stringify([stale]), 'utf8');

    const entries = await readPushMap(dir);
    const found = findPushMapEntry(entries, key);

    expect(found?.businessId).toBe('biz-1');
    expect(found?.dashletId).toBe('dashlet-1');

    const updated = upsertPushMapEntry(entries, makeEntry({ contentHash: 'new' }));

    expect(updated).toHaveLength(1);

    await writePushMap(dir, updated);

    const raw = await readFile(join(dir, PUSH_MAP_RELATIVE_PATH), 'utf8');
    const saved = JSON.parse(raw) as PushMapEntry[];

    expect(raw).not.toContain('\\r');
    expect(saved).toStrictEqual([makeEntry({ contentHash: 'new' })]);
  });

  it('keeps only the latest pushedAt when entries collide after normalizing businessId', async () => {
    const older = makeEntry({ dashletId: 'old', pushedAt: '2026-09-20T00:00:00.000Z' });
    const newest = {
      ...makeEntry({ dashletId: 'newest', pushedAt: '2026-09-26T00:00:00.000Z' }),
      businessId: 'biz-1\r\r',
    };
    const middle = {
      ...makeEntry({ dashletId: 'middle', pushedAt: '2026-09-23T00:00:00.000Z' }),
      businessId: ' biz-1\n',
    };
    const otherBlock = makeEntry({ blockApiName: 'other', pushedAt: '2026-09-01T00:00:00.000Z' });

    await mkdir(join(dir, '.kizenapp'), { recursive: true });
    await writeFile(
      join(dir, PUSH_MAP_RELATIVE_PATH),
      JSON.stringify([older, newest, otherBlock, middle]),
      'utf8',
    );

    await expect(readPushMap(dir)).resolves.toStrictEqual([
      makeEntry({ dashletId: 'newest', pushedAt: '2026-09-26T00:00:00.000Z' }),
      otherBlock,
    ]);
  });

  it('round-trips entries through write and read', async () => {
    const entries = [makeEntry(), makeEntry({ environment: 'prod', dashletId: 'd2' })];

    await writePushMap(dir, entries);

    const raw = await readFile(join(dir, PUSH_MAP_RELATIVE_PATH), 'utf8');

    expect(raw).toBe(`${JSON.stringify(entries, null, 2)}\n`);
    await expect(readPushMap(dir)).resolves.toStrictEqual(entries);
  });
});

describe('surfaces', () => {
  it('maps dashboard types to surfaces and back', () => {
    expect(dashboardTypeToSurface('generic_dashboard')).toBe('dashboard');
    expect(dashboardTypeToSurface('homepage')).toBe('homepage');
    expect(dashboardTypeToSurface('chart_group')).toBe('chart_group');
    expect(surfaceToDashboardType('dashboard')).toBe('generic_dashboard');
    expect(surfaceToDashboardType('homepage')).toBe('homepage');
    expect(surfaceToDashboardType('chart_group')).toBe('chart_group');
  });
});

describe('buildDashboardUrl', () => {
  const appBaseUrl = 'https://app.kizen.com/';

  it('builds dashboard and homepage urls', () => {
    expect(buildDashboardUrl({ appBaseUrl, surface: 'dashboard', dashboardId: 'd1' })).toBe(
      'https://app.kizen.com/dashboard/d1',
    );
    expect(buildDashboardUrl({ appBaseUrl, surface: 'homepage', dashboardId: 'h1' })).toBe(
      'https://app.kizen.com/home/h1',
    );
  });

  it('builds custom object and client chart group urls', () => {
    expect(
      buildDashboardUrl({
        appBaseUrl,
        surface: 'chart_group',
        dashboardId: 'c1',
        customObject: { id: 'obj-1', fetchUrl: 'deals' },
      }),
    ).toBe('https://app.kizen.com/custom-objects/obj-1/charts/c1');
    expect(
      buildDashboardUrl({
        appBaseUrl,
        surface: 'chart_group',
        dashboardId: 'c1',
        customObject: { id: 'obj-1' },
      }),
    ).toBe('https://app.kizen.com/custom-objects/obj-1/charts/c1');
    expect(
      buildDashboardUrl({
        appBaseUrl,
        surface: 'chart_group',
        dashboardId: 'c2',
        customObject: { id: 'contacts', fetchUrl: 'client' },
      }),
    ).toBe('https://app.kizen.com/clients/charts/c2');
  });

  it('falls back to the dashboard url for a chart group with no custom object', () => {
    expect(
      buildDashboardUrl({
        appBaseUrl,
        surface: 'chart_group',
        dashboardId: 'c3',
        customObject: null,
      }),
    ).toBe('https://app.kizen.com/dashboard/c3');
    expect(
      buildDashboardUrl({
        appBaseUrl: 'https://x.test',
        surface: 'chart_group',
        dashboardId: 'c4',
      }),
    ).toBe('https://x.test/dashboard/c4');
  });
});

const makeRoutablePage = (overrides: Partial<RoutablePage> = {}): RoutablePage => ({
  name: 'Detail',
  api_name: 'detail_view',
  type: 'script',
  css: '.d{color:red}',
  event_scripts: { close: 'this.closeModal();', save: 'save();' },
  callback: '',
  is_toolbar_item: false,
  toolbar_color: '',
  toolbar_icon: '',
  script: 'this.outputUI("detail");',
  html: '',
  iframe_url: '',
  ...overrides,
});

describe('custom_code views', () => {
  it('view_event_scripts_are_an_array', () => {
    const view = toCustomCodeView(makeRoutablePage());
    const content = toCustomCodeContent(makeBlock(), [makeRoutablePage()]);
    const wire = JSON.parse(JSON.stringify(content)) as { views: { event_scripts: unknown }[] };

    expect(view).toStrictEqual({
      api_name: 'detail_view',
      name: 'Detail',
      type: 'script',
      script: 'this.outputUI("detail");',
      css: '.d{color:red}',
      event_scripts: [
        { name: 'close', script: 'this.closeModal();' },
        { name: 'save', script: 'save();' },
      ],
    });
    expect(Array.isArray(view.event_scripts)).toBe(true);
    expect(wire.views.every((entry) => Array.isArray(entry.event_scripts))).toBe(true);
    expect(toCustomCodeView(makeRoutablePage({ event_scripts: {} })).event_scripts).toStrictEqual(
      [],
    );
  });

  it('carries html views with html and without an empty script or css', () => {
    expect(
      toCustomCodeView(makeRoutablePage({ type: 'html', script: '', css: '', html: '<p>x</p>' })),
    ).toStrictEqual({
      api_name: 'detail_view',
      name: 'Detail',
      type: 'html',
      html: '<p>x</p>',
      event_scripts: [
        { name: 'close', script: 'this.closeModal();' },
        { name: 'save', script: 'save();' },
      ],
    });
  });

  it('content_without_views_is_unchanged_and_hash_stable', () => {
    // Fixture and expected values were produced by the pre-views toCustomCodeContent and
    // canonicalContentHash (src/lib/pushBlock.ts at bcd37de), so they pin the old output.
    const block = {
      name: 'Block',
      api_name: 'block',
      min_w: 1,
      max_w: 12,
      min_h: 1,
      max_h: 12,
      event_scripts: { greet: 'x()' },
      script: 'this.outputUI("hi");',
      styles: '.a{}',
      when: '',
    } as Block;
    const oldJson =
      '{"kind":"custom_code","version":1,"name":"Block","script":"this.outputUI(\\"hi\\");","styles":".a{}","event_scripts":[{"name":"greet","script":"x()"}],"min_w":1,"max_w":12,"min_h":1,"max_h":12}';
    const oldHash = '9827adffe1804abb50b298a5b6cbdbb06f363112046009da0736ea76048b9755';

    expect(JSON.stringify(toCustomCodeContent(block))).toBe(oldJson);
    expect(JSON.stringify(toCustomCodeContent(block, []))).toBe(oldJson);
    expect(Object.keys(toCustomCodeContent(block, []))).not.toContain('views');
    expect(canonicalContentHash(toCustomCodeContent(block))).toBe(oldHash);
    expect(canonicalContentHash(JSON.parse(oldJson))).toBe(oldHash);
    expect(canonicalContentHash({ ...JSON.parse(oldJson), views: [] })).toBe(oldHash);
    expect(
      detectDrift(
        makeDashlet({ config: customCodeConfig(JSON.parse(oldJson)) }),
        makeEntry({ contentHash: oldHash }),
      ),
    ).toBe(false);
  });

  it('views_change_changes_drift_hash', () => {
    const withView = toCustomCodeContent(makeBlock(), [makeRoutablePage()]);
    const hash = canonicalContentHash(withView);
    const changed = (overrides: Partial<RoutablePage>): string =>
      canonicalContentHash(toCustomCodeContent(makeBlock(), [makeRoutablePage(overrides)]));

    expect(hash).not.toBe(canonicalContentHash(toCustomCodeContent(makeBlock())));
    expect(changed({ script: 'other();' })).not.toBe(hash);
    expect(changed({ css: '' })).not.toBe(hash);
    expect(changed({ api_name: 'renamed' })).not.toBe(hash);
    expect(changed({ event_scripts: { close: 'changed();' } })).not.toBe(hash);
    expect(
      canonicalContentHash(
        toCustomCodeContent(makeBlock(), [makeRoutablePage(), makeRoutablePage({ api_name: 'b' })]),
      ),
    ).not.toBe(hash);

    const edited = {
      ...withView,
      views: withView.views?.map((view) => ({ ...view, script: 'edited_in_kizen();' })),
    };

    expect(
      detectDrift(
        makeDashlet({ config: customCodeConfig(edited) }),
        makeEntry({ contentHash: hash }),
      ),
    ).toBe(true);
    expect(
      detectDrift(
        makeDashlet({ config: customCodeConfig(JSON.parse(JSON.stringify(withView))) }),
        makeEntry({ contentHash: hash }),
      ),
    ).toBe(false);
  });

  it('hashes views the same across key order, event_scripts shape and empty optional strings', () => {
    const withView = toCustomCodeContent(makeBlock(), [
      makeRoutablePage({ type: 'html', script: '', html: '<p/>' }),
    ]);
    const [view] = withView.views ?? [];
    const reshaped = {
      ...withView,
      views: [
        {
          event_scripts: { close: 'this.closeModal();', save: 'save();' },
          script: '',
          css: view?.css,
          html: view?.html,
          type: view?.type,
          name: view?.name,
          api_name: view?.api_name,
        },
      ],
    };

    expect(canonicalContentHash(reshaped)).toBe(canonicalContentHash(withView));
  });
});
