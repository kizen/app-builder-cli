import { useState, useSyncExternalStore, type FC } from 'react';
import {
  clearNavigationEvents,
  getNavigationEvents,
  subscribeNavigation,
  type NavigationEvent,
  type NavigationEventStatus,
} from '../lib/navigationContext.js';

const STATUS_STYLES: Record<NavigationEventStatus, string> = {
  delivered: 'bg-green-100 text-green-700',
  consumed: 'bg-blue-100 text-blue-700',
  cleared: 'bg-neutral-200 text-neutral-600',
  ignoredExternal: 'bg-amber-100 text-amber-700',
};

const STATUS_LABELS: Record<NavigationEventStatus, string> = {
  delivered: 'delivered',
  consumed: 'consumed',
  cleared: 'cleared',
  ignoredExternal: 'ignored (external)',
};

function formatTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

const NavigationLogRow: FC<{ event: NavigationEvent }> = ({ event }) => {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = event.payload !== undefined;

  return (
    <div className="border-b border-black/5 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-neutral-400">{formatTime(event.timestamp)}</span>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 uppercase tracking-widest text-[9px] text-neutral-500">
          {event.target}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-neutral-700">{event.url}</span>
        <span
          className={`rounded px-1.5 py-0.5 uppercase tracking-widest text-[9px] ${STATUS_STYLES[event.status]}`}
        >
          {STATUS_LABELS[event.status]}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-neutral-400">
        <span>context: {hasPayload ? 'yes' : 'no'}</span>
        {event.sessionDataKey !== undefined && (
          <span className="font-mono">key: {event.sessionDataKey}</span>
        )}
        {event.byteSize !== undefined && <span>{event.byteSize} bytes</span>}
        {hasPayload && (
          <button
            onClick={() => {
              setExpanded((prev) => !prev);
            }}
            className="text-neutral-500 underline decoration-dotted hover:text-neutral-700"
          >
            {expanded ? 'hide payload' : 'show payload'}
          </button>
        )}
      </div>
      {expanded && hasPayload && (
        <pre className="mt-1.5 overflow-auto rounded border border-black/10 bg-neutral-50 p-2 text-[11px] leading-5 text-neutral-700">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
};

export const NavigationLogSection: FC = () => {
  const events = useSyncExternalStore(subscribeNavigation, getNavigationEvents);

  if (events.length === 0) {
    return (
      <p className="m-0 text-[12px] text-neutral-400">
        No navigations captured yet. Call{' '}
        <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
          this.openWindow(&apos;/some/path&apos;, &apos;_self&apos;, {'{'} … {'}'})
        </code>{' '}
        from any script to send a navigation context and see it here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1 font-mono text-[11px]">
      <div className="flex justify-end">
        <button
          onClick={clearNavigationEvents}
          className="text-[11px] text-neutral-400 hover:text-neutral-700"
        >
          clear log
        </button>
      </div>
      {events
        .slice()
        .reverse()
        .map((event) => (
          <NavigationLogRow key={event.id} event={event} />
        ))}
    </div>
  );
};
