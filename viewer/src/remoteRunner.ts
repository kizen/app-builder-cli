import type { useApi } from './api.js';
import type {
  ExecutionResult,
  HttpRequestEntry,
  HttpRequests,
} from './components/ExecutionResultPanel.js';

const SUPPORTED_RUNTIMES = ['python-3-13', 'python-3-12'] as const;
const DEFAULT_RUNTIME = 'python-3-12';

export interface RemoteExecuteParams {
  script: string;
  scriptRuntime: string;
  inputs: Record<string, string>;
  inputTypes: Record<string, string>;
  outputTypes: Record<string, string>;
  secretNames: string[];
}

interface KizenEncodedValue {
  t: string;
  v: unknown;
}

interface KizenHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  requestSubmittedAt: string;
  session: boolean;
  responseStatusCode: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  requestErrorType: string | null;
  duration: number;
}

interface KizenHttpRequests {
  count: number;
  not_logged: number;
  requests: KizenHttpRequest[];
}

interface KizenRunResponse {
  request_id: string;
  duration_ms: number | null;
  values: Record<string, KizenEncodedValue> | null;
  logs: string[] | null;
  http_requests: KizenHttpRequests | null;
  error: { error: string; detail: string } | null;
}

const DATA_TYPE_TO_KIZEN: Record<string, string> = {
  text: 's',
  string: 's',
  number: 'n',
  integer: 'n',
  boolean: 'b',
  date: 'd',
  datetime: 'dt',
  phone: 'p',
  phonenumber: 'p',
  uuid: 'u',
  file: 'f',
  list: 'l',
};

export function toKizenType(dataType: string): string {
  return DATA_TYPE_TO_KIZEN[dataType.toLowerCase()] ?? 's';
}

function resolveRuntime(runtime: string): string {
  if ((SUPPORTED_RUNTIMES as readonly string[]).includes(runtime)) {
    return runtime;
  }

  return DEFAULT_RUNTIME;
}

function encodeInputs(
  inputs: Record<string, string>,
  inputTypes: Record<string, string>,
): Record<string, KizenEncodedValue> | null {
  const keys = Object.keys(inputs);

  if (keys.length === 0) {
    return null;
  }

  const encoded: Record<string, KizenEncodedValue> = {};

  for (const key of keys) {
    encoded[key] = {
      t: toKizenType(inputTypes[key] ?? 'string'),
      v: inputs[key],
    };
  }

  return encoded;
}

function encodeOutputTypes(outputTypes: Record<string, string>): Record<string, string> | null {
  const keys = Object.keys(outputTypes);

  if (keys.length === 0) {
    return null;
  }

  const encoded: Record<string, string> = {};

  for (const key of keys) {
    encoded[key] = toKizenType(outputTypes[key] ?? 'string');
  }

  return encoded;
}

function decodeOutputValues(
  values: Record<string, KizenEncodedValue> | null,
): Record<string, unknown> {
  if (!values) {
    return {};
  }

  const decoded: Record<string, unknown> = {};

  for (const [key, encoded] of Object.entries(values)) {
    decoded[key] = encoded.v;
  }

  return decoded;
}

function decodeHttpRequests(http: KizenHttpRequests | null): HttpRequests | undefined {
  if (!http) {
    return undefined;
  }

  const requests: HttpRequestEntry[] = http.requests.map((r) => ({
    method: r.method,
    url: r.url,
    headers: r.headers,
    body: r.body,
    requestSubmittedAt: r.requestSubmittedAt,
    session: r.session,
    responseStatusCode: r.responseStatusCode,
    responseHeaders: r.responseHeaders,
    responseBody: r.responseBody,
    requestErrorType: r.requestErrorType,
    duration: r.duration,
  }));

  return {
    count: http.count,
    notLogged: http.not_logged,
    requests,
  };
}

export async function executeRemoteStep(
  request: ReturnType<typeof useApi>,
  params: RemoteExecuteParams,
): Promise<ExecutionResult> {
  const start = Date.now();

  const body: Record<string, unknown> = {
    user_script: params.script,
    runtime: resolveRuntime(params.scriptRuntime),
    secrets: params.secretNames.length > 0 ? params.secretNames : undefined,
    inputs: encodeInputs(params.inputs, params.inputTypes),
    output_types: encodeOutputTypes(params.outputTypes),
  };

  try {
    const response = await request('/coderunner/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const durationMs = Date.now() - start;

    if (!response.ok) {
      const text = await response.text();

      return {
        success: false,
        outputValues: {},
        logs: [],
        stdout: '',
        stderr: '',
        error: `Remote runner returned ${String(response.status)}: ${text}`,
        exitCode: 1,
        durationMs,
      };
    }

    const data = (await response.json()) as KizenRunResponse;
    const hasError = data.error !== null;

    const httpRequests = decodeHttpRequests(data.http_requests);

    const result: ExecutionResult = {
      success: !hasError,
      outputValues: decodeOutputValues(data.values),
      logs: data.logs ?? [],
      stdout: '',
      stderr: '',
      exitCode: hasError ? 1 : 0,
      durationMs: data.duration_ms ?? durationMs,
      ...(httpRequests && { httpRequests }),
    };

    if (hasError && data.error) {
      result.error = data.error.detail
        ? `${data.error.error}\n${data.error.detail}`
        : data.error.error;
    }

    return result;
  } catch (err) {
    return {
      success: false,
      outputValues: {},
      logs: [],
      stdout: '',
      stderr: '',
      error: `Remote execution failed: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      durationMs: Date.now() - start,
    };
  }
}
