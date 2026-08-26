import { describe, expect, it } from 'vitest';
import { formatBytes } from './formatBytes.js';

describe('formatBytes', () => {
  it('reports raw bytes below 1 KiB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('switches to kibibytes at 1024 bytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('uses one decimal place for kibibytes', () => {
    expect(formatBytes(1024 * 10)).toBe('10.0 KB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
  });

  it('switches to mebibytes at 1 MiB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
  });

  it('uses two decimal places for mebibytes', () => {
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.50 MB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.00 MB');
  });

  it('keeps scaling into large mebibyte values', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1024.00 MB');
  });

  it('rounds rather than truncating', () => {
    expect(formatBytes(1024 + 100)).toBe('1.1 KB');
  });
});
