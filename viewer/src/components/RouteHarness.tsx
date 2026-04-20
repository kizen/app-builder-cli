import { useEffect, useRef, useState, type FC } from 'react';

const ROUTE_CHANGE_EVENT = 'integration:route-change';

interface PartialLocation {
  host: string;
  hash: string;
  href: string;
  origin: string;
  pathname: string;
  search: string;
  port: string;
  protocol: string;
}

interface RouteEvent {
  time: Date;
  location: PartialLocation;
}

const inputClass =
  'w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-[12px] font-mono text-neutral-200 focus:outline-none focus:border-neutral-500';

const labelClass =
  'block text-[11px] font-semibold uppercase tracking-widest text-neutral-600 mb-1';

function formatTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

export const RouteHarness: FC = () => {
  const [pathname, setPathname] = useState('/');
  const [search, setSearch] = useState('');
  const [hash, setHash] = useState('');
  const [events, setEvents] = useState<RouteEvent[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ location: PartialLocation }>;

      setEvents((prev) => [...prev, { time: new Date(), location: ce.detail.location }].slice(-50));
    };

    window.addEventListener(ROUTE_CHANGE_EVENT, handler);

    return () => {
      window.removeEventListener(ROUTE_CHANGE_EVENT, handler);
    };
  }, []);

  const dispatch = (): void => {
    const normalizedSearch = search && !search.startsWith('?') ? `?${search}` : search;
    const normalizedHash = hash && !hash.startsWith('#') ? `#${hash}` : hash;
    const location: PartialLocation = {
      host: window.location.host,
      origin: window.location.origin,
      port: window.location.port,
      protocol: window.location.protocol,
      pathname,
      search: normalizedSearch,
      hash: normalizedHash,
      href: `${window.location.origin}${pathname}${normalizedSearch}${normalizedHash}`,
    };

    window.dispatchEvent(new CustomEvent(ROUTE_CHANGE_EVENT, { detail: { location } }));
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      dispatch();
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 pb-3">
      {/* Dispatch form */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className={labelClass}>Search</label>
            <input
              type="text"
              className={inputClass}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              placeholder="?tab=notes"
              spellCheck={false}
            />
          </div>
          <div className="flex-1">
            <label className={labelClass}>Hash</label>
            <input
              type="text"
              className={inputClass}
              value={hash}
              onChange={(e) => {
                setHash(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              placeholder="#section"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className={labelClass}>Pathname</label>
            <input
              type="text"
              className={inputClass}
              value={pathname}
              onChange={(e) => {
                setPathname(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              placeholder="/client/abc-123/overview"
              spellCheck={false}
            />
          </div>
          <button
            onClick={dispatch}
            className="rounded bg-neutral-700 px-3 py-1.5 text-[12px] font-semibold text-neutral-200 hover:bg-neutral-600 active:bg-neutral-500"
          >
            Dispatch
          </button>
        </div>
      </div>

      {/* Event stream */}
      <div className="flex flex-col border-t border-neutral-800 pt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
            Navigation Event Stream
          </span>
          {events.length > 0 && (
            <button
              onClick={() => {
                setEvents([]);
              }}
              className="text-[11px] text-neutral-600 hover:text-neutral-300"
            >
              clear
            </button>
          )}
        </div>
        <div className="max-h-40 overflow-y-auto">
          {events.length === 0 ? (
            <p className="text-[12px] text-neutral-600">No events yet.</p>
          ) : (
            events.map((evt, i) => (
              <div
                key={i}
                className={`px-2 py-0.5 font-mono text-[11px] leading-5 ${i % 2 === 0 ? 'bg-neutral-900' : 'bg-neutral-800/40'}`}
              >
                <span className="text-neutral-600">{formatTime(evt.time)}</span>
                <span className="ml-2 text-neutral-300">{evt.location.pathname}</span>
                {evt.location.search && (
                  <span className="text-neutral-500">{evt.location.search}</span>
                )}
                {evt.location.hash && <span className="text-neutral-500">{evt.location.hash}</span>}
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
};
