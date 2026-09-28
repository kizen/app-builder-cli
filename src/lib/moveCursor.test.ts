import { describe, expect, it } from 'vitest';
import { moveCursor, visibleWindow } from './moveCursor.js';

describe('moveCursor', () => {
  it('returns 0 for an empty list', () => {
    expect(moveCursor(0, 0, 1)).toBe(0);
    expect(moveCursor(5, 0, -1)).toBe(0);
    expect(moveCursor(3, 0, 10)).toBe(0);
  });

  it('moves by one within range', () => {
    expect(moveCursor(0, 5, 1)).toBe(1);
    expect(moveCursor(3, 5, -1)).toBe(2);
  });

  it('wraps around at both ends', () => {
    expect(moveCursor(0, 5, -1)).toBe(4);
    expect(moveCursor(4, 5, 1)).toBe(0);
  });

  it('stays put in a single-item list', () => {
    expect(moveCursor(0, 1, 1)).toBe(0);
    expect(moveCursor(0, 1, -1)).toBe(0);
  });

  it('returns the clamped cursor for a zero delta', () => {
    expect(moveCursor(2, 5, 0)).toBe(2);
    expect(moveCursor(9, 5, 0)).toBe(4);
    expect(moveCursor(-3, 5, 0)).toBe(0);
  });

  it('clamps an out-of-range cursor before moving', () => {
    expect(moveCursor(9, 5, -1)).toBe(3);
    expect(moveCursor(9, 5, 1)).toBe(0);
    expect(moveCursor(-2, 5, 1)).toBe(1);
    expect(moveCursor(-2, 5, -1)).toBe(4);
  });

  it('treats a non-finite cursor as 0', () => {
    expect(moveCursor(Number.NaN, 5, 1)).toBe(1);
  });

  it('skips disabled items in the direction of travel', () => {
    const disabled = [false, true, true, false, false];

    expect(moveCursor(0, 5, 1, { disabled })).toBe(3);
    expect(moveCursor(3, 5, -1, { disabled })).toBe(0);
  });

  it('skips disabled items across the wrap boundary', () => {
    const disabled = [true, false, false, true];

    expect(moveCursor(2, 4, 1, { disabled })).toBe(1);
    expect(moveCursor(1, 4, -1, { disabled })).toBe(2);
  });

  it('treats a short disabled array as enabled beyond its length', () => {
    expect(moveCursor(0, 4, 1, { disabled: [false, true] })).toBe(2);
  });

  it('returns to the same item when it is the only enabled one', () => {
    const disabled = [true, false, true];

    expect(moveCursor(1, 3, 1, { disabled })).toBe(1);
    expect(moveCursor(1, 3, -1, { disabled })).toBe(1);
  });

  it('moves off a disabled cursor to the next enabled item', () => {
    expect(moveCursor(1, 4, 1, { disabled: [false, true, false, false] })).toBe(2);
  });

  it('returns the clamped cursor when every item is disabled', () => {
    const disabled = [true, true, true];

    expect(moveCursor(1, 3, 1, { disabled })).toBe(1);
    expect(moveCursor(1, 3, -1, { disabled })).toBe(1);
    expect(moveCursor(7, 3, 1, { disabled })).toBe(2);
    expect(moveCursor(0, 3, 5, { disabled })).toBe(0);
  });

  describe('page jumps', () => {
    it('jumps by the delta', () => {
      expect(moveCursor(0, 30, 10)).toBe(10);
      expect(moveCursor(25, 30, -10)).toBe(15);
    });

    it('clamps instead of wrapping', () => {
      expect(moveCursor(25, 30, 10)).toBe(29);
      expect(moveCursor(3, 30, -10)).toBe(0);
      expect(moveCursor(29, 30, 10)).toBe(29);
      expect(moveCursor(0, 30, -10)).toBe(0);
    });

    it('skips disabled items forward in the direction of travel', () => {
      const disabled = Array.from({ length: 20 }, (_, i) => i >= 10 && i <= 12);

      expect(moveCursor(0, 20, 10, { disabled })).toBe(13);
      expect(moveCursor(19, 20, -8, { disabled })).toBe(9);
    });

    it('searches backward when nothing is enabled past the target', () => {
      const disabled = Array.from({ length: 20 }, (_, i) => i >= 14);

      expect(moveCursor(5, 20, 10, { disabled })).toBe(13);
      expect(moveCursor(19, 20, 10, { disabled })).toBe(13);
    });

    it('searches backward toward the end when paging up into disabled rows', () => {
      const disabled = Array.from({ length: 20 }, (_, i) => i <= 6);

      expect(moveCursor(12, 20, -10, { disabled })).toBe(7);
    });
  });
});

describe('visibleWindow', () => {
  it('returns an empty window for an empty list', () => {
    expect(visibleWindow(0, 0)).toEqual({ start: 0, end: 0 });
  });

  it('shows everything when the list fits', () => {
    expect(visibleWindow(0, 3)).toEqual({ start: 0, end: 3 });
    expect(visibleWindow(9, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(2, 5, 5)).toEqual({ start: 0, end: 5 });
  });

  it('defaults to 10 rows', () => {
    expect(visibleWindow(0, 50)).toEqual({ start: 0, end: 10 });
  });

  it('pins the window to the start near the top', () => {
    expect(visibleWindow(0, 50, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(4, 50, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(5, 50, 10)).toEqual({ start: 0, end: 10 });
  });

  it('centers the cursor in the middle', () => {
    expect(visibleWindow(20, 50, 10)).toEqual({ start: 15, end: 25 });
    expect(visibleWindow(20, 50, 5)).toEqual({ start: 18, end: 23 });
  });

  it('pins the window to the end near the bottom', () => {
    expect(visibleWindow(49, 50, 10)).toEqual({ start: 40, end: 50 });
    expect(visibleWindow(46, 50, 10)).toEqual({ start: 40, end: 50 });
  });

  it('always keeps the cursor inside the window', () => {
    for (let cursor = 0; cursor < 23; cursor++) {
      const { start, end } = visibleWindow(cursor, 23, 7);

      expect(end - start).toBe(7);
      expect(cursor).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(end);
    }
  });

  it('clamps an out-of-range cursor', () => {
    expect(visibleWindow(100, 50, 10)).toEqual({ start: 40, end: 50 });
    expect(visibleWindow(-5, 50, 10)).toEqual({ start: 0, end: 10 });
  });

  it('shows at least one row for a degenerate size', () => {
    expect(visibleWindow(3, 10, 0)).toEqual({ start: 3, end: 4 });
    expect(visibleWindow(3, 10, 1)).toEqual({ start: 3, end: 4 });
  });
});
