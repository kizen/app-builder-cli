import { describe, expect, it } from 'vitest';
import { CUSTOM_ICON_NAMES, VALID_ICONS, VALID_ICONS_LIST } from './validIcons.js';

describe('VALID_ICONS', () => {
  it('is a non-empty set', () => {
    expect(VALID_ICONS.size).toBeGreaterThan(0);
  });

  it('contains only lowercase kebab-case names', () => {
    for (const icon of VALID_ICONS) {
      expect(icon).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('has no blank or padded entries', () => {
    for (const icon of VALID_ICONS) {
      expect(icon).toBe(icon.trim());
      expect(icon).not.toBe('');
    }
  });
});

describe('VALID_ICONS_LIST', () => {
  it('mirrors the set exactly', () => {
    expect(VALID_ICONS_LIST).toHaveLength(VALID_ICONS.size);
    expect(new Set(VALID_ICONS_LIST)).toEqual(VALID_ICONS);
  });

  it('has no duplicates', () => {
    expect(new Set(VALID_ICONS_LIST).size).toBe(VALID_ICONS_LIST.length);
  });

  it('stays sorted', () => {
    expect(VALID_ICONS_LIST).toEqual([...VALID_ICONS_LIST].sort());
  });
});

describe('CUSTOM_ICON_NAMES', () => {
  it('lists the Kizen-brand icons that have no FontAwesome equivalent', () => {
    expect([...CUSTOM_ICON_NAMES].sort()).toEqual(['form-entity', 'kizen-k']);
  });

  it('uses the same naming convention as the rest of the icons', () => {
    for (const icon of CUSTOM_ICON_NAMES) {
      expect(icon).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
