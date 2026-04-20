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
