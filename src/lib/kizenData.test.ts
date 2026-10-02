import { beforeAll, describe, expect, it, vi } from 'vitest';

interface Option {
  id: string;
  code?: string;
  name: string;
  order?: number;
}

interface Field {
  id: string;
  name: string;
  field_type?: string;
  display_name?: string;
  options?: Option[];
}

interface FieldValue {
  id: string;
  name: string;
  field_type?: string;
  display_name?: string;
  value: unknown;
}

interface SearchRecord {
  id: string;
  fields: Record<string, FieldValue>;
}

interface Filter {
  type: string;
  subtype: string;
  field: string;
  condition: string;
  value: unknown;
}

type Result = [unknown, unknown];

interface Ctx {
  getWithErrors: (path: string) => Promise<Result>;
  postWithErrors: (path: string, body: unknown) => Promise<Result>;
}

interface BlockArgs {
  dateFilter?: { start?: string; end?: string };
  teamFilter?: { teamMembers?: string[]; roles?: string[] };
  objectId?: string;
}

interface KizenData {
  escapeHtml: (value: unknown) => string;
  formatNumber: (input: number, prefix?: string) => string;
  getFields: (ctx: Ctx, object: string) => Promise<Field[]>;
  fieldByName: (fields: Field[], name: string) => Field | undefined;
  blockFilters: (
    args: BlockArgs | undefined,
    fields: Field[],
  ) => { filters: Filter[]; unapplied: string[] };
  dropdownFilter: (field: Field, optionNameOrNames: string | string[]) => Filter;
  searchRecords: (
    ctx: Ctx,
    options: {
      object: string;
      fieldNames: string[];
      filters?: Filter[];
      pageSize?: number;
      maxPages?: number;
      ordering?: string;
    },
  ) => Promise<{ records: SearchRecord[]; count: number; truncated: boolean }>;
  fieldValue: (record: SearchRecord, name: string) => unknown;
  fieldLabel: (record: SearchRecord, name: string) => string;
  countBy: (
    records: SearchRecord[],
    name: string,
    field?: Field,
  ) => { key: string; label: string; count: number }[];
  sumBy: (
    records: SearchRecord[],
    name: string,
    valueOf?: (record: SearchRecord) => unknown,
  ) => number;
}

let lib: KizenData;

beforeAll(async () => {
  lib = (await import(
    new URL('../templates/plugin/lib/kizenData.js', import.meta.url).href
  )) as KizenData;
});

const makeCtx = (
  overrides: Partial<Ctx> = {},
): Ctx & {
  getWithErrors: ReturnType<typeof vi.fn<Ctx['getWithErrors']>>;
  postWithErrors: ReturnType<typeof vi.fn<Ctx['postWithErrors']>>;
} => ({
  getWithErrors: vi.fn<Ctx['getWithErrors']>(
    overrides.getWithErrors ?? (() => Promise.resolve([[], null])),
  ),
  postWithErrors: vi.fn<Ctx['postWithErrors']>(
    overrides.postWithErrors ??
      (() => Promise.resolve([{ count: 0, next: null, results: [] }, null])),
  ),
});

const STATUS: Field = {
  id: 'f-status',
  name: 'status',
  field_type: 'dropdown',
  display_name: 'Status',
  options: [
    { id: 'o-new', code: 'new', name: 'New', order: 0 },
    { id: 'o-open', code: 'open', name: 'Open', order: 1 },
    { id: 'o-won', code: 'won', name: 'Won', order: 2 },
  ],
};

const OWNER: Field = { id: 'f-owner', name: 'owner', field_type: 'selector' };

const record = (id: string, values: Record<string, unknown>): SearchRecord => ({
  id,
  fields: Object.fromEntries(
    Object.entries(values).map(([name, value], index) => [
      `field-${String(index)}`,
      { id: `field-${String(index)}`, name, display_name: name, value },
    ]),
  ),
});

describe('formatNumber', () => {
  it('matches the native collapseNumber rules', () => {
    expect(
      [
        [0.1234, '$'],
        [12.3456789, '$'],
        [1234, '$'],
        [9999.6, '$'],
        [10000, '$'],
        [10045, '$'],
        [32495, '$'],
        [26005, '$'],
        [999950, '$'],
        [1234567, '$'],
        [-2500000000, '$'],
        [1e12, '$'],
        [NaN, ''],
      ].map(([value, prefix]) => lib.formatNumber(value as number, prefix as string)),
    ).toStrictEqual([
      '$0.1234',
      '$12.346',
      '$1,234',
      '$10,000',
      '$10K',
      '$10.05K',
      '$32.5K',
      '$26.01K',
      '$1M',
      '$1.235M',
      '-$2.5B',
      '$999B+',
      '0',
    ]);
  });

  it('defaults the prefix to nothing', () => {
    expect(lib.formatNumber(42000)).toBe('42K');
  });
});

describe('blockFilters', () => {
  const dateFilter = {
    type: 'fields_v2',
    subtype: 'non_custom',
    field: 'created',
    condition: 'between',
    value: ['2026-01-01', '2026-03-31'],
  };

  it('returns no filters and nothing unapplied without args', () => {
    expect(lib.blockFilters(undefined, [STATUS, OWNER])).toStrictEqual({
      filters: [],
      unapplied: [],
    });
    expect(lib.blockFilters({}, [STATUS, OWNER])).toStrictEqual({ filters: [], unapplied: [] });
  });

  it('filters created between the date range, inclusive days as given', () => {
    expect(
      lib.blockFilters({ dateFilter: { start: '2026-01-01', end: '2026-03-31' } }, [STATUS]),
    ).toStrictEqual({ filters: [dateFilter], unapplied: [] });
  });

  it('reports a date filter missing an end as unapplied', () => {
    expect(lib.blockFilters({ dateFilter: { start: '2026-01-01' } }, [STATUS])).toStrictEqual({
      filters: [],
      unapplied: ['dateFilter'],
    });
  });

  it('treats an empty team as all, adding no owner filter', () => {
    expect(
      lib.blockFilters({ teamFilter: { teamMembers: [], roles: [] } }, [STATUS, OWNER]),
    ).toStrictEqual({ filters: [], unapplied: [] });
  });

  it('filters owner by the selected team members', () => {
    expect(
      lib.blockFilters(
        {
          dateFilter: { start: '2026-01-01', end: '2026-03-31' },
          teamFilter: { teamMembers: ['e1', 'e2'], roles: [] },
        },
        [STATUS, OWNER],
      ),
    ).toStrictEqual({
      filters: [
        dateFilter,
        {
          type: 'fields_v2',
          subtype: 'non_custom',
          field: 'owner',
          condition: 'is_any_of',
          value: ['e1', 'e2'],
        },
      ],
      unapplied: [],
    });
  });

  it('skips the owner filter and reports it for an object with no owner field', () => {
    expect(
      lib.blockFilters(
        {
          dateFilter: { start: '2026-01-01', end: '2026-03-31' },
          teamFilter: { teamMembers: ['e1'], roles: [] },
        },
        [STATUS],
      ),
    ).toStrictEqual({ filters: [dateFilter], unapplied: ['teamFilter'] });
  });

  it('reports a roles-only team filter as unapplied', () => {
    expect(
      lib.blockFilters({ teamFilter: { teamMembers: [], roles: ['r1'] } }, [STATUS, OWNER]),
    ).toStrictEqual({ filters: [], unapplied: ['teamFilter'] });
  });

  it('does not alias the caller team member array', () => {
    const teamMembers = ['e1'];
    const { filters } = lib.blockFilters({ teamFilter: { teamMembers } }, [OWNER]);

    expect(filters[0]?.value).toStrictEqual(['e1']);
    expect(filters[0]?.value).not.toBe(teamMembers);
  });
});

describe('dropdownFilter', () => {
  it('resolves one option name to an equality filter on its id', () => {
    expect(lib.dropdownFilter(STATUS, 'Open')).toStrictEqual({
      type: 'fields_v2',
      subtype: 'custom',
      field: 'custom::f-status',
      condition: '=',
      value: 'o-open',
    });
  });

  it('resolves several option names to an is_any_of filter on their ids', () => {
    expect(lib.dropdownFilter(STATUS, ['Won', 'New'])).toStrictEqual({
      type: 'fields_v2',
      subtype: 'custom',
      field: 'custom::f-status',
      condition: 'is_any_of',
      value: ['o-won', 'o-new'],
    });
  });

  it('throws a readable error for an unknown option name', () => {
    expect(() => lib.dropdownFilter(STATUS, 'Lost')).toThrow('Status has no option named "Lost"');
  });
});

describe('getFields', () => {
  it('fetches the fields of an object once per run', async () => {
    const ctx = makeCtx({ getWithErrors: () => Promise.resolve([[STATUS, OWNER], null]) });

    const [first, second] = await Promise.all([
      lib.getFields(ctx, 'memo_object'),
      lib.getFields(ctx, 'memo_object'),
    ]);
    const third = await lib.getFields(ctx, 'memo_object');

    expect(first).toStrictEqual([STATUS, OWNER]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(ctx.getWithErrors).toHaveBeenCalledTimes(1);
    expect(ctx.getWithErrors).toHaveBeenCalledWith('/custom-objects/memo_object/fields');
  });

  it('keeps a separate memo per object', async () => {
    const ctx = makeCtx({ getWithErrors: () => Promise.resolve([[STATUS], null]) });

    await lib.getFields(ctx, 'memo_a');
    await lib.getFields(ctx, 'memo_b');

    expect(ctx.getWithErrors.mock.calls.map((call) => call[0])).toStrictEqual([
      '/custom-objects/memo_a/fields',
      '/custom-objects/memo_b/fields',
    ]);
  });

  it('throws a readable error and retries on the next call after a failure', async () => {
    const ctx = makeCtx({
      getWithErrors: vi
        .fn<Ctx['getWithErrors']>()
        .mockResolvedValueOnce([null, { message: 'Not found.' }])
        .mockResolvedValueOnce([[OWNER], null]),
    });

    await expect(lib.getFields(ctx, 'failing_object')).rejects.toThrow(
      "Couldn't load fields for failing_object: Not found.",
    );
    await expect(lib.getFields(ctx, 'failing_object')).resolves.toStrictEqual([OWNER]);
    expect(ctx.getWithErrors).toHaveBeenCalledTimes(2);
  });

  it('describes a non-message error object and a non-list response', async () => {
    await expect(
      lib.getFields(
        makeCtx({ getWithErrors: () => Promise.resolve([null, { detail: 'nope' }]) }),
        'json_error_object',
      ),
    ).rejects.toThrow('Couldn\'t load fields for json_error_object: {"detail":"nope"}');
    await expect(
      lib.getFields(
        makeCtx({ getWithErrors: () => Promise.resolve([{ results: [] }, null]) }),
        'not_a_list_object',
      ),
    ).rejects.toThrow(
      "Couldn't load fields for not_a_list_object: the response was not a list of fields",
    );
  });

  it('finds a field by name', () => {
    expect(lib.fieldByName([STATUS, OWNER], 'owner')).toBe(OWNER);
    expect(lib.fieldByName([STATUS], 'owner')).toBeUndefined();
  });
});

describe('searchRecords', () => {
  const page = (results: SearchRecord[], count: number, next: string | null): Result => [
    { count, next, previous: null, results, errors: [] },
    null,
  ];

  const records = (from: number, to: number): SearchRecord[] =>
    Array.from({ length: to - from }, (_value, index) =>
      record(`r${String(from + index)}`, { name: `R${String(from + index)}` }),
    );

  it('posts the field names and filters and follows next until it is null', async () => {
    const filters = lib.blockFilters(
      { dateFilter: { start: '2026-01-01', end: '2026-01-31' } },
      [],
    ).filters;
    const ctx = makeCtx({
      postWithErrors: vi
        .fn<Ctx['postWithErrors']>()
        .mockResolvedValueOnce(page(records(0, 2), 5, 'https://x/records/deals/search?page=2'))
        .mockResolvedValueOnce(page(records(2, 4), 5, 'https://x/records/deals/search?page=3'))
        .mockResolvedValueOnce(page(records(4, 5), 5, null)),
    });

    const result = await lib.searchRecords(ctx, {
      object: 'deals',
      fieldNames: ['name', 'status'],
      filters,
      pageSize: 2,
      ordering: '-name',
    });

    expect(result.records.map((entry) => entry.id)).toStrictEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(result.count).toBe(5);
    expect(result.truncated).toBe(false);
    expect(ctx.postWithErrors.mock.calls.map((call) => call[0])).toStrictEqual([
      '/records/deals/search?page_size=2&page=1&ordering=-name',
      '/records/deals/search?page_size=2&page=2&ordering=-name',
      '/records/deals/search?page_size=2&page=3&ordering=-name',
    ]);
    expect(ctx.postWithErrors.mock.calls[0]?.[1]).toStrictEqual({
      field_names: ['name', 'status'],
      query: [{ and: true, filters }],
    });
  });

  it('stops at maxPages and reports truncated when count exceeds what was fetched', async () => {
    const postWithErrors = vi
      .fn<Ctx['postWithErrors']>()
      .mockResolvedValueOnce(page(records(0, 2), 9, 'next'))
      .mockResolvedValueOnce(page(records(2, 4), 9, 'next'));
    const result = await lib.searchRecords(makeCtx({ postWithErrors }), {
      object: 'deals',
      fieldNames: ['name'],
      pageSize: 2,
      maxPages: 2,
    });

    expect(result.records).toHaveLength(4);
    expect(result.count).toBe(9);
    expect(result.truncated).toBe(true);
    expect(postWithErrors).toHaveBeenCalledTimes(2);
  });

  it('defaults to one request of 1000 with an empty query and no ordering', async () => {
    const ctx = makeCtx({ postWithErrors: () => Promise.resolve(page(records(0, 3), 3, null)) });

    const result = await lib.searchRecords(ctx, { object: 'client_client', fieldNames: ['email'] });

    expect(result).toMatchObject({ count: 3, truncated: false });
    expect(ctx.postWithErrors.mock.calls).toStrictEqual([
      [
        '/records/client_client/search?page_size=1000&page=1',
        { field_names: ['email'], query: [] },
      ],
    ]);
  });

  it('reports truncated when it stops at maxPages while next is still set, even if count agrees', async () => {
    const postWithErrors = vi
      .fn<Ctx['postWithErrors']>()
      .mockResolvedValueOnce(page(records(0, 2), 2, 'next'));
    const result = await lib.searchRecords(makeCtx({ postWithErrors }), {
      object: 'deals',
      fieldNames: [],
      pageSize: 2,
      maxPages: 1,
    });

    expect(result).toMatchObject({ count: 2, truncated: true });
    expect(result.records).toHaveLength(2);
  });

  it('is not truncated when the last page has no next', async () => {
    const result = await lib.searchRecords(
      makeCtx({ postWithErrors: () => Promise.resolve(page(records(0, 2), 2, null)) }),
      { object: 'deals', fieldNames: [], pageSize: 2, maxPages: 1 },
    );

    expect(result.truncated).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, 5000])(
    'uses a pageSize of 1000 for a pageSize of %s',
    async (pageSize) => {
      const ctx = makeCtx();

      await lib.searchRecords(ctx, { object: 'deals', fieldNames: [], pageSize });

      expect(ctx.postWithErrors.mock.calls[0]?.[0]).toBe(
        '/records/deals/search?page_size=1000&page=1',
      );
    },
  );

  it.each([0, -3, 0.5])('still fetches one page for a maxPages of %s', async (maxPages) => {
    const ctx = makeCtx({ postWithErrors: () => Promise.resolve(page(records(0, 1), 9, 'next')) });

    const result = await lib.searchRecords(ctx, { object: 'deals', fieldNames: [], maxPages });

    expect(ctx.postWithErrors).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(true);
  });

  it('uses the default of 10 pages for a non-finite maxPages', async () => {
    const ctx = makeCtx({ postWithErrors: () => Promise.resolve(page(records(0, 1), 99, 'next')) });

    await lib.searchRecords(ctx, { object: 'deals', fieldNames: [], maxPages: NaN });

    expect(ctx.postWithErrors).toHaveBeenCalledTimes(10);
  });

  it('sends query: [] rather than an empty filter group when filters is empty', async () => {
    const ctx = makeCtx();

    await lib.searchRecords(ctx, { object: 'deals', fieldNames: ['name'], filters: [] });

    expect(ctx.postWithErrors.mock.calls[0]?.[1]).toStrictEqual({
      field_names: ['name'],
      query: [],
    });
  });

  it('throws a readable error when a page fails', async () => {
    const postWithErrors = vi
      .fn<Ctx['postWithErrors']>()
      .mockResolvedValueOnce(page(records(0, 1), 3, 'next'))
      .mockResolvedValueOnce([null, 'Permission denied']);

    await expect(
      lib.searchRecords(makeCtx({ postWithErrors }), { object: 'deals', fieldNames: [] }),
    ).rejects.toThrow("Couldn't search deals: Permission denied");
  });
});

describe('fieldValue and fieldLabel', () => {
  const deal = record('d1', {
    amount: { currency: 'USD', symbol: '$', amount: 32495 },
    status: { id: 'o-open', code: 'open', name: 'Open' },
    tags: [
      { id: 't1', name: 'Hot' },
      { id: 't2', name: 'Inbound' },
    ],
    contacts: [
      { id: 'c1', display_name: 'Ada Lovelace' },
      { id: 'c2', display_name: 'Alan Turing' },
    ],
    owner: { id: 'e1', first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
    emailOnlyOwner: { id: 'e2', first_name: '', last_name: '', email: 'x@example.com' },
    close_date: '2026-03-31',
    created: '2026-01-02T15:04:05Z',
    probability: 40,
    active: true,
    notes: '',
    nothing: null,
    noTags: [],
    noAmount: { currency: 'USD', symbol: '$', amount: null },
  });

  it('returns the raw value of the field with that name', () => {
    expect(lib.fieldValue(deal, 'status')).toStrictEqual({
      id: 'o-open',
      code: 'open',
      name: 'Open',
    });
    expect(lib.fieldValue(deal, 'probability')).toBe(40);
    expect(lib.fieldValue(deal, 'missing')).toBeUndefined();
  });

  it.each([
    ['amount', '$32.5K'],
    ['status', 'Open'],
    ['tags', 'Hot, Inbound'],
    ['contacts', 'Ada Lovelace, Alan Turing'],
    ['owner', 'Grace Hopper'],
    ['emailOnlyOwner', 'x@example.com'],
    ['close_date', '2026-03-31'],
    ['created', '2026-01-02T15:04:05Z'],
    ['probability', '40'],
    ['active', 'true'],
    ['notes', ''],
    ['nothing', ''],
    ['noTags', ''],
    ['noAmount', ''],
    ['missing', ''],
  ])('labels %s as %j', (name, label) => {
    expect(lib.fieldLabel(deal, name)).toBe(label);
  });
});

describe('countBy', () => {
  const open = { id: 'o-open', code: 'open', name: 'Open' };
  const won = { id: 'o-won', code: 'won', name: 'Won' };
  const fresh = { id: 'o-new', code: 'new', name: 'New' };

  it('counts records per dropdown option, most first', () => {
    const rows = [open, won, won, open, won, null].map((status, index) =>
      record(`r${String(index)}`, { status }),
    );

    expect(lib.countBy(rows, 'status')).toStrictEqual([
      { key: 'o-won', label: 'Won', count: 3 },
      { key: 'o-open', label: 'Open', count: 2 },
      { key: '', label: '', count: 1 },
    ]);
  });

  it('breaks ties by dropdown option order when given the field', () => {
    const rows = [won, open, fresh].map((status, index) => record(`r${String(index)}`, { status }));

    expect(lib.countBy(rows, 'status').map((row) => row.key)).toStrictEqual([
      'o-won',
      'o-open',
      'o-new',
    ]);
    expect(lib.countBy(rows, 'status', STATUS).map((row) => row.key)).toStrictEqual([
      'o-new',
      'o-open',
      'o-won',
    ]);
  });

  it('ranks options with a missing or non-numeric order after ordered ones, consistently', () => {
    const field: Field = {
      id: 'f-mixed',
      name: 'status',
      options: [
        { id: 'o-a', name: 'A' },
        { id: 'o-b', name: 'B', order: 'x' as unknown as number },
        { id: 'o-c', name: 'C', order: 1 },
        { id: 'o-d', name: 'D', order: null as unknown as number },
        { id: 'o-e', name: 'E', order: 0 },
      ],
    };
    const rows = ['o-a', 'o-b', 'o-c', 'o-d', 'o-e'].map((id, index) =>
      record(`r${String(index)}`, { status: { id, name: id } }),
    );
    const reversed = [...rows].reverse();

    expect(lib.countBy(rows, 'status', field).map((row) => row.key)).toStrictEqual([
      'o-e',
      'o-c',
      'o-a',
      'o-b',
      'o-d',
    ]);
    expect(lib.countBy(reversed, 'status', field).map((row) => row.key)).toStrictEqual([
      'o-e',
      'o-c',
      'o-d',
      'o-b',
      'o-a',
    ]);
  });

  it('counts each element of a multi-value field and groups owners by id', () => {
    const grace = { id: 'e1', first_name: 'Grace', last_name: 'Hopper', email: 'g@example.com' };
    const rows = [
      record('r1', {
        tags: [
          { id: 't1', name: 'Hot' },
          { id: 't2', name: 'Inbound' },
        ],
        owner: grace,
      }),
      record('r2', { tags: [{ id: 't1', name: 'Hot' }], owner: grace }),
      record('r3', { tags: [], owner: null }),
    ];

    expect(lib.countBy(rows, 'tags')).toStrictEqual([
      { key: 't1', label: 'Hot', count: 2 },
      { key: 't2', label: 'Inbound', count: 1 },
      { key: '', label: '', count: 1 },
    ]);
    expect(lib.countBy(rows, 'owner')).toStrictEqual([
      { key: 'e1', label: 'Grace Hopper', count: 2 },
      { key: '', label: '', count: 1 },
    ]);
  });

  it('groups scalar values by their string form', () => {
    const rows = [3, 3, 'x'].map((score, index) => record(`r${String(index)}`, { score }));

    expect(lib.countBy(rows, 'score')).toStrictEqual([
      { key: '3', label: '3', count: 2 },
      { key: 'x', label: 'x', count: 1 },
    ]);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(lib.escapeHtml(`<img src="x" onerror='a'>&`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;a&#39;&gt;&amp;',
    );
  });

  it('renders null and undefined as empty and stringifies other values', () => {
    expect(lib.escapeHtml(null)).toBe('');
    expect(lib.escapeHtml(undefined)).toBe('');
    expect(lib.escapeHtml(0)).toBe('0');
    expect(lib.escapeHtml(false)).toBe('false');
    expect(lib.escapeHtml('Plain text')).toBe('Plain text');
  });

  it('escapes an already escaped entity again rather than passing it through', () => {
    expect(lib.escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('sumBy', () => {
  const rows = [
    record('r1', { amount: { currency: 'USD', symbol: '$', amount: 1500.5 }, units: 2 }),
    record('r2', { amount: { currency: 'USD', symbol: '$', amount: '250' }, units: '3' }),
    record('r3', { amount: { currency: 'USD', symbol: '$', amount: null }, units: null }),
    record('r4', { amount: null, units: 'n/a' }),
  ];

  it('sums money amounts without scaling them', () => {
    expect(lib.sumBy(rows, 'amount')).toBe(1750.5);
  });

  it('sums numbers and numeric strings, skipping empty and non-numeric values', () => {
    expect(lib.sumBy(rows, 'units')).toBe(5);
  });

  it('sums what valueOf returns when given', () => {
    expect(lib.sumBy(rows, 'units', (row) => (row.id === 'r4' ? 10 : 1))).toBe(13);
  });

  it('is zero for no records', () => {
    expect(lib.sumBy([], 'amount')).toBe(0);
  });
});
