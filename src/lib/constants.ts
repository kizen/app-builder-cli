/** Maximum number of log entries retained per log channel. */
export const LOG_LIMIT = 50;

/** Number of log lines visible in each TUI log panel. */
export const LOG_DISPLAY = 8;

/** Debounce delay for file-watcher triggered rebuilds (ms). */
export const FILE_WATCH_DEBOUNCE_MS = 150;

export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};
