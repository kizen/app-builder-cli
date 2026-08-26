import { describe, expect, it } from 'vitest';
import { FILE_WATCH_DEBOUNCE_MS, LOG_DISPLAY, LOG_LIMIT, MIME_TYPES } from './constants.js';

describe('constants', () => {
  it('keeps the log display window within the retained log buffer', () => {
    expect(LOG_DISPLAY).toBeGreaterThan(0);
    expect(LOG_DISPLAY).toBeLessThanOrEqual(LOG_LIMIT);
  });

  it('uses a positive rebuild debounce', () => {
    expect(FILE_WATCH_DEBOUNCE_MS).toBeGreaterThan(0);
  });

  it('maps every extension key to a leading-dot, lowercase extension', () => {
    const extensions = Object.keys(MIME_TYPES);

    expect(extensions.length).toBeGreaterThan(0);

    for (const extension of extensions) {
      expect(extension).toMatch(/^\.[a-z0-9]+$/);
    }
  });

  it('serves text-based types with an explicit utf-8 charset', () => {
    for (const extension of ['.html', '.js', '.mjs', '.css', '.json'] as const) {
      expect(MIME_TYPES[extension]).toContain('charset=utf-8');
    }
  });

  it('maps both javascript extensions to the same type', () => {
    expect(MIME_TYPES['.mjs']).toBe(MIME_TYPES['.js']);
  });
});
