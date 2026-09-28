const MAX_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 10;

const fieldCache = new Map();

export const formatNumber = (input, prefix = '') => {
  const n = Number.isNaN(Number(input)) ? 0 : Number(input);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 1) return `${sign}${prefix}${Number(abs.toFixed(4))}`;
  if (abs < 1000) return `${sign}${prefix}${Number(abs.toPrecision(5))}`;
  if (abs < 10000) return `${sign}${prefix}${Math.round(abs).toLocaleString()}`;
  const rounded = Number(abs.toPrecision(4));
  if (rounded >= 1e12) return `${prefix}999B+`;
  const [unit, suffix] = rounded >= 1e9 ? [1e9, 'B'] : rounded >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
  return `${sign}${prefix}${Number((rounded / unit).toPrecision(4))}${suffix}`;
};

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) =>
  value === null || value === undefined
    ? ''
    : String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

const describeError = (error) => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string') return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
};

const loadFields = async (ctx, object) => {
  const [data, error] = await ctx.getWithErrors(
    `/custom-objects/${encodeURIComponent(object)}/fields`,
  );
  if (error) {
    throw new Error(`Couldn't load fields for ${object}: ${describeError(error)}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`Couldn't load fields for ${object}: the response was not a list of fields`);
  }
  return data;
};

export const getFields = (ctx, object) => {
  if (!fieldCache.has(object)) {
    const pending = loadFields(ctx, object);
    fieldCache.set(object, pending);
    pending.catch(() => {
      if (fieldCache.get(object) === pending) fieldCache.delete(object);
    });
  }
  return fieldCache.get(object);
};

export const fieldByName = (fields, name) => fields.find((field) => field.name === name);

const nonCustomFilter = (field, condition, value) => ({
  type: 'fields_v2',
  subtype: 'non_custom',
  field,
  condition,
  value,
});

export const blockFilters = (args, fields) => {
  const filters = [];
  const unapplied = [];
  const dateFilter = args?.dateFilter;
  const teamFilter = args?.teamFilter;

  if (dateFilter) {
    if (dateFilter.start && dateFilter.end) {
      filters.push(nonCustomFilter('created', 'between', [dateFilter.start, dateFilter.end]));
    } else {
      unapplied.push('dateFilter');
    }
  }

  const teamMembers = teamFilter?.teamMembers ?? [];
  const roles = teamFilter?.roles ?? [];

  if (teamMembers.length > 0) {
    if (fieldByName(fields, 'owner')) {
      filters.push(nonCustomFilter('owner', 'is_any_of', [...teamMembers]));
    } else {
      unapplied.push('teamFilter');
    }
  } else if (roles.length > 0) {
    unapplied.push('teamFilter');
  }

  return { filters, unapplied };
};

export const dropdownFilter = (field, optionNameOrNames) => {
  const names = Array.isArray(optionNameOrNames) ? optionNameOrNames : [optionNameOrNames];
  const ids = names.map((name) => {
    const option = (field.options ?? []).find((candidate) => candidate.name === name);
    if (!option) {
      throw new Error(`${field.display_name ?? field.name} has no option named "${name}"`);
    }
    return option.id;
  });
  const multiple = Array.isArray(optionNameOrNames);
  return {
    type: 'fields_v2',
    subtype: 'custom',
    field: `custom::${field.id}`,
    condition: multiple ? 'is_any_of' : '=',
    value: multiple ? ids : ids[0],
  };
};

export const searchRecords = async (
  ctx,
  {
    object,
    fieldNames,
    filters = [],
    pageSize = MAX_PAGE_SIZE,
    maxPages = DEFAULT_MAX_PAGES,
    ordering,
  },
) => {
  const size = Number.isFinite(Number(pageSize))
    ? Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(pageSize))))
    : MAX_PAGE_SIZE;
  const pages = Number.isFinite(Number(maxPages))
    ? Math.max(1, Math.floor(Number(maxPages)))
    : DEFAULT_MAX_PAGES;
  const body = {
    field_names: fieldNames,
    query: Array.isArray(filters) && filters.length > 0 ? [{ and: true, filters }] : [],
  };
  const orderingParam = ordering ? `&ordering=${encodeURIComponent(ordering)}` : '';
  const records = [];
  let count = 0;
  let hasMore = false;

  for (let page = 1; page <= pages; page += 1) {
    const [data, error] = await ctx.postWithErrors(
      `/records/${encodeURIComponent(object)}/search?page_size=${size}&page=${page}${orderingParam}`,
      body,
    );
    if (error) {
      throw new Error(`Couldn't search ${object}: ${describeError(error)}`);
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    records.push(...results);
    count = typeof data?.count === 'number' ? data.count : records.length;
    hasMore = Boolean(data?.next) && results.length > 0;
    if (!hasMore) break;
  }

  return { records, count, truncated: hasMore || count > records.length };
};

const fieldEntry = (record, name) =>
  Object.values(record?.fields ?? {}).find((entry) => entry?.name === name);

export const fieldValue = (record, name) => fieldEntry(record, name)?.value;

const labelOf = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(labelOf).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if ('amount' in value) {
      if (value.amount === null || value.amount === undefined || value.amount === '') return '';
      return formatNumber(Number(value.amount), value.symbol ?? '');
    }
    if ('first_name' in value || 'last_name' in value) {
      const fullName = [value.first_name, value.last_name].filter(Boolean).join(' ');
      return fullName || value.email || '';
    }
    return String(value.name ?? value.display_name ?? '');
  }
  return String(value);
};

export const fieldLabel = (record, name) => labelOf(fieldValue(record, name));

const keyOf = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return String(value.id ?? labelOf(value));
  return String(value);
};

const valuesOf = (value) => {
  if (Array.isArray(value)) return value.length > 0 ? value : [null];
  return [value];
};

export const countBy = (records, name, field) => {
  const groups = new Map();

  for (const record of records) {
    for (const value of valuesOf(fieldValue(record, name))) {
      const key = keyOf(value);
      const group = groups.get(key);
      if (group) {
        group.count += 1;
      } else {
        groups.set(key, { key, label: labelOf(value), count: 1 });
      }
    }
  }

  const order = new Map(
    (field?.options ?? [])
      .filter((option) => typeof option.order === 'number' && Number.isFinite(option.order))
      .map((option) => [String(option.id), option.order]),
  );
  const rank = (key) => (order.has(key) ? order.get(key) : Number.POSITIVE_INFINITY);

  return [...groups.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const ra = rank(a.key);
    const rb = rank(b.key);
    return ra === rb ? 0 : ra < rb ? -1 : 1;
  });
};

const numberOf = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const raw = typeof value === 'object' ? value.amount : value;
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

export const sumBy = (records, name, valueOf) =>
  records.reduce(
    (total, record) =>
      total + (valueOf ? numberOf(valueOf(record)) : numberOf(fieldValue(record, name))),
    0,
  );
