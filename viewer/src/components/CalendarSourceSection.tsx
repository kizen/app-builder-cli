import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faSpinner,
  faTriangleExclamation,
  faExternalLink,
  faChevronLeft,
  faChevronRight,
} from '@fortawesome/free-solid-svg-icons';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import type { DatesSetArg, EventClickArg, EventContentArg, EventInput } from '@fullcalendar/core';
import { useCalendarOptions, useCalendarEvents } from '@kizenapps/engine/react';
import type { CalendarDefinition, CalendarSourceConfig } from '@kizenapps/engine';
import { Dialog, DialogHeader } from './Dialog.js';
import { calendarHarnessSelectionKey } from '../lib/storageKeys.js';
import { WhenBadge } from './WhenBadge.js';
import type { UnknownJSON } from '@kizenapps/engine';

interface CalendarEvent {
  id: string;
  calendar_id: string;
  title: string;
  start_time: number;
  end_time: number;
  description?: string;
  url?: string;
  activity_id?: string;
  all_day?: boolean;
  busy?: boolean;
  [key: string]: unknown;
}

type CalendarSourceWithWhen = CalendarSourceConfig & { when?: string };

interface CalendarSourceSectionProps {
  calendarSources: CalendarSourceConfig[];
  pluginApiName: string;
  whenState?: Record<string, UnknownJSON>;
}

const toYMD = (d: Date): string => {
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

const hashToHue = (s: string): number => {
  let h = 0;

  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }

  return Math.abs(h) % 360;
};

const sourceColor = (apiName: string): string => `hsl(${String(hashToHue(apiName))}, 65%, 45%)`;

const selectionKey = (pluginApiName: string, sourceApiName: string, calendarId: string): string =>
  `${pluginApiName}::${sourceApiName}::${calendarId}`;

const storageKey = calendarHarnessSelectionKey;

const formatDateTime = (ms: number, allDay: boolean): string => {
  const d = new Date(ms);

  if (allDay) {
    return d.toLocaleDateString();
  }

  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
};

interface EventDetailProps {
  event: CalendarEvent;
  sourceName: string;
  sourceApiName: string;
  calendarName: string;
  onClose: () => void;
}

const EventDetail: FC<EventDetailProps> = ({
  event,
  sourceName,
  sourceApiName,
  calendarName,
  onClose,
}) => {
  return (
    <Dialog
      open
      size="lg"
      onBackdropClick={onClose}
      header={<DialogHeader title={event.title} onClose={onClose} />}
    >
      <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 py-4 text-[12px] text-neutral-700">
        <div className="grid grid-cols-[100px_1fr] gap-y-1.5">
          <span className="text-neutral-400">Start</span>
          <span>{formatDateTime(event.start_time, event.all_day ?? false)}</span>
          <span className="text-neutral-400">End</span>
          <span>{formatDateTime(event.end_time, event.all_day ?? false)}</span>
          <span className="text-neutral-400">All day</span>
          <span>{event.all_day === true ? 'yes' : 'no'}</span>
          {event.busy !== undefined && (
            <>
              <span className="text-neutral-400">Busy</span>
              <span>{event.busy ? 'yes' : 'no'}</span>
            </>
          )}
          <span className="text-neutral-400">Calendar</span>
          <span>{calendarName}</span>
          <span className="text-neutral-400">Source</span>
          <span>
            {sourceName} <span className="text-neutral-400">({sourceApiName})</span>
          </span>
          <span className="text-neutral-400">Event id</span>
          <span className="truncate">{event.id}</span>
          {event.activity_id !== undefined && (
            <>
              <span className="text-neutral-400">Activity id</span>
              <span className="truncate">{event.activity_id}</span>
            </>
          )}
          {event.url !== undefined && (
            <>
              <span className="text-neutral-400">URL</span>
              <a
                href={event.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 truncate text-blue-600 hover:underline"
              >
                {event.url}
                <FontAwesomeIcon icon={faExternalLink} className="text-[10px]" />
              </a>
            </>
          )}
        </div>

        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Raw payload
          </div>
          <pre className="max-h-[40vh] overflow-auto rounded bg-neutral-50 p-3 text-[11px] leading-relaxed text-neutral-800">
            {JSON.stringify(event, null, 2)}
          </pre>
        </div>
      </div>
    </Dialog>
  );
};

export const CalendarSourceSection: FC<CalendarSourceSectionProps> = ({
  calendarSources,
  pluginApiName,
  whenState,
}) => {
  const calendarRef = useRef<FullCalendar>(null);
  const [currentView, setCurrentView] = useState('dayGridMonth');
  const [calendarTitle, setCalendarTitle] = useState('');

  const {
    calendars: calendarsByPlugin,
    errorServices,
    isLoading: calendarsLoading,
  } = useCalendarOptions(true, calendarSources);

  // Group sources with their calendars, keyed by source api_name (stable across re-renders)
  const groupedSources = useMemo(() => {
    interface Group {
      source: CalendarSourceConfig;
      calendars: CalendarDefinition[];
    }
    const groups = new Map<string, Group>();

    for (const list of Object.values(calendarsByPlugin)) {
      for (const entry of list) {
        const existing = groups.get(entry.source.api_name);

        if (existing) {
          existing.calendars.push(entry.calendar);
        } else {
          groups.set(entry.source.api_name, {
            source: entry.source,
            calendars: [entry.calendar],
          });
        }
      }
    }

    // Include sources from the bundle even if their calendars query failed
    for (const source of calendarSources) {
      if (!groups.has(source.api_name)) {
        groups.set(source.api_name, { source, calendars: [] });
      }
    }

    return Array.from(groups.values());
  }, [calendarsByPlugin, calendarSources]);

  // Selection state (persisted)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey(pluginApiName));

      if (raw) {
        return new Set(JSON.parse(raw) as string[]);
      }
    } catch {
      // ignore
    }

    return new Set();
  });

  // First-load default: if nothing stored, select calendars marked default=true
  const defaultsApplied = useRef(false);

  useEffect(() => {
    if (defaultsApplied.current || calendarsLoading) {
      return;
    }

    const stored = localStorage.getItem(storageKey(pluginApiName));

    if (stored !== null) {
      defaultsApplied.current = true;

      return;
    }

    const defaults = new Set<string>();

    for (const { source, calendars } of groupedSources) {
      for (const cal of calendars) {
        if (cal.default === true) {
          defaults.add(selectionKey(source.plugin_api_name, source.api_name, cal.id));
        }
      }
    }

    if (defaults.size > 0) {
      setSelectedKeys(defaults);
    }

    defaultsApplied.current = true;
  }, [calendarsLoading, groupedSources, pluginApiName]);

  // Persist selection
  useEffect(() => {
    localStorage.setItem(storageKey(pluginApiName), JSON.stringify(Array.from(selectedKeys)));
  }, [selectedKeys, pluginApiName]);

  const toggleCalendar = useCallback((pluginApi: string, sourceApi: string, calendarId: string) => {
    setSelectedKeys((prev) => {
      const key = selectionKey(pluginApi, sourceApi, calendarId);
      const next = new Set(prev);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }, []);

  // Derive the flat list of selected {calendar, source} pairs for useCalendarEvents.
  // The list identity must be stable when the same set is selected so react-query
  // doesn't refetch on every render.
  const flatCalendars = useMemo(() => {
    const result: { calendar: CalendarDefinition; source: CalendarSourceConfig }[] = [];

    for (const { source, calendars } of groupedSources) {
      for (const calendar of calendars) {
        if (selectedKeys.has(selectionKey(source.plugin_api_name, source.api_name, calendar.id))) {
          result.push({ source, calendar });
        }
      }
    }

    return result;
  }, [groupedSources, selectedKeys]);

  // Date range follows FullCalendar's visible window
  const [dateRange, setDateRange] = useState<{ rangeStart: string; rangeEnd: string }>(() => {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    return { rangeStart: toYMD(start), rangeEnd: toYMD(end) };
  });

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    // arg.end is exclusive in FullCalendar; pull back a day so we don't over-fetch
    const endInclusive = new Date(arg.end.getTime() - 1);

    setDateRange({
      rangeStart: toYMD(arg.start),
      rangeEnd: toYMD(endInclusive),
    });

    setCalendarTitle(arg.view.title);

    setCurrentView(arg.view.type);
  }, []);

  const {
    events: rawEvents,
    sources: sourcesByCalendarId,
    isLoading: eventsLoading,
  } = useCalendarEvents(flatCalendars, dateRange);

  // Flatten events → FullCalendar EventInput[]
  const eventInputs = useMemo<EventInput[]>(() => {
    if (!rawEvents || typeof rawEvents !== 'object') {
      return [];
    }

    const eventsObj = rawEvents as Record<string, CalendarEvent[] | undefined>;
    const result: EventInput[] = [];

    for (const [calendarId, calEvents] of Object.entries(eventsObj)) {
      const sourceInfo = sourcesByCalendarId[calendarId];

      if (!sourceInfo) {
        continue;
      }

      const color = sourceColor(sourceInfo.source.api_name);

      for (const event of calEvents ?? []) {
        result.push({
          id: `${sourceInfo.source.api_name}::${calendarId}::${event.id}`,
          title: event.title,
          start: new Date(event.start_time),
          end: new Date(event.end_time),
          allDay: event.all_day ?? false,
          backgroundColor: color,
          borderColor: color,
          extendedProps: {
            raw: event,
            sourceName: sourceInfo.source.name,
            sourceApiName: sourceInfo.source.api_name,
            calendarName: sourceInfo.calendar.name,
          },
        });
      }
    }

    return result;
  }, [rawEvents, sourcesByCalendarId]);

  const [detail, setDetail] = useState<{
    event: CalendarEvent;
    sourceName: string;
    sourceApiName: string;
    calendarName: string;
  } | null>(null);

  const handleEventClick = useCallback((info: EventClickArg) => {
    const props = info.event.extendedProps as {
      raw: CalendarEvent;
      sourceName: string;
      sourceApiName: string;
      calendarName: string;
    };

    setDetail({
      event: props.raw,
      sourceName: props.sourceName,
      sourceApiName: props.sourceApiName,
      calendarName: props.calendarName,
    });
  }, []);

  const isLoading = calendarsLoading || eventsLoading;

  const renderEventContent = useCallback((arg: EventContentArg) => {
    return (
      <div className="flex min-w-0 items-center gap-1 overflow-hidden px-1 py-px">
        {arg.timeText && (
          <span className="shrink-0 font-mono text-[9px] opacity-70">{arg.timeText}</span>
        )}
        <span className="truncate font-mono text-[10px] font-medium leading-none">
          {arg.event.title}
        </span>
      </div>
    );
  }, []);

  // errorServices returns plugin_api_names — surface a warning on any source whose
  // plugin_api_name is in that list.
  const pluginErrorSet = useMemo(() => {
    return new Set(errorServices.filter((n): n is string => Boolean(n)));
  }, [errorServices]);

  return (
    <div className="flex flex-col gap-4">
      {/* Calendar picker */}
      <div className="flex flex-col gap-3">
        {groupedSources.map(({ source, calendars }) => {
          const hasAuthError = pluginErrorSet.has(source.plugin_api_name);

          return (
            <div
              key={`${source.plugin_api_name}::${source.api_name}`}
              className="rounded border border-black/8 bg-neutral-50/60"
            >
              <div className="flex items-center gap-2 border-b border-black/5 px-3 py-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: sourceColor(source.api_name) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-neutral-800">
                    {source.name}
                  </div>
                  <div className="truncate font-mono text-[10px] text-neutral-400">
                    {source.api_name}
                  </div>
                  {(() => {
                    const when = (source as CalendarSourceWithWhen).when;

                    return when && whenState ? (
                      <WhenBadge when={when} whenState={whenState} />
                    ) : null;
                  })()}
                </div>
              </div>

              {hasAuthError && (
                <div className="flex items-start gap-2 border-b border-amber-200/60 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 text-[10px]" />
                  <span>
                    Auth error — the calendar script returned an authError flag. Check bundle config
                    / credentials.
                  </span>
                </div>
              )}

              <div className="divide-y divide-black/5">
                {calendars.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] italic text-neutral-400">
                    {calendarsLoading ? 'Loading calendars…' : 'No calendars returned.'}
                  </div>
                ) : (
                  calendars.map((cal) => {
                    const key = selectionKey(source.plugin_api_name, source.api_name, cal.id);
                    const checked = selectedKeys.has(key);

                    return (
                      <label
                        key={cal.id}
                        className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-black/5"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            toggleCalendar(source.plugin_api_name, source.api_name, cal.id);
                          }}
                          className="mt-0.5 h-3.5 w-3.5 accent-neutral-800"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] text-neutral-800">
                            {cal.name}
                            {cal.default === true && (
                              <span className="ml-1.5 rounded bg-neutral-200 px-1 py-0.5 text-[9px] uppercase tracking-wider text-neutral-500">
                                default
                              </span>
                            )}
                          </div>
                          {cal.description !== undefined && cal.description !== '' && (
                            <div className="truncate text-[10px] text-neutral-400">
                              {cal.description}
                            </div>
                          )}
                          <div className="truncate font-mono text-[10px] text-neutral-400">
                            {cal.id}
                          </div>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Calendar grid */}
      <div className="relative">
        {/* Custom toolbar */}
        <div className="mb-2 flex items-center justify-between font-mono">
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                calendarRef.current?.getApi().prev();
              }}
              className="rounded border border-black/10 bg-white px-2 py-1 text-[11px] text-neutral-600 hover:bg-black/5"
              aria-label="Previous"
            >
              <FontAwesomeIcon icon={faChevronLeft} />
            </button>
            <button
              onClick={() => {
                calendarRef.current?.getApi().next();
              }}
              className="rounded border border-black/10 bg-white px-2 py-1 text-[11px] text-neutral-600 hover:bg-black/5"
              aria-label="Next"
            >
              <FontAwesomeIcon icon={faChevronRight} />
            </button>
            <button
              onClick={() => {
                calendarRef.current?.getApi().today();
              }}
              className="ml-1 rounded border border-black/10 bg-white px-2.5 py-1 text-[11px] text-neutral-600 hover:bg-black/5"
            >
              Today
            </button>
          </div>

          <span className="text-[13px] font-semibold text-neutral-800">{calendarTitle}</span>

          <div className="flex items-center gap-0.5 rounded border border-black/10 bg-white p-0.5">
            {(
              [
                { view: 'dayGridMonth', label: 'Month' },
                { view: 'timeGridWeek', label: 'Week' },
                { view: 'timeGridDay', label: 'Day' },
              ] as const
            ).map(({ view, label }) => (
              <button
                key={view}
                onClick={() => {
                  calendarRef.current?.getApi().changeView(view);
                }}
                className={`rounded px-2.5 py-0.5 text-[11px] transition-colors ${
                  currentView === view
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-500 hover:text-neutral-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {isLoading && (
          <div className="pointer-events-none absolute right-0 top-0 z-10 flex items-center gap-1.5 rounded bg-white/90 px-2 py-1 text-[10px] text-neutral-500 shadow-sm">
            <FontAwesomeIcon icon={faSpinner} spin />
            Loading…
          </div>
        )}
        <div className="fc-kizen">
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin]}
            initialView="dayGridMonth"
            headerToolbar={false}
            datesSet={handleDatesSet}
            events={eventInputs}
            eventContent={renderEventContent}
            eventClick={handleEventClick}
            height={800}
            nowIndicator
            dayMaxEvents={4}
            weekends
            firstDay={0}
          />
        </div>
      </div>

      {detail && (
        <EventDetail
          event={detail.event}
          sourceName={detail.sourceName}
          sourceApiName={detail.sourceApiName}
          calendarName={detail.calendarName}
          onClose={() => {
            setDetail(null);
          }}
        />
      )}
    </div>
  );
};
