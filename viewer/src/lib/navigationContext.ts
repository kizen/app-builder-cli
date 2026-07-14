// Capture store for plugin-triggered navigations that carry a "navigation
// context" payload (engine 1.8.0). The engine transmits context out-of-band via
// sessionStorage and only leaves a `session_data_key` on the URL; this store
// records what was transmitted so the harness can show it. It mirrors the
// module-level subscribe/snapshot shape of consoleCapture.ts so React can read
// it with useSyncExternalStore.

import { readNavigationContext } from '@kizenapps/engine';

const STORAGE_KEY_PREFIX = 'kizen-app-context';

// The engine appends the context key under this query param but does not export
// the constant from its package root, so we mirror it here. Keep in sync with
// SESSION_DATA_PARAM in @kizenapps/engine's communication/storage.
export const SESSION_DATA_PARAM = 'session_data_key';

export type NavigationEventStatus = 'delivered' | 'consumed' | 'cleared' | 'ignoredExternal';

export interface NavigationEvent {
  id: string;
  timestamp: number;
  url: string;
  target: string;
  sessionDataKey?: string;
  payload?: Record<string, unknown>;
  byteSize?: number;
  status: NavigationEventStatus;
}

const LIMIT = 200;
const listeners = new Set<() => void>();

let snapshot: readonly NavigationEvent[] = [];

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeNavigation(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function getNavigationEvents(): readonly NavigationEvent[] {
  return snapshot;
}

export function clearNavigationEvents(): void {
  snapshot = [];

  emit();
}

function pushEvent(event: NavigationEvent): void {
  const next = snapshot.length >= LIMIT ? snapshot.slice(snapshot.length - LIMIT + 1) : snapshot;

  snapshot = [...next, event];

  emit();
}

// Reflects a destination-page action in the log by re-statusing the most recent
// delivered event for a given key (a key is only ever delivered once).
export function markNavigationEvent(sessionDataKey: string, status: NavigationEventStatus): void {
  for (let i = snapshot.length - 1; i >= 0; i -= 1) {
    const existing = snapshot[i];

    if (existing?.sessionDataKey === sessionDataKey) {
      const next = snapshot.slice();

      next[i] = { ...existing, status };
      snapshot = next;

      emit();

      return;
    }
  }
}

// Extracts and validates the engine's context key from a url. Rejects keys not
// minted by the engine (must carry the kizen-app-context- prefix), matching the
// engine's own guard so a crafted param can't be mistaken for real context.
export function parseSessionDataKey(url: string): string | undefined {
  try {
    const key = new URL(url, window.location.origin).searchParams.get(SESSION_DATA_PARAM);

    return key?.startsWith(`${STORAGE_KEY_PREFIX}-`) ? key : undefined;
  } catch {
    return undefined;
  }
}

export function byteSizeOf(payload: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function payloadFields(
  payload: Record<string, unknown> | undefined,
): Pick<NavigationEvent, 'payload' | 'byteSize'> {
  // exactOptionalPropertyTypes: omit the optional keys entirely when absent
  // rather than assigning `undefined`.
  return payload === undefined ? {} : { payload, byteSize: byteSizeOf(payload) };
}

// _self capture: the engine leaves the context in this tab's sessionStorage
// (the same-tab navigation preserves it), so we read — not consume — it, log the
// delivery, and let the caller navigate.
export function captureSelfNavigation(path: string): void {
  const sessionDataKey = parseSessionDataKey(path);

  if (!sessionDataKey) {
    return;
  }

  pushEvent({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    url: path,
    target: '_self',
    sessionDataKey,
    status: 'delivered',
    ...payloadFields(readNavigationContext(path)),
  });
}

// _blank capture (the race): the engine deletes the sessionStorage entry
// synchronously right after window.open returns, banking on a real browser
// having already copied storage into the new tab at creation. Here the opener
// and the simulated destination tab share one real sessionStorage, so we
// snapshot the payload before returning and re-insert it under the same key in a
// microtask — which runs after the engine's synchronous removeItem — so the
// engine reader helpers behave identically in the simulated destination.
// Fidelity limit: a genuine new tab gets its own storage copy; here it is one
// shared store, so a later opener-side write would also be visible "in" the tab.
export function captureWindowOpen(url: string, target: string): void {
  const sessionDataKey = parseSessionDataKey(url);

  if (sessionDataKey) {
    const raw = sessionStorage.getItem(sessionDataKey);
    const payload = readNavigationContext(url);

    if (raw !== null) {
      queueMicrotask(() => {
        // Best-effort: the re-insert can throw (quota exceeded, storage
        // disabled). Swallow it — an unhandled microtask throw would break the
        // sandbox even though the navigation itself already succeeded.
        try {
          sessionStorage.setItem(sessionDataKey, raw);
        } catch {
          // ignore: the simulated destination simply reads no context
        }
      });
    }

    pushEvent({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      url,
      target,
      sessionDataKey,
      status: 'delivered',
      ...payloadFields(payload),
    });

    return;
  }

  if (isExternalUrl(url)) {
    // External/cross-origin: the engine never attaches context to these targets,
    // so any context a script tried to pass rides along nowhere — it is dropped
    // by design. We still log the navigation so that behavior is observable.
    pushEvent({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      url,
      target,
      status: 'ignoredExternal',
    });
  }
}
