import { useState, useRef, useEffect, type FC } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faSpinner,
  faPaperPlane,
  faPlus,
  faXmark,
  faClockRotateLeft,
  faCircleInfo,
} from '@fortawesome/free-solid-svg-icons';
import { Card } from './Card.js';
import { DropdownPortal } from './DropdownPortal.js';
import { useApi, BASE_URLS } from '../api.js';
import { useCredentials } from '../CredentialsContext.js';
import { serviceRequestHistoryKey } from '../lib/storageKeys.js';
import type { ServiceConfig } from '../types.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

interface ResponseState {
  status: number;
  elapsedMs: number;
  contentType: string;
  body: string;
}

interface HistoryEntry {
  id: string;
  method: HttpMethod;
  path: string;
  headers: HeaderRow[];
  body: string;
}

const inputClass =
  'h-8 rounded border border-black/10 bg-white px-2.5 font-mono text-[12px] text-neutral-800 focus:border-neutral-400 focus:outline-none w-full';

const labelClass =
  'block text-[11px] font-semibold uppercase tracking-widest text-neutral-600 mb-1';

const methodBadgeClass = (method: HttpMethod): string => {
  if (method === 'GET') {
    return 'bg-green-50 text-green-700';
  }

  if (method === 'DELETE') {
    return 'bg-red-50 text-red-700';
  }

  if (method === 'POST') {
    return 'bg-blue-50 text-blue-700';
  }

  return 'bg-amber-50 text-amber-700';
};

function loadHistory(pluginApiName: string, serviceName: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(serviceRequestHistoryKey(pluginApiName, serviceName));

    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(
  pluginApiName: string,
  serviceName: string,
  entry: Omit<HistoryEntry, 'id'>,
  existing: HistoryEntry[],
): HistoryEntry[] {
  const normPath = entry.path === '' || entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
  const dedupeKey = `${entry.method}:${normPath}`;
  const filtered = existing.filter((e) => `${e.method}:${e.path}` !== dedupeKey);
  const next: HistoryEntry[] = [
    { ...entry, path: normPath, id: String(Date.now()) },
    ...filtered,
  ].slice(0, 10);

  try {
    localStorage.setItem(
      serviceRequestHistoryKey(pluginApiName, serviceName),
      JSON.stringify(next),
    );
  } catch {
    // quota exceeded — ignore
  }

  return next;
}

const ResponsePanel: FC<{ response: ResponseState }> = ({ response }) => {
  const { status, elapsedMs, contentType, body } = response;

  const statusColor =
    status === 0
      ? 'bg-neutral-100 text-neutral-500'
      : status < 300
        ? 'bg-green-50 text-green-700'
        : status < 400
          ? 'bg-yellow-50 text-yellow-700'
          : 'bg-red-50 text-red-700';

  let displayBody = body;

  if (contentType.includes('application/json')) {
    try {
      displayBody = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // fall through to raw text
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${statusColor}`}>
          {status === 0 ? 'Error' : status}
        </span>
        {elapsedMs > 0 && (
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">
            {elapsedMs}ms
          </span>
        )}
      </div>
      <pre className="max-h-72 overflow-auto rounded border border-black/5 bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-700 whitespace-pre-wrap break-all">
        {displayBody || '(empty response)'}
      </pre>
    </div>
  );
};

const HeadersEditor: FC<{
  headers: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}> = ({ headers, onChange }) => {
  const addRow = (): void => {
    onChange([...headers, { id: String(Date.now()), key: '', value: '' }]);
  };

  const removeRow = (id: string): void => {
    onChange(headers.filter((h) => h.id !== id));
  };

  const updateRow = (id: string, field: 'key' | 'value', val: string): void => {
    onChange(headers.map((h) => (h.id === id ? { ...h, [field]: val } : h)));
  };

  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass}>Custom Headers</label>
      {headers.length > 0 && (
        <div className="grid grid-cols-[1fr_1fr_auto] gap-1 mb-1">
          {headers.map((row) => (
            <>
              <input
                key={`${row.id}-key`}
                className={inputClass}
                placeholder="Header name"
                value={row.key}
                onChange={(e) => {
                  updateRow(row.id, 'key', e.target.value);
                }}
              />
              <input
                key={`${row.id}-val`}
                className={inputClass}
                placeholder="Value"
                value={row.value}
                onChange={(e) => {
                  updateRow(row.id, 'value', e.target.value);
                }}
              />
              <button
                key={`${row.id}-rm`}
                type="button"
                className="px-1.5 text-neutral-400 hover:text-red-500"
                onClick={() => {
                  removeRow(row.id);
                }}
              >
                <FontAwesomeIcon icon={faXmark} className="text-[11px]" />
              </button>
            </>
          ))}
        </div>
      )}
      <button
        type="button"
        className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-700 self-start"
        onClick={addRow}
      >
        <FontAwesomeIcon icon={faPlus} className="text-[10px]" />
        Add header
      </button>
    </div>
  );
};

const ServiceTester: FC<{ service: ServiceConfig; pluginApiName: string }> = ({
  service,
  pluginApiName,
}) => {
  const request = useApi();
  const { environment } = useCredentials();
  const baseUrl = BASE_URLS[environment];

  const [method, setMethod] = useState<HttpMethod>('GET');
  const [path, setPath] = useState('');
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ResponseState | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() =>
    loadHistory(pluginApiName, service.service_name),
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!historyOpen) {
      return;
    }

    const handleClick = (e: MouseEvent): void => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClick);

    return () => {
      document.removeEventListener('mousedown', handleClick);
    };
  }, [historyOpen]);

  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  const normPath = path === '' || path.startsWith('/') ? path : `/${path}`;
  const servicePath = `/external-integrations/proxy/${pluginApiName}/${service.service_name}${normPath || '/'}`;
  const previewUrl = `${baseUrl}${servicePath}`;

  const restoreEntry = (entry: HistoryEntry): void => {
    setMethod(entry.method);

    setPath(entry.path);

    setHeaders(entry.headers);

    setBody(entry.body);

    setHistoryOpen(false);
  };

  const clearHistory = (): void => {
    localStorage.removeItem(serviceRequestHistoryKey(pluginApiName, service.service_name));

    setHistory([]);

    setHistoryOpen(false);
  };

  const handleSend = async (): Promise<void> => {
    if (loading) {
      return;
    }

    const updatedHistory = saveHistory(
      pluginApiName,
      service.service_name,
      { method, path, headers, body },
      history,
    );

    setHistory(updatedHistory);

    setLoading(true);

    setResponse(null);

    try {
      const customHeaders = Object.fromEntries(
        headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value]),
      );
      const t0 = performance.now();
      const res = await request(servicePath, {
        method,
        headers: {
          ...(hasBody && body.trim() ? { 'Content-Type': 'application/json' } : {}),
          ...customHeaders,
        },
        ...(hasBody && body.trim() ? { body } : {}),
      });
      const elapsedMs = Math.round(performance.now() - t0);
      const contentType = res.headers.get('content-type') ?? '';
      const resBody = await res.text();

      setResponse({ status: res.status, elapsedMs, contentType, body: resBody });
    } catch (err) {
      setResponse({ status: 0, elapsedMs: 0, contentType: '', body: String(err) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Method + path + send */}
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-1 shrink-0">
          <label className={labelClass}>Method</label>
          <select
            className="h-8 w-28 rounded border border-black/10 bg-white px-2 font-mono text-[12px] text-neutral-800 focus:border-neutral-400 focus:outline-none"
            value={method}
            onChange={(e) => {
              setMethod(e.target.value as HttpMethod);
            }}
          >
            {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as HttpMethod[]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="relative flex flex-col gap-1 flex-1 min-w-0" ref={historyRef}>
          <div className="flex items-center justify-between">
            <label className={labelClass}>Path</label>
            {history.length > 0 && (
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-700"
                onClick={() => {
                  setHistoryOpen((v) => !v);
                }}
                title="Request history"
              >
                <FontAwesomeIcon icon={faClockRotateLeft} className="text-[10px]" />
                <span>{history.length}</span>
              </button>
            )}
          </div>
          <input
            className={inputClass}
            placeholder="/path/to/endpoint"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void handleSend();
              }
            }}
          />
          <span className="font-mono text-[10px] text-neutral-400 truncate">{previewUrl}</span>

          <DropdownPortal anchorRef={historyRef} open={historyOpen && history.length > 0}>
            {history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50"
                onClick={() => {
                  restoreEntry(entry);
                }}
              >
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${methodBadgeClass(entry.method)}`}
                >
                  {entry.method}
                </span>
                <span className="flex-1 truncate font-mono text-[11px] text-neutral-700">
                  {entry.path || '/'}
                </span>
                {entry.headers.filter((h) => h.key.trim()).length > 0 && (
                  <span className="shrink-0 text-[10px] text-neutral-400">
                    {entry.headers.filter((h) => h.key.trim()).length}h
                  </span>
                )}
                {entry.body.trim() && (
                  <span className="shrink-0 text-[10px] text-neutral-400">body</span>
                )}
              </button>
            ))}
            <div className="border-t border-black/5 px-3 py-1.5 text-right">
              <button
                type="button"
                className="text-[11px] text-neutral-400 hover:text-neutral-700"
                onClick={clearHistory}
              >
                clear history
              </button>
            </div>
          </DropdownPortal>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <span className={`invisible ${labelClass}`}>&nbsp;</span>
          <button
            type="button"
            disabled={loading}
            className="h-8 flex items-center gap-1.5 rounded bg-neutral-800 px-3 text-[12px] font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            onClick={() => {
              void handleSend();
            }}
          >
            {loading ? (
              <FontAwesomeIcon icon={faSpinner} className="animate-spin text-[11px]" />
            ) : (
              <FontAwesomeIcon icon={faPaperPlane} className="text-[11px]" />
            )}
            Send
          </button>
        </div>
      </div>

      {/* Custom headers */}
      <HeadersEditor headers={headers} onChange={setHeaders} />

      {/* Body */}
      {hasBody && (
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Request Body</label>
          <textarea
            className="rounded border border-black/10 bg-white px-2.5 py-1.5 font-mono text-[12px] text-neutral-800 focus:border-neutral-400 focus:outline-none w-full resize-y"
            rows={5}
            placeholder='{"key": "value"}'
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
            }}
          />
        </div>
      )}

      {response !== null && <ResponsePanel response={response} />}
    </div>
  );
};

const authTypeBadgeClass = (authType: string): string => {
  if (authType === 'oauth') {
    return 'rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-mono text-blue-700';
  }

  if (authType === 'no_auth') {
    return 'rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-mono text-neutral-500';
  }

  return 'rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-mono text-amber-700';
};

const InfoRow: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline gap-2 text-[12px]">
    <span className="w-28 shrink-0 text-[11px] font-semibold uppercase tracking-widest text-neutral-600">
      {label}
    </span>
    {children}
  </div>
);

const ServiceInfo: FC<{ service: ServiceConfig }> = ({ service }) => (
  <div className="flex flex-col gap-1.5 pb-4 mb-4 border-b border-black/5">
    <InfoRow label="Name">
      <span className="text-neutral-800 font-medium">{service.display_name}</span>
      <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500">
        {service.service_name}
      </span>
    </InfoRow>
    <InfoRow label="Auth">
      <span className={authTypeBadgeClass(service.auth_type)}>{service.auth_type}</span>
      {service.auth_level && (
        <span className="text-[11px] text-neutral-400">{service.auth_level}</span>
      )}
    </InfoRow>
    <InfoRow label="Base URL">
      <span className="font-mono text-[11px] text-neutral-600 break-all">
        {service.base_service_url || <em className="text-neutral-400">none</em>}
      </span>
    </InfoRow>
    {service.auth_credentials?.scopes && (
      <InfoRow label="Scopes">
        <span className="font-mono text-[11px] text-neutral-600 break-all leading-relaxed">
          {service.auth_credentials.scopes}
        </span>
      </InfoRow>
    )}
    {service.auth_credentials?.authorize_url && (
      <InfoRow label="Auth URL">
        <span className="font-mono text-[11px] text-neutral-600 break-all">
          {service.auth_credentials.authorize_url}
        </span>
      </InfoRow>
    )}
    {service.required_entitlement ? (
      <InfoRow label="Entitlement">
        <span className="font-mono text-[11px] text-neutral-500">
          {service.required_entitlement}
        </span>
      </InfoRow>
    ) : null}
  </div>
);

interface ServiceSectionProps {
  services: ServiceConfig[];
  pluginApiName: string;
  isInstalled: boolean;
}

export const ServiceSection: FC<ServiceSectionProps> = ({
  services,
  pluginApiName,
  isInstalled,
}) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const active = services[activeIdx] ?? services[0];

  if (!active) {
    return null;
  }

  return (
    <Card className="!p-0 overflow-hidden">
      {/* Header */}
      <div className="border-b border-black/10 px-5 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-600">
          Services
        </span>
        <p className="mt-1 text-[12px] text-neutral-400">
          Make proxied requests to external services through Kizen's integration layer.
        </p>
      </div>
      {/* Tab strip */}
      <div className="flex border-b border-black/10 overflow-x-auto">
        {services.map((service, i) => (
          <button
            key={service.service_name}
            type="button"
            onClick={() => {
              setActiveIdx(i);
            }}
            className={`shrink-0 px-4 py-2.5 text-[12px] font-medium border-b-2 transition-colors ${
              i === activeIdx
                ? 'border-neutral-800 text-neutral-900'
                : 'border-transparent text-neutral-400 hover:text-neutral-700'
            }`}
          >
            {service.display_name}
          </button>
        ))}
      </div>
      {/* Active service content */}
      <div className="p-5 flex flex-col gap-4">
        <ServiceInfo service={active} />
        {isInstalled ? (
          <ServiceTester key={active.service_name} service={active} pluginApiName={pluginApiName} />
        ) : (
          <div className="flex items-start gap-2 rounded border border-amber-200/60 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800">
            <FontAwesomeIcon icon={faCircleInfo} className="mt-0.5 text-[11px]" />
            <span>Please install the plugin in order to test.</span>
          </div>
        )}
      </div>
    </Card>
  );
};
