import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark, faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ENVIRONMENTS, type Credentials } from '../CredentialsContext.js';
import { RouteHarness } from './RouteHarness.js';
import type { ProxyLogEntry } from '../useDevReload.js';
import type { ConsoleEntry } from '../consoleCapture.js';
import { STORAGE_KEYS } from '../lib/storageKeys.js';
import { Tooltip } from './Tooltip.js';

interface CredentialProfile {
  name: string;
  path: string;
  isDefault: boolean;
}

interface DevSidebarProps {
  onClose: () => void;
  buildLogs: string[];
  proxyLogs: ProxyLogEntry[];
  consoleLogs: readonly ConsoleEntry[];
  onClearConsole: () => void;
  credentials: Credentials;
  onCredentialsChange: (c: Credentials) => void;
  width?: number;
  onWidthChange?: (width: number) => void;
}

const inputClass =
  'w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-[12px] font-mono text-neutral-200 focus:outline-none focus:border-neutral-500';

const labelClass =
  'block text-[11px] font-semibold uppercase tracking-widest text-neutral-600 mb-1';

const sectionHeaderClass = 'text-[11px] font-semibold uppercase tracking-widest text-neutral-500';

const levelColor: Record<ConsoleEntry['level'], string> = {
  log: 'text-neutral-400',
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg;
  }

  if (arg === null) {
    return 'null';
  }

  if (arg === undefined) {
    return 'undefined';
  }

  try {
    return JSON.stringify(arg);
  } catch {
    return '[unserializable]';
  }
}

interface ConsolePanelProps {
  logs: readonly ConsoleEntry[];
  height: string;
}

const ConsolePanel: FC<ConsolePanelProps> = ({ logs, height }) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className={`${height} overflow-x-auto overflow-y-auto pb-4`}>
      {logs.length === 0 ? (
        <p className="px-4 text-[12px] text-neutral-600">No output yet.</p>
      ) : (
        logs.map((entry, i) => (
          <div
            key={i}
            className={`whitespace-pre px-4 text-[12px] leading-5 ${levelColor[entry.level]} ${i % 2 === 0 ? 'bg-neutral-900' : 'bg-neutral-800/40'}`}
          >
            {entry.args.map(formatArg).join(' ')}
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
};

interface LogPanelProps {
  logs: string[];
  height: string;
}

const LogPanel: FC<LogPanelProps> = ({ logs, height }) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className={`${height} overflow-x-auto overflow-y-auto pb-4`}>
      {logs.length === 0 ? (
        <p className="px-4 text-[12px] text-neutral-600">No output yet.</p>
      ) : (
        logs.map((line, i) => (
          <div key={i} className="whitespace-pre px-4 text-[12px] leading-5 text-neutral-500">
            {line}
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
};

function methodBadgeClass(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'bg-blue-900/60 text-blue-300';
    case 'POST':
      return 'bg-green-900/60 text-green-300';
    case 'PUT':
      return 'bg-amber-900/60 text-amber-300';
    case 'PATCH':
      return 'bg-orange-900/60 text-orange-300';
    case 'DELETE':
      return 'bg-red-900/60 text-red-300';
    default:
      return 'bg-neutral-800 text-neutral-400';
  }
}

function statusBadgeClass(status: number): string {
  if (status === 0) {
    return 'bg-neutral-800 text-neutral-400';
  }

  if (status < 300) {
    return 'bg-green-900/60 text-green-300';
  }

  if (status < 400) {
    return 'bg-yellow-900/60 text-yellow-300';
  }

  if (status < 500) {
    return 'bg-orange-900/60 text-orange-300';
  }

  return 'bg-red-900/60 text-red-300';
}

interface ProxyLogPanelProps {
  logs: ProxyLogEntry[];
  height: string;
}

const ProxyLogPanel: FC<ProxyLogPanelProps> = ({ logs, height }) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <>
      <div className={`${height} overflow-x-auto overflow-y-auto pb-4`}>
        {logs.length === 0 ? (
          <p className="px-4 text-[12px] text-neutral-600">No output yet.</p>
        ) : (
          logs.map((entry, i) => (
            <div
              key={i}
              className={`flex items-center gap-1.5 px-3 py-0.5 text-[11px] ${i % 2 === 0 ? 'bg-neutral-900' : 'bg-neutral-800/40'}`}
            >
              {entry.kind === 'info' ? (
                <span className="text-neutral-500">{entry.message}</span>
              ) : (
                <>
                  <span
                    className={`w-12 shrink-0 rounded text-center font-mono font-semibold ${methodBadgeClass(entry.method)}`}
                  >
                    {entry.method}
                  </span>
                  <span
                    className={`w-8 shrink-0 rounded text-center font-mono font-semibold ${statusBadgeClass(entry.status)}`}
                  >
                    {entry.status === 0 ? 'ERR' : entry.status}
                  </span>
                  <span
                    className={`w-14 shrink-0 rounded text-center font-mono font-semibold ${entry.fromCache ? 'bg-violet-900/60 text-violet-300' : 'bg-neutral-800 text-neutral-400'}`}
                  >
                    {entry.fromCache ? 'cache' : 'network'}
                  </span>
                  <Tooltip text={entry.url}>
                    <span className="min-w-0 truncate cursor-default font-mono text-neutral-400">
                      {entry.url}
                    </span>
                  </Tooltip>
                </>
              )}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </>
  );
};

export const DevSidebar: FC<DevSidebarProps> = ({
  onClose,
  buildLogs,
  proxyLogs,
  consoleLogs,
  onClearConsole,
  credentials,
  onCredentialsChange,
  width = 416,
  onWidthChange,
}) => {
  const [credsOpen, setCredsOpen] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.credsPanelOpen);

    if (stored !== null) {
      return stored !== 'false';
    }

    const allFilled = !!(credentials.apiKey && credentials.userId && credentials.businessId);

    return !allFilled;
  });

  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<string | undefined>(undefined);

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch('/api/credential-profiles');

      if (!res.ok) {
        return;
      }

      const data = (await res.json()) as {
        profiles: CredentialProfile[];
        active: string | undefined;
      };

      setProfiles(data.profiles);

      setActiveProfile(data.active);
    } catch {
      // not in dev mode or endpoint unavailable
    }
  }, []);

  useEffect(() => {
    void fetchProfiles();
  }, [fetchProfiles]);

  const handleProfileChange = useCallback(async (profileName: string) => {
    const profile = profileName === '' ? undefined : profileName;

    try {
      await fetch('/api/credentials/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });

      await fetch('/api/proxy-cache/clear');

      setActiveProfile(profile);
      // Credentials will update via WebSocket credentials-updated message
    } catch {
      // ignore
    }
  }, []);
  const [routesOpen, setRoutesOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.routesPanelOpen) !== 'false',
  );
  const [consoleOpen, setConsoleOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.consolePanelOpen) !== 'false',
  );
  const [proxyOpen, setProxyOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.proxyPanelOpen) !== 'false',
  );
  const [buildOpen, setBuildOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.buildPanelOpen) !== 'false',
  );

  const toggle = (key: string, setter: React.Dispatch<React.SetStateAction<boolean>>): void => {
    setter((prev) => {
      const next = !prev;

      localStorage.setItem(key, String(next));

      return next;
    });
  };

  const isDraggingRef = useRef(false);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      isDraggingRef.current = true;

      const onMove = (ev: MouseEvent): void => {
        if (!isDraggingRef.current) {
          return;
        }

        const newWidth = Math.min(800, Math.max(280, window.innerWidth - ev.clientX));

        onWidthChange?.(newWidth);
      };

      const onUp = (): void => {
        isDraggingRef.current = false;

        document.removeEventListener('mousemove', onMove);

        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);

      document.addEventListener('mouseup', onUp);
    },
    [onWidthChange],
  );

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-neutral-800 bg-neutral-900 text-neutral-100"
      style={{ width }}
    >
      {/* Drag handle on left edge */}
      <div
        onMouseDown={handleDragStart}
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-neutral-600"
      />
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <span className="text-[12px] font-semibold uppercase tracking-widest text-neutral-400">
          Dev Tools
        </span>
        <button
          onClick={onClose}
          className="text-neutral-500 hover:text-neutral-200"
          aria-label="Close dev tools"
        >
          <FontAwesomeIcon icon={faXmark} size="sm" />
        </button>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 flex-col min-h-0">
          {/* Credentials */}
          <div className="flex shrink-0 flex-col border-b border-neutral-800">
            <button
              className="flex items-center justify-between px-4 py-2 hover:bg-neutral-800/50"
              onClick={() => {
                toggle(STORAGE_KEYS.credsPanelOpen, setCredsOpen);

                void fetchProfiles();
              }}
            >
              <div className="flex items-center gap-2">
                <span className={sectionHeaderClass}>Credentials</span>
                {!credsOpen && (
                  <span className="text-[11px] font-mono text-neutral-400">
                    {credentials.environment}
                  </span>
                )}
              </div>
              <FontAwesomeIcon
                icon={credsOpen ? faChevronDown : faChevronRight}
                className="text-neutral-600"
                size="xs"
              />
            </button>
            {credsOpen && (
              <div className="flex flex-col gap-2 px-4 pb-3">
                {profiles.length > 1 && (
                  <div>
                    <label className={labelClass}>Profile</label>
                    <select
                      className={inputClass}
                      value={activeProfile ?? ''}
                      onChange={(e) => {
                        void handleProfileChange(e.target.value);
                      }}
                    >
                      {profiles.map((p) => (
                        <option key={p.name} value={p.isDefault ? '' : p.name}>
                          {p.isDefault ? 'Default' : p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className={labelClass}>Environment</label>
                    <select
                      className={inputClass}
                      value={credentials.environment}
                      onChange={(e) => {
                        onCredentialsChange({
                          ...credentials,
                          environment: e.target.value as Credentials['environment'],
                        });
                      }}
                    >
                      {ENVIRONMENTS.map((env) => (
                        <option key={env} value={env}>
                          {env}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelClass}>Business ID</label>
                    <input
                      type="text"
                      className={inputClass}
                      value={credentials.businessId}
                      onChange={(e) => {
                        onCredentialsChange({ ...credentials, businessId: e.target.value });
                      }}
                      placeholder="x-business-id"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className={labelClass}>User ID</label>
                    <input
                      type="text"
                      className={inputClass}
                      value={credentials.userId}
                      onChange={(e) => {
                        onCredentialsChange({ ...credentials, userId: e.target.value });
                      }}
                      placeholder="x-user-id"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex-1">
                    <label className={labelClass}>API Key</label>
                    <input
                      type="password"
                      className={inputClass}
                      value={credentials.apiKey}
                      onChange={(e) => {
                        onCredentialsChange({ ...credentials, apiKey: e.target.value });
                      }}
                      placeholder="x-api-key"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <button
                  onClick={() => {
                    localStorage.clear();
                    window.location.reload();
                  }}
                  className="text-[11px] text-neutral-600 hover:text-red-400 self-start"
                >
                  clear storage
                </button>
              </div>
            )}
          </div>

          {/* Routes */}
          <div className="flex shrink-0 flex-col border-t border-neutral-800 overflow-hidden">
            <button
              className="flex items-center justify-between px-4 py-2 hover:bg-neutral-800/50"
              onClick={() => {
                toggle(STORAGE_KEYS.routesPanelOpen, setRoutesOpen);
              }}
            >
              <span className={sectionHeaderClass}>Routes</span>
              <FontAwesomeIcon
                icon={routesOpen ? faChevronDown : faChevronRight}
                className="text-neutral-600"
                size="xs"
              />
            </button>
            {routesOpen && <RouteHarness />}
          </div>

          {/* Console log */}
          <div className="flex shrink-0 flex-col border-t border-neutral-800">
            <div className="flex items-center px-4 py-2">
              <button
                className="flex flex-1 items-center gap-2 hover:opacity-70"
                onClick={() => {
                  toggle(STORAGE_KEYS.consolePanelOpen, setConsoleOpen);
                }}
              >
                <span className={sectionHeaderClass}>Browser Console</span>
                <FontAwesomeIcon
                  icon={consoleOpen ? faChevronDown : faChevronRight}
                  className="text-neutral-600"
                  size="xs"
                />
              </button>
              {consoleOpen && consoleLogs.length > 0 && (
                <button
                  onClick={onClearConsole}
                  className="text-[11px] text-neutral-600 hover:text-neutral-300"
                >
                  clear
                </button>
              )}
            </div>
            {consoleOpen && <ConsolePanel logs={consoleLogs} height="min-h-32 max-h-64" />}
          </div>

          {/* Proxy log */}
          <div className="flex flex-1 flex-col min-h-0 border-t border-neutral-800">
            <div className="flex items-center px-4 py-2">
              <button
                className="flex flex-1 items-center gap-2 hover:opacity-70"
                onClick={() => {
                  toggle(STORAGE_KEYS.proxyPanelOpen, setProxyOpen);
                }}
              >
                <span className={sectionHeaderClass}>Network Requests</span>
                <FontAwesomeIcon
                  icon={proxyOpen ? faChevronDown : faChevronRight}
                  className="text-neutral-600"
                  size="xs"
                />
              </button>
              {proxyOpen && (
                <button
                  onClick={() => {
                    void fetch('/api/proxy-cache/clear');
                  }}
                  className="text-[11px] text-neutral-600 hover:text-neutral-300"
                >
                  clear cache
                </button>
              )}
            </div>
            {proxyOpen && <ProxyLogPanel logs={proxyLogs} height="flex-1 min-h-0" />}
          </div>
        </div>

        {/* Build log - pinned to bottom */}
        <div className="flex flex-col border-t border-neutral-800">
          <button
            className="flex items-center justify-between px-4 py-2 hover:bg-neutral-800/50"
            onClick={() => {
              toggle(STORAGE_KEYS.buildPanelOpen, setBuildOpen);
            }}
          >
            <span className={sectionHeaderClass}>Build Log</span>
            <FontAwesomeIcon
              icon={buildOpen ? faChevronDown : faChevronRight}
              className="text-neutral-600"
              size="xs"
            />
          </button>
          {buildOpen && <LogPanel logs={buildLogs} height="max-h-[60px]" />}
        </div>
      </div>
    </aside>
  );
};
