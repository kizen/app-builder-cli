import { describe, expect, it } from 'vitest';
import {
  emptyValues,
  FIELD_LABELS,
  FIELDS,
  inferApiName,
  normalizeFieldValue,
  REQUIRED_FIELDS,
  validateField,
} from './createForm.js';

describe('inferApiName', () => {
  it('lowercases the name', () => {
    expect(inferApiName('MyPlugin')).toBe('myplugin');
  });

  it('collapses each run of non-alphanumeric characters into a single underscore', () => {
    expect(inferApiName('My Great Plugin')).toBe('my_great_plugin');
    expect(inferApiName('My   Great---Plugin')).toBe('my_great_plugin');
    expect(inferApiName('a.b/c:d')).toBe('a_b_c_d');
  });

  it('trims leading and trailing underscores', () => {
    expect(inferApiName('  Hello World  ')).toBe('hello_world');
    expect(inferApiName('___Hello___')).toBe('hello');
    expect(inferApiName('!!!Hello!!!')).toBe('hello');
  });

  it('keeps digits and existing underscores as separators', () => {
    expect(inferApiName('Plugin 2 Go')).toBe('plugin_2_go');
    expect(inferApiName('already_slugged')).toBe('already_slugged');
  });

  it('returns an empty string when nothing alphanumeric survives', () => {
    expect(inferApiName('')).toBe('');
    expect(inferApiName('   ')).toBe('');
    expect(inferApiName('***')).toBe('');
  });

  it('drops non-ascii characters rather than transliterating them', () => {
    expect(inferApiName('Café Plugin')).toBe('caf_plugin');
  });

  it('is idempotent — re-slugifying a slug is a no-op', () => {
    const once = inferApiName('My Great Plugin!');

    expect(inferApiName(once)).toBe(once);
  });
});

describe('validateField', () => {
  it('rejects empty required fields with a labelled message', () => {
    expect(validateField('name', '')).toBe('Name is required');
    expect(validateField('apiName', '')).toBe('API name is required');
  });

  it('rejects whitespace-only required fields', () => {
    expect(validateField('name', '   ')).toBe('Name is required');
    expect(validateField('apiName', '\t \n')).toBe('API name is required');
  });

  it('accepts required fields with any non-whitespace content', () => {
    expect(validateField('name', 'My Plugin')).toBeUndefined();
    expect(validateField('apiName', '  padded  ')).toBeUndefined();
  });

  it('accepts optional fields left blank', () => {
    for (const field of FIELDS) {
      if (!REQUIRED_FIELDS.includes(field)) {
        expect(validateField(field, '')).toBeUndefined();
        expect(validateField(field, '   ')).toBeUndefined();
      }
    }
  });

  it('treats exactly name and apiName as required', () => {
    expect([...REQUIRED_FIELDS]).toEqual(['name', 'apiName']);
  });
});

describe('normalizeFieldValue', () => {
  it('trims every field except description', () => {
    for (const field of FIELDS) {
      if (field !== 'description') {
        expect(normalizeFieldValue(field, '  value  ')).toBe('value');
      }
    }
  });

  it('preserves whitespace in the description verbatim', () => {
    expect(normalizeFieldValue('description', '  a sentence.  ')).toBe('  a sentence.  ');
    expect(normalizeFieldValue('description', '\n line one\n line two\n')).toBe(
      '\n line one\n line two\n',
    );
  });
});

describe('field metadata', () => {
  it('labels every field', () => {
    for (const field of FIELDS) {
      expect(FIELD_LABELS[field]).toBeTruthy();
    }

    expect(Object.keys(FIELD_LABELS)).toHaveLength(FIELDS.length);
  });

  it('lists each field exactly once', () => {
    expect(new Set(FIELDS).size).toBe(FIELDS.length);
  });
});

describe('emptyValues', () => {
  it('blanks every field but seeds the business id', () => {
    expect(emptyValues('biz-123')).toEqual({
      name: '',
      apiName: '',
      externalLink: '',
      description: '',
      developerBusinessId: 'biz-123',
    });
  });

  it('covers exactly the declared fields', () => {
    expect(Object.keys(emptyValues('')).sort()).toEqual([...FIELDS].sort());
  });

  it('returns a fresh object each call', () => {
    expect(emptyValues('x')).not.toBe(emptyValues('x'));
  });
});
