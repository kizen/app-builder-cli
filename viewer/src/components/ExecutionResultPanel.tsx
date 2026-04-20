import { type FC, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { type HttpRequestEntry, type HttpRequests, type ExecutionResult } from '@shared/lib/execution.js';
export type { HttpRequestEntry, HttpRequests, ExecutionResult } from '@shared/lib/execution.js';

const CollapsibleSection: FC<{
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => {
          setOpen((p) => !p);
        }}
        className="flex w-full items-center gap-1.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-neutral-400 hover:text-neutral-600"
      >
        <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} className="w-2.5" />
        {title}
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
};

export const ExecutionResultPanel: FC<{ result: ExecutionResult }> = ({ result }) => {
  const outputEntries = Object.entries(result.outputValues);

  return (
    <div className="space-y-3 rounded-lg border border-black/10 bg-white p-4">
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
            result.success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
          }`}
        >
          {result.success ? 'Success' : 'Error'}
        </span>
        <span className="text-[11px] text-neutral-400">{String(result.durationMs)}ms</span>
        {result.exitCode !== 0 && (
          <span className="text-[11px] text-neutral-400">exit code {String(result.exitCode)}</span>
        )}
      </div>

      {result.error && (
        <pre className="overflow-auto rounded bg-red-50 p-3 font-mono text-[12px] text-red-800">
          {result.error}
        </pre>
      )}

      {outputEntries.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Outputs
          </div>
          <div className="divide-y divide-black/5">
            {outputEntries.map(([alias, value]) => (
              <div key={alias} className="flex items-start gap-2 py-1.5">
                <span className="shrink-0 font-mono text-[12px] text-neutral-600">{alias}</span>
                <span className="text-[11px] text-neutral-300">=</span>
                <pre className="min-w-0 flex-1 overflow-auto font-mono text-[12px] text-neutral-800">
                  {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.logs.length > 0 && (
        <CollapsibleSection title={`Logs (${String(result.logs.length)})`}>
          <div className="space-y-0.5">
            {result.logs.map((log, i) => (
              <div key={i} className="font-mono text-[12px] text-neutral-600">
                {log}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {result.stdout && (
        <CollapsibleSection title="Stdout">
          <pre className="overflow-auto rounded bg-neutral-50 p-3 font-mono text-[12px] text-neutral-700">
            {result.stdout}
          </pre>
        </CollapsibleSection>
      )}

      {result.stderr && (
        <CollapsibleSection title="Stderr">
          <pre className="overflow-auto rounded bg-neutral-50 p-3 font-mono text-[12px] text-neutral-700">
            {result.stderr}
          </pre>
        </CollapsibleSection>
      )}

      {result.httpRequests && result.httpRequests.count > 0 && (
        <CollapsibleSection
          title={`Network (${String(result.httpRequests.count)}${
            result.httpRequests.notLogged > 0
              ? `, ${String(result.httpRequests.notLogged)} not logged`
              : ''
          })`}
        >
          <div className="space-y-1.5">
            {result.httpRequests.requests.map((req, i) => (
              <HttpRequestRow key={i} request={req} />
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
};

const methodColor = (method: string): string => {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'bg-blue-100 text-blue-700';
    case 'POST':
      return 'bg-green-100 text-green-700';
    case 'PUT':
    case 'PATCH':
      return 'bg-amber-100 text-amber-700';
    case 'DELETE':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-neutral-100 text-neutral-700';
  }
};

const statusColor = (status: number, errored: boolean): string => {
  if (errored || status >= 500) {
    return 'text-red-700';
  }

  if (status >= 400) {
    return 'text-amber-700';
  }

  if (status >= 200) {
    return 'text-green-700';
  }

  return 'text-neutral-600';
};

const HttpRequestRow: FC<{ request: HttpRequestEntry }> = ({ request }) => {
  const [open, setOpen] = useState(false);
  const errored = request.requestErrorType !== null;

  return (
    <div className="rounded border border-black/5 bg-neutral-50">
      <button
        onClick={() => {
          setOpen((p) => !p);
        }}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-neutral-100"
      >
        <FontAwesomeIcon
          icon={open ? faChevronDown : faChevronRight}
          className="w-2.5 text-neutral-400"
        />
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${methodColor(request.method)}`}
        >
          {request.method}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-neutral-700">
          {request.url}
        </span>
        <span
          className={`font-mono text-[11px] font-semibold ${statusColor(request.responseStatusCode, errored)}`}
        >
          {errored ? request.requestErrorType : request.responseStatusCode}
        </span>
        <span className="font-mono text-[10px] text-neutral-400">
          {(request.duration * 1000).toFixed(0)}ms
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-black/5 p-2.5">
          <HttpRequestSection title="Request Headers" data={request.headers} />
          {request.body && <HttpRequestBody title="Request Body" body={request.body} />}
          <HttpRequestSection title="Response Headers" data={request.responseHeaders} />
          {request.responseBody && (
            <HttpRequestBody title="Response Body" body={request.responseBody} />
          )}
        </div>
      )}
    </div>
  );
};

const HttpRequestSection: FC<{ title: string; data: Record<string, string> }> = ({
  title,
  data,
}) => {
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
        {title}
      </div>
      <div className="divide-y divide-black/5 rounded border border-black/5 bg-white">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2 px-2 py-1 font-mono text-[11px]">
            <span className="shrink-0 text-neutral-500">{k}:</span>
            <span className="min-w-0 flex-1 break-all text-neutral-800">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const HttpRequestBody: FC<{ title: string; body: string }> = ({ title, body }) => (
  <div>
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
      {title}
    </div>
    <pre className="overflow-auto rounded border border-black/5 bg-white p-2 font-mono text-[11px] text-neutral-800">
      {body}
    </pre>
  </div>
);
