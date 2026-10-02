import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginValidationError } from '@kizenapps/packager';
import type { Block, DeployablePlugin, FileContent, RoutablePage } from '@kizenapps/packager';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlugin } from './createPlugin.js';
import {
  BlockExportError,
  applyAuthoredConfig,
  collectViews,
  exportBlock,
  findInvalidViewField,
  findInvalidBlockField,
  formatAvailableBlocks,
  packageBlocks,
  resolvePackagedBlock,
  selectBlock,
  toExportJson,
} from './exportBlock.js';
import { computeCreateLayout, toCustomCodeContent } from './pushBlock.js';
import { packageLocalPlugin } from './runBuild.js';
import { makePlugin, routablePage } from '../test/fixtures.js';

const PLUGIN_API_NAME = 'acme_widgets';

const makeBlock = (overrides: Partial<Block> = {}): Block => ({
  name: 'Block',
  api_name: 'block',
  min_w: 1,
  max_w: 12,
  min_h: 1,
  max_h: 12,
  event_scripts: {},
  script: 'this.outputUI("hi");',
  styles: '',
  when: '',
  ...overrides,
});

describe('selectBlock', () => {
  it('reports ambiguity when the same api_name exists in more than one plugin', () => {
    const selection = selectBlock(
      [
        makePlugin('first', [makeBlock({ api_name: 'shared' })]),
        makePlugin('second', [makeBlock({ api_name: 'shared' }), makeBlock({ api_name: 'other' })]),
      ],
      'shared',
    );

    expect(selection).toStrictEqual({
      ok: false,
      reason: 'ambiguous',
      available: [
        { pluginApiName: 'first', apiName: 'shared' },
        { pluginApiName: 'second', apiName: 'shared' },
      ],
    });
  });

  it('selects a block by api_name across plugins', () => {
    const target = makeBlock({ api_name: 'other' });
    const selection = selectBlock(
      [makePlugin('first', [makeBlock()]), makePlugin('second', [target])],
      'other',
    );

    expect(selection).toStrictEqual({ ok: true, block: target, pluginApiName: 'second' });
  });
});

describe('resolvePackagedBlock', () => {
  const packagedWith = (
    blocks: Block[],
    views: RoutablePage[] = [],
  ): Parameters<typeof resolvePackagedBlock>[0] => ({
    deployable: [makePlugin('p', blocks)],
    views: { p: views },
    warnings: [],
  });
  const twoBlocks = packagedWith([makeBlock({ api_name: 'a' }), makeBlock({ api_name: 'b' })]);
  const available = [
    { pluginApiName: 'p', apiName: 'a' },
    { pluginApiName: 'p', apiName: 'b' },
  ];

  it('resolvePackagedBlock returns ambiguous listing available blocks when apiName is missing', () => {
    expect(resolvePackagedBlock(twoBlocks, undefined, 'export')).toStrictEqual({
      ok: false,
      reason: 'ambiguous',
      message: 'This plugin has several blocks; pass the api_name of the one to export: a, b',
      available,
    });
    expect(resolvePackagedBlock(twoBlocks, undefined, 'push')).toStrictEqual({
      ok: false,
      reason: 'ambiguous',
      message: 'This plugin has several blocks; pass the api_name of the one to push: a, b',
      available,
    });
  });

  it.each(['export', 'push'] as const)(
    'words not_found, no_blocks and a cross-plugin clash the same for %s',
    (verb) => {
      expect(resolvePackagedBlock(twoBlocks, 'missing', verb)).toStrictEqual({
        ok: false,
        reason: 'not_found',
        message: 'No block with api_name "missing". Available blocks: a, b',
        available,
      });
      expect(resolvePackagedBlock(packagedWith([]), undefined, verb)).toStrictEqual({
        ok: false,
        reason: 'no_blocks',
        message:
          'This plugin has no blocks. Scaffold one with `appbuilder create --artifacts block`.',
        available: [],
      });

      const clash = {
        deployable: [
          makePlugin('p', [makeBlock({ api_name: 'shared' })]),
          makePlugin('q', [makeBlock({ api_name: 'shared' })]),
        ],
        views: {},
        warnings: [],
      };

      expect(resolvePackagedBlock(clash, 'shared', verb)).toStrictEqual({
        ok: false,
        reason: 'ambiguous',
        message: 'More than one plugin has a block with api_name "shared": p/shared, q/shared',
        available: [
          { pluginApiName: 'p', apiName: 'shared' },
          { pluginApiName: 'q', apiName: 'shared' },
        ],
      });
    },
  );

  it('resolvePackagedBlock returns invalid_block with field for an invalid block', () => {
    expect(
      resolvePackagedBlock(packagedWith([makeBlock({ min_w: 0 })]), undefined, 'push'),
    ).toStrictEqual({
      ok: false,
      reason: 'invalid_block',
      message:
        'Block "block" has an invalid min_w: it must be a positive integer no greater than max_w.',
      available: [],
      field: 'min_w',
    });
    expect(
      resolvePackagedBlock(
        packagedWith([makeBlock()], [routablePage({ css: 'a{content:"\u0000"}' })]),
        undefined,
        'export',
      ),
    ).toStrictEqual({
      ok: false,
      reason: 'invalid_block',
      message:
        'Block "block" can\'t carry view "detail_view": its css must be a string without NUL characters or "{__ref:".',
      available: [],
      field: 'views.detail_view.css',
    });
  });

  it('returns the selected block with its plugin views and the packaging warnings', () => {
    const block = makeBlock({ api_name: 'b' });
    const view = routablePage({ script: 'v();' });
    const warning = { rule: 'r', severity: 'warning', message: 'm' } as const;
    const packaged = {
      ...packagedWith([makeBlock({ api_name: 'a' }), block], [view]),
      warnings: [warning],
    };

    expect(resolvePackagedBlock(packaged, 'b', 'push')).toStrictEqual({
      ok: true,
      value: { block, pluginApiName: 'p', views: [view], warnings: [warning] },
    });
  });
});

describe('formatAvailableBlocks', () => {
  it('prints bare api_names when a single plugin is involved', () => {
    expect(
      formatAvailableBlocks([
        { pluginApiName: 'p', apiName: 'a' },
        { pluginApiName: 'p', apiName: 'b' },
      ]),
    ).toBe('a, b');
  });

  it('prefixes the plugin api_name when several plugins are involved', () => {
    expect(
      formatAvailableBlocks([
        { pluginApiName: 'p', apiName: 'a' },
        { pluginApiName: 'q', apiName: 'a' },
      ]),
    ).toBe('p/a, q/a');
  });
});

describe('findInvalidBlockField', () => {
  it('accepts a well-formed block', () => {
    expect(findInvalidBlockField(makeBlock())).toBeUndefined();
  });

  it.each([
    ['script', { script: '   ' }],
    ['name', { name: 42 as unknown as string }],
    ['styles', { styles: 'a { content: "\u0000"; }' }],
    ['event_scripts', { event_scripts: [] as unknown as Block['event_scripts'] }],
    ['event_scripts.greet', { event_scripts: { greet: '{__ref:x}' } }],
    ['max_h', { max_h: 2.5 }],
    ['min_h', { min_h: 0 }],
  ] as const)('names %s', (field, overrides) => {
    expect(findInvalidBlockField(makeBlock(overrides as Partial<Block>))).toBe(field);
  });

  const withDefaults = (defaults: Record<string, unknown>, overrides: Partial<Block> = {}): Block =>
    ({ ...makeBlock(overrides), ...defaults }) as Block;

  it.each([
    ['default_w', { default_w: 0 }],
    ['default_w', { default_w: -3 }],
    ['default_w', { default_w: 2.5 }],
    ['default_w', { default_w: '6' }],
    ['default_w', { default_w: null }],
    ['default_h', { default_h: 0 }],
    ['default_h', { default_h: 1.5 }],
    ['default_h', { default_h: '4' }],
  ] as const)('names %s when it is not a positive integer: %o', (field, defaults) => {
    expect(findInvalidBlockField(withDefaults(defaults))).toBe(field);
  });

  it.each([
    ['default_w', { default_w: 2 }, { min_w: 3 }],
    ['default_w', { default_w: 13 }, { min_w: 3 }],
    ['default_w', { default_w: 9 }, { max_w: 8 }],
    ['default_h', { default_h: 2 }, { min_h: 3 }],
    ['default_h', { default_h: 7 }, { max_h: 6 }],
  ] as const)('names %s when it falls outside min and max: %o %o', (field, defaults, bounds) => {
    expect(findInvalidBlockField(withDefaults(defaults, bounds))).toBe(field);
  });

  it('accepts defaults on and between the bounds', () => {
    const bounds = { min_w: 3, max_w: 8, min_h: 2, max_h: 6 };

    expect(findInvalidBlockField(withDefaults({ default_w: 3, default_h: 2 }, bounds))).toBe(
      undefined,
    );
    expect(findInvalidBlockField(withDefaults({ default_w: 8, default_h: 6 }, bounds))).toBe(
      undefined,
    );
    expect(findInvalidBlockField(withDefaults({ default_w: 5, default_h: 4 }, bounds))).toBe(
      undefined,
    );
  });

  it('checks only the bounds that are present', () => {
    const block = withDefaults({ default_w: 20, default_h: 50 }) as unknown as Record<
      string,
      unknown
    >;

    delete block.max_w;
    delete block.max_h;

    expect(findInvalidBlockField(block as unknown as Block)).toBeUndefined();
  });

  it.each([
    ['min_w', { min_w: 9, max_w: 8 }],
    ['min_h', { min_h: 7, max_h: 6 }],
  ] as const)('names %s when min exceeds max: %o', (field, overrides) => {
    expect(findInvalidBlockField(makeBlock(overrides))).toBe(field);
  });

  it('accepts min equal to max', () => {
    expect(findInvalidBlockField(makeBlock({ min_w: 4, max_w: 4, min_h: 3, max_h: 3 }))).toBe(
      undefined,
    );
  });

  it('checks min against max only when both are present', () => {
    const block = makeBlock({ min_w: 20, min_h: 20 }) as unknown as Record<string, unknown>;

    delete block.max_w;
    delete block.max_h;

    expect(findInvalidBlockField(block as unknown as Block)).toBeUndefined();
  });

  it('reports an invalid dimension before an out-of-range default', () => {
    expect(findInvalidBlockField(withDefaults({ default_w: 2 }, { min_w: 0 }))).toBe('min_w');
  });

  it.each([true, false])('accepts host_chrome %o', (hostChrome) => {
    expect(findInvalidBlockField(withDefaults({ host_chrome: hostChrome }))).toBeUndefined();
  });

  it.each(['false', 'true', 0, 1, null, {}, []])(
    'names host_chrome when it is not a boolean: %o',
    (hostChrome) => {
      expect(findInvalidBlockField(withDefaults({ host_chrome: hostChrome }))).toBe('host_chrome');
    },
  );

  it.each([
    ['script', { host_chrome: 'false' }, { script: '' }],
    ['styles', { host_chrome: 0 }, { styles: 'a { content: "\u0000"; }' }],
    ['min_w', { host_chrome: null }, { min_w: 0 }],
    ['min_h', { host_chrome: 'false' }, { min_h: 7, max_h: 6 }],
    ['default_w', { host_chrome: 'false', default_w: 20 }, { max_w: 8 }],
  ] as const)(
    'reports an earlier invalid field (%s) before an invalid host_chrome',
    (field, extra, overrides) => {
      expect(findInvalidBlockField(withDefaults(extra, overrides as Partial<Block>))).toBe(field);
    },
  );
});

const SIZE_KEYS = ['min_w', 'max_w', 'min_h', 'max_h', 'default_w', 'default_h'];

const withoutSizes = (block: Block | undefined): Record<string, unknown> =>
  Object.fromEntries(Object.entries(block ?? {}).filter(([key]) => !SIZE_KEYS.includes(key)));

describe('applyAuthoredConfig', () => {
  const file = (path: string, content: unknown): FileContent => ({
    path,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  });
  const packaged = (apiName: string): Block => makeBlock({ api_name: apiName });

  it('replaces the packager-filled sizes with exactly the authored ones, per plugin entry and resolved api_name', () => {
    const files = [
      file('kizen.json', [
        { api_name: 'first', entry: 'first/src' },
        { api_name: 'second', entry: 'second/src/' },
      ]),
      file('first/src/blocks/Sales Tile/config.json', { name: 'Tile', default_w: 3, default_h: 2 }),
      file('first/src/blocks/chart/config.json', {
        name: 'Chart',
        api_name: 'revenue_chart',
        min_w: 4,
        default_w: 6,
      }),
      file('first/src/blocks/plain/config.json', { name: 'Plain' }),
      file('second/src/blocks/Sales Tile/config.json', { name: 'Tile', max_h: 20, default_h: 5 }),
      file('second/src/blocks/Sales Tile/nested/config.json', { default_w: 11 }),
    ];
    const deployable = [
      makePlugin('first', [packaged('sales_tile'), packaged('revenue_chart'), packaged('plain')]),
      makePlugin('second', [packaged('sales_tile')]),
    ];

    const [first, second] = applyAuthoredConfig(deployable, files);

    expect(first?.artifacts.custom_blocks).toStrictEqual([
      { ...withoutSizes(packaged('sales_tile')), default_w: 3, default_h: 2 },
      { ...withoutSizes(packaged('revenue_chart')), min_w: 4, default_w: 6 },
      withoutSizes(packaged('plain')),
    ]);
    expect(second?.artifacts.custom_blocks).toStrictEqual([
      { ...withoutSizes(packaged('sales_tile')), max_h: 20, default_h: 5 },
    ]);
  });

  it('keeps invalid authored values so validation can reject them', () => {
    const files = [
      file('kizen.json', { api_name: 'p', entry: 'src' }),
      file('src/blocks/tile/config.json', { min_w: 0, default_w: '6' }),
    ];
    const [plugin] = applyAuthoredConfig([makePlugin('p', [packaged('tile')])], files);
    const blocks = plugin?.artifacts.custom_blocks ?? [];

    expect(blocks[0]).toHaveProperty('min_w', 0);
    expect(blocks[0]).toHaveProperty('default_w', '6');
    expect(blocks.map(findInvalidBlockField)).toStrictEqual(['min_w']);
  });

  it('overlays the authored host_chrome, including a non-boolean for validation to reject, and omits it when not authored', () => {
    const files = [
      file('kizen.json', { api_name: 'p', entry: 'src' }),
      file('src/blocks/off/config.json', { api_name: 'off', host_chrome: false }),
      file('src/blocks/on/config.json', { api_name: 'on', host_chrome: true }),
      file('src/blocks/unset/config.json', { api_name: 'unset', default_w: 4 }),
      file('src/blocks/nulled/config.json', { api_name: 'nulled', host_chrome: null }),
    ];
    const packagedWithChrome = (apiName: string): Block =>
      ({ ...packaged(apiName), host_chrome: 'packager' }) as unknown as Block;
    const [plugin] = applyAuthoredConfig(
      [
        makePlugin('p', [
          packaged('off'),
          packaged('on'),
          packagedWithChrome('unset'),
          packaged('nulled'),
        ]),
      ],
      files,
    );
    const blocks = plugin?.artifacts.custom_blocks ?? [];

    expect(blocks).toStrictEqual([
      { ...withoutSizes(packaged('off')), host_chrome: false },
      { ...withoutSizes(packaged('on')), host_chrome: true },
      { ...withoutSizes(packaged('unset')), default_w: 4 },
      { ...withoutSizes(packaged('nulled')), host_chrome: null },
    ]);
    expect(blocks.map(findInvalidBlockField)).toStrictEqual([
      undefined,
      undefined,
      undefined,
      'host_chrome',
    ]);
  });

  const authoredSizesFor = (entry: string, configPath: string): Block[] => {
    const files = [
      file('kizen.json', { api_name: 'p', entry }),
      file(configPath, { api_name: 'tile', min_w: 3, default_w: 6 }),
    ];
    const [plugin] = applyAuthoredConfig([makePlugin('p', [packaged('tile')])], files);

    return plugin?.artifacts.custom_blocks ?? [];
  };

  it("exportBlock keeps authored sizes when entry is './src'", () => {
    expect(authoredSizesFor('./src', 'src/blocks/tile/config.json')).toStrictEqual([
      { ...withoutSizes(packaged('tile')), min_w: 3, default_w: 6 },
    ]);
  });

  it.each([
    ['src', 'src/blocks/tile/config.json'],
    ['./src', 'src/blocks/tile/config.json'],
    ['src/', 'src/blocks/tile/config.json'],
    ['src\\', 'src/blocks/tile/config.json'],
    ['', 'blocks/tile/config.json'],
    ['.', 'blocks/tile/config.json'],
  ])('keeps authored sizes for entry %o', (entry, configPath) => {
    expect(authoredSizesFor(entry, configPath)).toStrictEqual([
      { ...withoutSizes(packaged('tile')), min_w: 3, default_w: 6 },
    ]);
  });

  it('strips every size from a block with no matching config.json', () => {
    const files = [
      file('kizen.json', { api_name: 'p', entry: 'src' }),
      file('src/blocks/tile/config.json', { api_name: 'renamed', default_w: 4, min_w: 2 }),
    ];
    const [plugin] = applyAuthoredConfig([makePlugin('p', [packaged('tile')])], files);

    expect(plugin?.artifacts.custom_blocks).toStrictEqual([withoutSizes(packaged('tile'))]);
  });
});

describe('exportBlock', () => {
  let workDir: string;
  let pluginDir: string;
  let blocksDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'appbuilder-exportblock-'));
    pluginDir = join(workDir, 'plugin');
    blocksDir = join(pluginDir, 'src', 'blocks');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const bootstrapPlugin = async (
    artifacts: Parameters<typeof createPlugin>[0]['artifacts'] = ['block'],
  ): Promise<void> => {
    await createPlugin({
      targetDir: pluginDir,
      name: 'Acme Widgets',
      apiName: PLUGIN_API_NAME,
      externalLink: 'https://example.com/acme-widgets',
      description: 'Adds Acme widget tooling to Kizen.',
      developerBusinessId: '',
      developerEnvironment: 'go',
      artifacts,
    });
  };

  const writeBlockFile = async (
    component: string,
    file: string,
    content: string,
  ): Promise<void> => {
    await writeFile(join(blocksDir, component, file), content, 'utf-8');
  };

  const writeBlockConfig = async (
    component: string,
    config: Record<string, unknown>,
  ): Promise<void> => {
    await writeBlockFile(component, 'config.json', JSON.stringify(config, null, 2));
  };

  const addBlock = async (component: string, apiName: string): Promise<void> => {
    await cp(join(blocksDir, 'helloBlock'), join(blocksDir, component), { recursive: true });
    await writeBlockConfig(component, { name: component, api_name: apiName });
  };

  const exportAndExpectRejection = async (apiName?: string): Promise<unknown> =>
    exportBlock(pluginDir, apiName).then(
      () => null,
      (error: unknown) => error,
    );

  it('exports the only block exactly as packaged, warning only about the unused kizenData lib', async () => {
    await bootstrapPlugin();

    const { deployable } = await packageLocalPlugin(pluginDir);
    const result = await exportBlock(pluginDir);

    expect(result.block).toStrictEqual(withoutSizes(deployable[0]?.artifacts.custom_blocks[0]));
    expect(result.block.api_name).toBe('hello_block');
    expect(result.block.script.trim()).not.toBe('');
    expect(result.pluginApiName).toBe(PLUGIN_API_NAME);
    expect(result.warnings.filter((issue) => issue.severity === 'error')).toStrictEqual([]);
    expect(
      result.warnings.map(({ rule, path, severity }) => ({ rule, path, severity })),
    ).toStrictEqual([
      { rule: 'imports/unused-module', path: 'src/lib/kizenData.js', severity: 'warning' },
    ]);
  });

  it('selects a block by api_name among several', async () => {
    await bootstrapPlugin();
    await addBlock('secondBlock', 'second_block');

    const { block } = await exportBlock(pluginDir, 'second_block');

    expect(block.api_name).toBe('second_block');
    expect(block.name).toBe('secondBlock');
  });

  it('rejects as ambiguous when several blocks exist and no api_name is given', async () => {
    await bootstrapPlugin();
    await addBlock('secondBlock', 'second_block');

    const thrown = await exportAndExpectRejection();

    expect(thrown).toBeInstanceOf(BlockExportError);
    expect((thrown as BlockExportError).reason).toBe('ambiguous');
    expect((thrown as BlockExportError).available.map((entry) => entry.apiName).sort()).toEqual([
      'hello_block',
      'second_block',
    ]);
    expect((thrown as BlockExportError).message).toContain('hello_block');
    expect((thrown as BlockExportError).message).toContain('second_block');
  });

  it('rejects as not_found and lists the available api_names', async () => {
    await bootstrapPlugin();

    const thrown = await exportAndExpectRejection('missing_block');

    expect(thrown).toBeInstanceOf(BlockExportError);
    expect((thrown as BlockExportError).reason).toBe('not_found');
    expect((thrown as BlockExportError).available).toStrictEqual([
      { pluginApiName: PLUGIN_API_NAME, apiName: 'hello_block' },
    ]);
    expect((thrown as BlockExportError).message).toContain('Available blocks: hello_block');
  });

  it('rejects as no_blocks with a hint to scaffold one', async () => {
    await bootstrapPlugin([]);

    const thrown = await exportAndExpectRejection();

    expect(thrown).toBeInstanceOf(BlockExportError);
    expect((thrown as BlockExportError).reason).toBe('no_blocks');
    expect((thrown as BlockExportError).available).toEqual([]);
    expect((thrown as BlockExportError).message).toContain('appbuilder create --artifacts block');
  });

  it('rejects a config-only block as invalid_block naming script', async () => {
    await bootstrapPlugin();
    await rm(join(blocksDir, 'helloBlock', 'script.js'));

    const thrown = await exportAndExpectRejection();

    expect(thrown).toBeInstanceOf(BlockExportError);
    expect((thrown as BlockExportError).reason).toBe('invalid_block');
    expect((thrown as BlockExportError).field).toBe('script');
  });

  it('rejects a negative min_w as invalid_block naming min_w', async () => {
    await bootstrapPlugin();
    await writeBlockConfig('helloBlock', {
      name: 'Hello Block',
      api_name: 'hello_block',
      min_w: -2,
    });

    const thrown = await exportAndExpectRejection();

    expect(thrown).toBeInstanceOf(BlockExportError);
    expect((thrown as BlockExportError).reason).toBe('invalid_block');
    expect((thrown as BlockExportError).field).toBe('min_w');
    expect((thrown as BlockExportError).message).toContain('min_w');
  });

  const pushedSize = async (): Promise<{ w: number; h: number }> => {
    const { deployable } = await packageBlocks(pluginDir);
    const selection = selectBlock(deployable);

    if (!selection.ok) {
      throw new Error(`expected one block, got ${selection.reason}`);
    }

    expect(findInvalidBlockField(selection.block)).toBeUndefined();

    const { w, h } = computeCreateLayout([], toCustomCodeContent(selection.block), 'id');

    return { w, h };
  };

  const sizeKeysOf = (block: Block): string[] =>
    Object.keys(block).filter((key) => SIZE_KEYS.includes(key));

  it('exports no size keys and creates 6x3 when config.json sets no sizes', async () => {
    await bootstrapPlugin();
    await writeBlockConfig('helloBlock', { name: 'Hello Block', api_name: 'hello_block' });

    const { block } = await exportBlock(pluginDir);

    expect(sizeKeysOf(block)).toStrictEqual([]);
    expect(Object.keys(toCustomCodeContent(block))).not.toContain('min_w');
    await expect(pushedSize()).resolves.toStrictEqual({ w: 6, h: 3 });
  });

  it('exports the authored sizes and creates 6x4 from min 3x3 and default 6x4', async () => {
    await bootstrapPlugin();
    await writeBlockConfig('helloBlock', {
      name: 'Hello Block',
      api_name: 'hello_block',
      min_w: 3,
      min_h: 3,
      default_w: 6,
      default_h: 4,
    });

    const { block } = await exportBlock(pluginDir);

    expect(sizeKeysOf(block).sort()).toStrictEqual(['default_h', 'default_w', 'min_h', 'min_w']);
    expect(block).toMatchObject({ min_w: 3, min_h: 3, default_w: 6, default_h: 4 });
    await expect(pushedSize()).resolves.toStrictEqual({ w: 6, h: 4 });
  });

  it('exports sizes for a block whose api_name comes from its directory', async () => {
    await bootstrapPlugin();
    await writeBlockConfig('helloBlock', { name: 'Hello Block', default_w: 5 });

    const { block } = await exportBlock(pluginDir);

    expect(block.api_name).toBe('helloblock');
    expect(sizeKeysOf(block)).toStrictEqual(['default_w']);
    expect(block).toHaveProperty('default_w', 5);
  });

  it.each([
    [2, { min_w: 3 }],
    [13, { min_w: 3, max_w: 12 }],
  ])('rejects default_w %i with %o as invalid_block', async (defaultW, bounds) => {
    await bootstrapPlugin();
    await writeBlockConfig('helloBlock', {
      name: 'Hello Block',
      api_name: 'hello_block',
      ...bounds,
      default_w: defaultW,
    });

    const thrown = await exportAndExpectRejection();

    expect(thrown).toBeInstanceOf(BlockExportError);
    expect((thrown as BlockExportError).reason).toBe('invalid_block');
    expect((thrown as BlockExportError).field).toBe('default_w');
    expect((thrown as BlockExportError).message).toBe(
      'Block "hello_block" has an invalid default_w: it must be a positive integer between min_w and max_w.',
    );
  });

  it.each([false, true])('exports an authored host_chrome of %o', async (hostChrome) => {
    await bootstrapPlugin();
    await writeBlockConfig('helloBlock', {
      name: 'Hello Block',
      api_name: 'hello_block',
      host_chrome: hostChrome,
    });

    const { block } = await exportBlock(pluginDir);

    expect(block).toHaveProperty('host_chrome', hostChrome);
    expect(JSON.parse(JSON.stringify(block))).toHaveProperty('host_chrome', hostChrome);
  });

  it('exports no host_chrome key when config.json does not set it', async () => {
    await bootstrapPlugin();
    await writeBlockConfig('helloBlock', { name: 'Hello Block', api_name: 'hello_block' });

    const { block } = await exportBlock(pluginDir);

    expect(Object.keys(block)).not.toContain('host_chrome');
  });

  it.each(['false', 0, null])(
    'rejects an authored host_chrome of %o as invalid_block naming host_chrome',
    async (hostChrome) => {
      await bootstrapPlugin();
      await writeBlockConfig('helloBlock', {
        name: 'Hello Block',
        api_name: 'hello_block',
        host_chrome: hostChrome,
      });

      const thrown = await exportAndExpectRejection();

      expect(thrown).toBeInstanceOf(BlockExportError);
      expect((thrown as BlockExportError).reason).toBe('invalid_block');
      expect((thrown as BlockExportError).field).toBe('host_chrome');
      expect((thrown as BlockExportError).message).toBe(
        'Block "hello_block" has an invalid host_chrome: it must be true or false.',
      );
    },
  );

  it('rejects a script containing {__ref: as invalid_block', async () => {
    await bootstrapPlugin();
    await writeBlockFile('helloBlock', 'script.js', 'this.outputUI("{__ref:abc}");\n');

    const thrown = await exportAndExpectRejection();

    expect(thrown).toBeInstanceOf(BlockExportError);
    expect((thrown as BlockExportError).reason).toBe('invalid_block');
    expect((thrown as BlockExportError).field).toBe('script');
  });

  it('propagates validation errors as PluginValidationError', async () => {
    await bootstrapPlugin();
    await writeBlockFile('helloBlock', 'script.js', 'this.outputUI(document.title);\n');

    const thrown = await exportAndExpectRejection();

    expect(thrown).toBeInstanceOf(PluginValidationError);
    expect(
      (thrown as PluginValidationError).issues.some((issue) => issue.severity === 'error'),
    ).toBe(true);
  });

  it('writes nothing to .kizenapp and leaves .gitignore untouched', async () => {
    await bootstrapPlugin();

    const gitignorePath = join(pluginDir, '.gitignore');
    const gitignoreBefore = await readFile(gitignorePath, 'utf-8');

    await rm(join(pluginDir, '.kizenapp'), { recursive: true, force: true });
    await exportBlock(pluginDir);

    await expect(stat(join(pluginDir, '.kizenapp'))).rejects.toThrow();
    expect(await readFile(gitignorePath, 'utf-8')).toBe(gitignoreBefore);
  });

  it('packageBlocks returns every packaged plugin with only warning issues', async () => {
    await bootstrapPlugin();
    await addBlock('secondBlock', 'second_block');

    const { deployable, issues } = await packageLocalPlugin(pluginDir);
    const result = await packageBlocks(pluginDir);

    expect(result.deployable).toStrictEqual(
      deployable.map((plugin) => ({
        ...plugin,
        artifacts: {
          ...plugin.artifacts,
          custom_blocks: plugin.artifacts.custom_blocks.map(withoutSizes),
        },
      })),
    );
    expect(
      result.deployable[0]?.artifacts.custom_blocks.map((block) => block.api_name).sort(),
    ).toEqual(['hello_block', 'second_block']);
    expect(result.warnings).toStrictEqual(issues.filter((issue) => issue.severity === 'warning'));
  });

  const writeComponent = async (
    directory: string,
    component: string,
    files: Record<string, string>,
  ): Promise<void> => {
    for (const [relative, content] of Object.entries(files)) {
      const path = join(pluginDir, 'src', directory, component, relative);

      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content, 'utf-8');
    }
  };

  const writeDetailView = (): Promise<void> =>
    writeComponent('views', 'detailView', {
      'config.json': JSON.stringify({ name: 'Detail', api_name: 'detail_view' }),
      'script.js': 'this.outputUI(\'<p class="detail">Detail</p>\');\n',
      'styles.css': '.detail { color: red; }\n',
      'eventScripts/close.js': "this.outputUI('<p>closed</p>');\n",
    });

  it('export_includes_views', async () => {
    await bootstrapPlugin();
    await writeDetailView();

    const result = await exportBlock(pluginDir);
    const json = toExportJson(result);

    expect(result.views.map((view) => view.api_name)).toStrictEqual(['detail_view']);
    expect(json).toStrictEqual({ ...result.block, views: json.views });
    expect(json.views).toHaveLength(1);
    expect(json.views?.[0]).toMatchObject({
      api_name: 'detail_view',
      name: 'Detail',
      type: 'script',
      event_scripts: [{ name: 'close', script: expect.stringContaining('closed') as unknown }],
    });
    expect(json.views?.[0]?.script).toContain('detail');
    expect(json.views?.[0]?.css).toContain('.detail');
    expect(json.views?.[0]).not.toHaveProperty('html');
    // The block itself keeps its packaged shape: event_scripts stays a map for the paste editor.
    expect(Array.isArray(json.event_scripts)).toBe(false);
  });

  it('export_rejects_view_event_script_with_nul', async () => {
    await bootstrapPlugin();
    await writeDetailView();
    await writeComponent('views', 'detailView', {
      // A raw NUL in a template literal survives minification (a quoted string becomes "\\0").
      'eventScripts/close.js': 'this.outputUI(`<p>closed \u0000</p>`);\n',
    });

    const thrown = await exportAndExpectRejection();

    expect(thrown).toBeInstanceOf(BlockExportError);
    expect((thrown as BlockExportError).reason).toBe('invalid_block');
    expect((thrown as BlockExportError).field).toBe('views.detail_view.event_scripts.close');
    expect((thrown as BlockExportError).message).toContain('"detail_view"');
    expect((thrown as BlockExportError).message).toContain('event_scripts.close');
  });

  it('exports no views key when the plugin has no views', async () => {
    await bootstrapPlugin();

    const result = await exportBlock(pluginDir);

    expect(result.views).toStrictEqual([]);
    expect(toExportJson(result)).toStrictEqual(result.block);
    expect(Object.keys(toExportJson(result))).not.toContain('views');
  });

  it('pages_vs_views_handling', async () => {
    await bootstrapPlugin(['block', 'page']);
    await writeDetailView();
    await writeComponent('views', 'plainView', { 'index.html': '<p>plain</p>' });

    const { deployable } = await packageLocalPlugin(pluginDir);
    const packaged = await packageBlocks(pluginDir);
    const views = packaged.views[PLUGIN_API_NAME] ?? [];

    // The packager merges both directories into routable_pages; only views/ are carried.
    expect(
      deployable[0]?.artifacts.routable_pages.map((page) => page.api_name).sort(),
    ).toStrictEqual(['detail_view', 'hello_page', 'plainview']);
    expect(views.map((view) => view.api_name)).toStrictEqual(['detail_view', 'plainview']);
    expect(views.find((view) => view.api_name === 'plainview')).toMatchObject({
      type: 'html',
      html: '<p>plain</p>',
      name: 'plainView',
    });
    expect(packaged.deployable[0]?.artifacts.routable_pages).toHaveLength(3);
  });
});

describe('collectViews', () => {
  const file = (path: string, content: unknown): FileContent => ({
    path,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  });

  const page = (overrides: Partial<RoutablePage>): RoutablePage =>
    routablePage({ name: 'x', api_name: 'x', script: 's();', ...overrides });

  const pluginWithPages = (apiName: string, pages: RoutablePage[]): DeployablePlugin =>
    ({
      api_name: apiName,
      artifacts: { custom_blocks: [], routable_pages: pages },
    }) as unknown as DeployablePlugin;

  it('keeps a view whose api_name a page also uses, told apart by name, and sorts by api_name', () => {
    const files = [
      file('kizen.json', { api_name: 'p', entry: 'src' }),
      file('src/pages/report/config.json', { api_name: 'shared', name: 'Report page' }),
      file('src/pages/report/script.js', 's();'),
      file('src/views/zeta/script.js', 's();'),
      file('src/views/reportView/config.json', { api_name: 'shared' }),
      file('src/views/reportView/script.js', 's();'),
    ];
    const reportPage = page({ api_name: 'shared', name: 'Report page' });
    const reportView = page({ api_name: 'shared', name: 'reportView' });
    const zeta = page({ api_name: 'zeta', name: 'zeta' });

    expect(
      collectViews([pluginWithPages('p', [zeta, reportPage, reportView])], files),
    ).toStrictEqual({ views: { p: [reportView, zeta] }, warnings: [] });
  });

  it('matches views per plugin entry in a multi-plugin manifest', () => {
    const files = [
      file('kizen.json', [
        { api_name: 'one', entry: 'one' },
        { api_name: 'two', entry: 'two' },
      ]),
      file('one/views/a/script.js', 's();'),
      file('two/pages/a/script.js', 's();'),
    ];
    const a = page({ api_name: 'a', name: 'a' });

    expect(
      collectViews([pluginWithPages('one', [a]), pluginWithPages('two', [a])], files),
    ).toStrictEqual({ views: { one: [a], two: [] }, warnings: [] });
  });

  it.each([
    ['src', 'src/views/'],
    ['./src', 'src/views/'],
    ['src/', 'src/views/'],
    ['', 'views/'],
  ])('matches views without a config.json and skips .DS_Store for entry %o', (entry, viewsRoot) => {
    const files = [
      file('kizen.json', { api_name: 'p', entry }),
      file(`${viewsRoot}a/script.js`, 's();'),
      file(`${viewsRoot}.DS_Store`, 'junk'),
      file(`${viewsRoot}b/.DS_Store`, 'junk'),
    ];
    const a = page({ api_name: 'a', name: 'a' });

    expect(collectViews([pluginWithPages('p', [a])], files)).toStrictEqual({
      views: { p: [a] },
      warnings: [],
    });
  });

  it.each([
    ['./src', 'src/views'],
    ['', 'views'],
  ])('points the unmatched-views warning for entry %o at %s', (entry, path) => {
    const files = [
      file('kizen.json', { api_name: 'p', entry }),
      file(`${path}/a/script.js`, 's();'),
    ];

    expect(collectViews([pluginWithPages('p', [])], files).warnings).toMatchObject([{ path }]);
  });

  it('names a view by its directory when its config.json is not an object', () => {
    const files = [
      file('kizen.json', { api_name: 'p', entry: 'src' }),
      file('src/views/a/config.json', '[]'),
      file('src/views/a/script.js', 's();'),
    ];
    const a = page({ api_name: 'a', name: 'a' });

    expect(collectViews([pluginWithPages('p', [a])], files)).toStrictEqual({
      views: { p: [a] },
      warnings: [],
    });
  });

  it('warns when an authored view has no matching packaged view', () => {
    const files = [
      file('kizen.json', { api_name: 'p', entry: 'src' }),
      file('src/views/a/script.js', 's();'),
      file('src/views/b/script.js', 's();'),
    ];
    const a = page({ api_name: 'a', name: 'a' });
    const renamed = page({ api_name: 'b_renamed_by_packager', name: 'b' });
    const result = collectViews([pluginWithPages('p', [a, renamed])], files);

    expect(result.views).toStrictEqual({ p: [a] });
    expect(result.warnings).toStrictEqual([
      {
        rule: 'appbuilder/views-unmatched',
        severity: 'warning',
        message:
          'Found 2 views/ components but matched 1 packaged views; the pushed block carries only the matched ones.',
        path: 'src/views',
        pluginApiName: 'p',
      },
    ]);
  });
});

describe('findInvalidViewField', () => {
  const view = (overrides: Record<string, unknown> = {}): RoutablePage =>
    routablePage({ type: 'html', html: '<p/>', ...(overrides as Partial<RoutablePage>) });

  it('accepts well-formed views', () => {
    expect(findInvalidViewField([view(), view({ event_scripts: { a: 'b();' } })])).toBeUndefined();
  });

  it('view_with_non_string_name_rejected', () => {
    expect(findInvalidViewField([view({ name: 42 })])).toStrictEqual({
      view: 'detail_view',
      field: 'name',
    });
  });

  it.each([
    ['api_name', { api_name: 'a\u0000' }, 'a\u0000'],
    ['name', { name: '{__ref:x}' }, 'detail_view'],
    ['script', { script: 'x("{__ref:y}")' }, 'detail_view'],
    ['html', { html: '<p>{__ref:1}</p>' }, 'detail_view'],
    ['css', { css: 'a{content:"\u0000"}' }, 'detail_view'],
    ['event_scripts.go', { event_scripts: { go: 'x\u0000' } }, 'detail_view'],
    ['event_scripts.{__ref:n}', { event_scripts: { '{__ref:n}': 'ok();' } }, 'detail_view'],
    ['event_scripts.go', { event_scripts: { go: 7 } }, 'detail_view'],
    ['event_scripts', { event_scripts: [] }, 'detail_view'],
  ] as const)('names %s', (field, overrides, label) => {
    expect(findInvalidViewField([view(), view(overrides)])).toStrictEqual({ view: label, field });
  });
});
