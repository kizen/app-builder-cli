export interface HttpRequestEntry {
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

export interface HttpRequests {
  count: number;
  notLogged: number;
  requests: HttpRequestEntry[];
}

export interface ExecutionResult {
  success: boolean;
  outputValues: Record<string, unknown>;
  logs: string[];
  stdout: string;
  stderr: string;
  error?: string;
  exitCode: number;
  durationMs: number;
  httpRequests?: HttpRequests;
}

export type StepInputValue = string | null;

export function toStepInputValue(raw: string | null | undefined): StepInputValue {
  return raw === undefined || raw === null || raw.trim() === '' ? null : raw;
}

export function buildStepInputs(
  names: string[],
  rawValues: Record<string, string>,
): Record<string, StepInputValue> {
  return Object.fromEntries(names.map((name) => [name, toStepInputValue(rawValues[name])]));
}

function coerceStepInputValue(value: unknown): StepInputValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return toStepInputValue(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }

  return JSON.stringify(value);
}

export function normalizeStepInputs(
  inputs: Record<string, unknown> | undefined,
): Record<string, StepInputValue> {
  if (!inputs) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [name, coerceStepInputValue(value)]),
  );
}
