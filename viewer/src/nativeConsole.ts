// Captured at module-load time, before App's useEffect overrides console methods.
// Import these anywhere you want to log without triggering the console capture state update.
export const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};
