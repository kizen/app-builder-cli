export interface MoveCursorOptions {
  disabled?: readonly boolean[];
}

export interface VisibleWindow {
  start: number;
  end: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function moveCursor(
  cursor: number,
  length: number,
  delta: number,
  options: MoveCursorOptions = {},
): number {
  if (length <= 0) {
    return 0;
  }

  const current = clamp(Math.trunc(cursor) || 0, 0, length - 1);
  const isEnabled = (index: number): boolean => options.disabled?.[index] !== true;

  if (delta === 0) {
    return current;
  }

  const step = delta > 0 ? 1 : -1;

  if (Math.abs(delta) === 1) {
    for (let offset = 1; offset <= length; offset++) {
      const index = (((current + step * offset) % length) + length) % length;

      if (isEnabled(index)) {
        return index;
      }
    }

    return current;
  }

  const target = clamp(current + Math.trunc(delta), 0, length - 1);

  for (let index = target; index >= 0 && index < length; index += step) {
    if (isEnabled(index)) {
      return index;
    }
  }

  for (let index = target - step; index >= 0 && index < length; index -= step) {
    if (isEnabled(index)) {
      return index;
    }
  }

  return current;
}

export function visibleWindow(cursor: number, length: number, size = 10): VisibleWindow {
  if (length <= 0) {
    return { start: 0, end: 0 };
  }

  const rows = Math.max(1, Math.floor(size));

  if (length <= rows) {
    return { start: 0, end: length };
  }

  const current = clamp(Math.trunc(cursor) || 0, 0, length - 1);
  const start = clamp(current - Math.floor(rows / 2), 0, length - rows);

  return { start, end: start + rows };
}
