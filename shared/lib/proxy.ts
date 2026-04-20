export type ProxyLogEntry =
  | { kind: 'request'; method: string; status: number; fromCache: boolean; url: string }
  | { kind: 'info'; message: string };

export function proxyLogEntryToString(entry: ProxyLogEntry): string {
  if (entry.kind === 'info') {
    return entry.message;
  }

  const cache = entry.fromCache ? ' [cache]' : '';

  return `${entry.method} ${entry.url} → ${String(entry.status)}${cache}`;
}
