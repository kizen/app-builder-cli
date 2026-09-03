import { describe, expect, it } from 'vitest';
import { buildStepInputs, normalizeStepInputs, toStepInputValue } from './execution.js';

describe('toStepInputValue', () => {
  it('treats an untouched field as absent', () => {
    expect(toStepInputValue(undefined)).toBe(null);
    expect(toStepInputValue(null)).toBe(null);
  });

  it('treats an empty field as absent', () => {
    expect(toStepInputValue('')).toBe(null);
  });

  it('treats a whitespace-only field as absent', () => {
    expect(toStepInputValue('   ')).toBe(null);
    expect(toStepInputValue('\t\n')).toBe(null);
  });

  it('passes a supplied value through untrimmed', () => {
    expect(toStepInputValue('1')).toBe('1');
    expect(toStepInputValue(' padded ')).toBe(' padded ');
  });

  it('keeps values that are falsy as strings', () => {
    expect(toStepInputValue('0')).toBe('0');
    expect(toStepInputValue('false')).toBe('false');
  });
});

describe('buildStepInputs', () => {
  it('includes every declared input even when nothing was entered', () => {
    expect(buildStepInputs(['header_row', 'sheet_name'], {})).toEqual({
      header_row: null,
      sheet_name: null,
    });
  });

  it('sends null rather than empty string for a blank input', () => {
    expect(buildStepInputs(['header_row'], { header_row: '' })).toEqual({ header_row: null });
  });

  it('keeps supplied values', () => {
    expect(buildStepInputs(['header_row', 'sheet_name'], { header_row: '2' })).toEqual({
      header_row: '2',
      sheet_name: null,
    });
  });

  it('ignores stored values for inputs the step no longer declares', () => {
    expect(buildStepInputs(['kept'], { kept: 'a', removed: 'b' })).toEqual({ kept: 'a' });
  });
});

describe('normalizeStepInputs', () => {
  it('returns an empty map when the body carried no inputs', () => {
    expect(normalizeStepInputs(undefined)).toEqual({});
  });

  it('converts a blank value posted by a non-viewer caller to null', () => {
    expect(normalizeStepInputs({ header_row: '' })).toEqual({ header_row: null });
    expect(normalizeStepInputs({ header_row: '  ' })).toEqual({ header_row: null });
  });

  it('passes null through', () => {
    expect(normalizeStepInputs({ header_row: null })).toEqual({ header_row: null });
  });

  it('renders non-string scalars as text', () => {
    expect(normalizeStepInputs({ n: 5, b: false })).toEqual({ n: '5', b: 'false' });
  });

  it('serializes objects and arrays rather than stringifying them badly', () => {
    expect(normalizeStepInputs({ rows: [1, 2] })).toEqual({ rows: '[1,2]' });
    expect(normalizeStepInputs({ o: { a: 1 } })).toEqual({ o: '{"a":1}' });
  });
});
