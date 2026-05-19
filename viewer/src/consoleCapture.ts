export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info';
  args: unknown[];
}

const LIMIT = 500;
const listeners = new Set<() => void>();

let snapshot: readonly ConsoleEntry[] = [];

export function pushConsole(entry: ConsoleEntry): void {
  const next = snapshot.length >= LIMIT ? snapshot.slice(snapshot.length - LIMIT + 1) : snapshot;

  snapshot = [...next, entry];

  for (const listener of listeners) {
    listener();
  }
}

export function getConsoleLogs(): readonly ConsoleEntry[] {
  return snapshot;
}

export function clearConsoleLogs(): void {
  snapshot = [];

  for (const listener of listeners) {
    listener();
  }
}

export function subscribeConsole(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
