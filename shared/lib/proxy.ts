export type ProxyLogEntry =
  | {
      kind: 'request';
      method: string;
      status: number;
      // For calls to Kizen's `/external-integrations/proxy` endpoint, the
      // third-party API's status is carried in the response body (`status_code`)
      // rather than the HTTP status. `status` is the proxy status; this is the
      // upstream one. Undefined for non-proxy calls.
      upstreamStatus?: number | undefined;
      fromCache: boolean;
      url: string;
    }
  | { kind: 'info'; message: string };

export function proxyLogEntryToString(entry: ProxyLogEntry): string {
  if (entry.kind === 'info') {
    return entry.message;
  }

  const cache = entry.fromCache ? ' [cache]' : '';
  const upstream =
    entry.upstreamStatus !== undefined ? ` (upstream ${String(entry.upstreamStatus)})` : '';

  return `${entry.method} ${entry.url} → ${String(entry.status)}${upstream}${cache}`;
}
