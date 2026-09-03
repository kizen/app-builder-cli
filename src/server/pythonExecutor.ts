import { spawn } from 'node:child_process';
import { writeFile, rm, mkdtemp, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import requirementsTxt from './python-requirements.txt';
import { parseRequirementsFile, resolvePythonBinary } from '../lib/pythonRuntime.js';
import {
  type ExecutionResult,
  type HttpRequests,
  type StepInputValue,
} from '../../shared/lib/execution.js';
export type {
  ExecutionResult,
  HttpRequests,
  HttpRequestEntry,
} from '../../shared/lib/execution.js';

const WRAPPER_SCRIPT = `
import sys, json, os, traceback

# --- Inputs proxy (attribute access) ---
class _InputsProxy:
    def __init__(self, data):
        object.__setattr__(self, '_data', data)

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)
        return self._data.get(name)

    def __repr__(self):
        return repr(self._data)

    def __str__(self):
        return str(self._data)

    def __bool__(self):
        return bool(self._data)

inputs = _InputsProxy(json.loads(os.environ.get('__KIZEN_INPUTS__', '{}')))

# --- Secrets ---
secrets = json.loads(os.environ.get('__KIZEN_SECRETS__', '{}'))

# --- Outputs proxy ---
class _OutputsProxy:
    def __init__(self):
        object.__setattr__(self, '_values', {})
        object.__setattr__(self, '_logs', [])

    def __setattr__(self, name, value):
        if name.startswith('_'):
            object.__setattr__(self, name, value)
        else:
            self._values[name] = value

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)
        return self._values.get(name)

    def log(self, message):
        self._logs.append(str(message))

outputs = _OutputsProxy()

# --- HTTP request capture (requests library only) ---
_kizen_http_requests = []

def _kizen_install_http_capture():
    try:
        import requests
    except Exception:
        return
    import time, datetime

    _original_send = requests.Session.send

    def _kizen_send(self, request, **kwargs):
        submitted_at = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
        start = time.time()
        error_type = None
        response = None
        try:
            response = _original_send(self, request, **kwargs)
            return response
        except Exception as exc:
            error_type = type(exc).__name__
            raise
        finally:
            body = request.body
            if isinstance(body, bytes):
                try:
                    body = body.decode('utf-8')
                except Exception:
                    body = '<binary>'
            elif body is None:
                body = ''

            status = 0
            resp_headers = {}
            resp_body = ''
            if response is not None:
                status = response.status_code
                resp_headers = dict(response.headers)
                if kwargs.get('stream'):
                    resp_body = '<streamed>'
                else:
                    try:
                        resp_body = response.text
                    except Exception:
                        resp_body = '<unreadable>'

            _kizen_http_requests.append({
                'method': request.method or '',
                'url': request.url or '',
                'headers': dict(request.headers or {}),
                'body': body,
                'requestSubmittedAt': submitted_at,
                'session': True,
                'responseStatusCode': status,
                'responseHeaders': resp_headers,
                'responseBody': resp_body,
                'requestErrorType': error_type,
                'duration': time.time() - start,
            })

    requests.Session.send = _kizen_send

_kizen_install_http_capture()

def _kizen_http_summary():
    if not _kizen_http_requests:
        return None
    return {
        'count': len(_kizen_http_requests),
        'notLogged': 0,
        'requests': _kizen_http_requests,
    }

# --- Execute user script ---
try:
    exec(open(os.environ['__KIZEN_SCRIPT_PATH__'], encoding='utf-8').read())
    result = {
        'success': True,
        'outputValues': outputs._values,
        'logs': outputs._logs,
        'error': None,
        'httpRequests': _kizen_http_summary(),
    }
except Exception:
    # Build a clean traceback that hides the wrapper internals.
    # Keep only frames from the user script (shown as File "<string>")
    # and re-label them with "script.py" for clarity.
    exc_type, exc_value, exc_tb = sys.exc_info()
    entries = traceback.extract_tb(exc_tb)
    user_entries = [e for e in entries if e.filename != __file__]
    for e in user_entries:
        if e.filename == '<string>':
            e.filename = 'script.py'
    lines = ['Traceback (most recent call last):\\n']
    lines += traceback.format_list(user_entries)
    lines += traceback.format_exception_only(exc_type, exc_value)
    result = {
        'success': False,
        'outputValues': outputs._values,
        'logs': outputs._logs,
        'error': ''.join(lines),
        'httpRequests': _kizen_http_summary(),
    }

# Write results between markers so we can extract them reliably
# even if the user script wrote to stdout
sys.stdout.write('\\n__KIZEN_RESULT_START__\\n')
sys.stdout.write(json.dumps(result, ensure_ascii=False))
sys.stdout.write('\\n__KIZEN_RESULT_END__\\n')
sys.stdout.flush()
`.trim();

const DEFAULT_TIMEOUT = 30_000;

export type VenvInstallEvent =
  | { kind: 'start' }
  | { kind: 'log'; line: string; stream: 'stdout' | 'stderr' }
  | { kind: 'complete' }
  | { kind: 'error'; message: string };

export type VenvInstallListener = (event: VenvInstallEvent) => void;

export interface ExecuteStepParams {
  script: string;
  scriptRuntime: string;
  inputs: Record<string, StepInputValue>;
  secrets: Record<string, string>;
  timeout?: number;
  onInstallProgress?: VenvInstallListener;
}

const VENV_DIR = join(process.cwd(), '.kizenapp', 'venv');

// The production Kizen code-runner service only ships python-3-12 and
// python-3-13 runtime images. Reject any other runtime locally so a bad or
// unsupported "runtime" in a step's config.json fails fast
const SUPPORTED_RUNTIMES = ['python-3-12', 'python-3-13'] as const;

function isSupportedRuntime(runtime: string): boolean {
  return (SUPPORTED_RUNTIMES as readonly string[]).includes(runtime);
}

// ./python-requirements.txt is the single source of truth for packages.
// Keep it in sync with the Python dependency set installed by the production
// Kizen code-runner service, so local runs match deployed ones.
const VENV_PACKAGES = parseRequirementsFile(requirementsTxt);

if (VENV_PACKAGES.length === 0) {
  throw new Error('python-requirements.txt bundled no packages — check the build output');
}

let venvReady: Promise<string> | null = null;

// The bundled requirements (psycopg 3.3 in particular) require Python >= 3.10,
// matching the remote code-runner which only ships 3.12 / 3.13 images. A venv
// built on an older interpreter fails `pip install` with a cryptic
// "No matching distribution found for psycopg[binary]<4.0,>=3.3".
const MIN_PYTHON: readonly [number, number] = [3, 10];

function meetsMinimum([major, minor]: [number, number]): boolean {
  return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
}

function formatVersion(version: readonly [number, number]): string {
  return `${String(version[0])}.${String(version[1])}`;
}

// Probe an interpreter for its (major, minor) version. Resolves null if the
// binary is missing or can't run, so callers can try the next candidate.
function probePython(bin: string): Promise<[number, number] | null> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-c', "import sys; print('%d.%d' % sys.version_info[:2])"], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let out = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    proc.on('error', () => {
      resolve(null);
    });
    proc.on('close', (code) => {
      const match = /(\d+)\.(\d+)/.exec(out);

      if (code !== 0 || !match) {
        resolve(null);

        return;
      }

      resolve([Number(match[1]), Number(match[2])]);
    });
  });
}

// Pick a system interpreter new enough to install the bundled requirements.
// Prefer the exact version the runtime asked for, then fall back to python3.
// Throws a clear, actionable error when nothing usable is found.
async function findSystemPython(runtime: string): Promise<string> {
  const preferred = resolvePythonBinary(runtime);
  const candidates = preferred === 'python3' ? ['python3'] : [preferred, 'python3'];
  const tried: string[] = [];

  for (const bin of candidates) {
    const version = await probePython(bin);

    if (!version) {
      tried.push(`${bin}: not found`);

      continue;
    }

    if (meetsMinimum(version)) {
      return bin;
    }

    tried.push(`${bin}: ${formatVersion(version)} (too old)`);
  }

  throw new Error(
    `No Python >= ${formatVersion(MIN_PYTHON)} found for runtime "${runtime}". ` +
      `The local runner needs Python ${formatVersion(MIN_PYTHON)}+ to install the bundled ` +
      `packages (e.g. psycopg 3.3), matching the remote code-runner (3.12 / 3.13). ` +
      `Tried ${tried.join(', ')}. Install Python 3.12 or 3.13 and retry.`,
  );
}

function runCommand(
  bin: string,
  args: string[],
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const pipeLines = (source: NodeJS.ReadableStream, stream: 'stdout' | 'stderr'): string[] => {
      const captured: string[] = [];
      let buffer = '';

      source.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');

        let idx = buffer.indexOf('\n');

        while (idx >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');

          buffer = buffer.slice(idx + 1);

          captured.push(line);
          onLine?.(line, stream);
          idx = buffer.indexOf('\n');
        }
      });

      source.on('end', () => {
        if (buffer.length > 0) {
          const line = buffer.replace(/\r$/, '');

          captured.push(line);
          onLine?.(line, stream);
        }
      });

      return captured;
    };

    const stderrCaptured = pipeLines(proc.stderr, 'stderr');

    pipeLines(proc.stdout, 'stdout');

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrCaptured.slice(-10).join('\n').trim();
        const detail = tail.length > 0 ? `: ${tail}` : '';

        reject(new Error(`${bin} exited with code ${String(code)}${detail}`));
      }
    });
  });
}

// Progress listeners for the in-flight venv build, so every caller awaiting the
// same build receives its install output. Non-null only while a build is live,
// so a cached-return call doesn't leak a listener that never fires.
let venvInstallListeners: Set<VenvInstallListener> | null = null;

function ensureVenv(runtime: string, listener?: VenvInstallListener): Promise<string> {
  if (venvReady) {
    // Build already running or done. Attach to its progress if it's still live.
    if (listener) {
      venvInstallListeners?.add(listener);
    }

    return venvReady;
  }

  const listeners = new Set<VenvInstallListener>();

  if (listener) {
    listeners.add(listener);
  }

  venvInstallListeners = listeners;

  const emit = (event: VenvInstallEvent): void => {
    for (const l of listeners) {
      l(event);
    }
  };

  const venvPython = join(VENV_DIR, 'bin', 'python');

  venvReady = (async () => {
    try {
      // Reuse an existing venv only when its interpreter is new enough for the
      // bundled requirements; otherwise rebuild it. A stale venv (e.g. Python
      // 3.9) would otherwise fail `pip install` every time with a cryptic
      // "No matching distribution" error for psycopg 3.3.
      let reusable = false;

      try {
        await access(venvPython);

        const existing = await probePython(venvPython);

        reusable = existing !== null && meetsMinimum(existing);
      } catch {
        reusable = false;
      }

      if (!reusable) {
        // Clear any stale/half-built venv before recreating it. Best-effort:
        // rm of a missing dir is a no-op with force.
        await rm(VENV_DIR, { recursive: true, force: true }).catch(() => {
          /* ignore */
        });

        const systemPython = await findSystemPython(runtime);

        await runCommand(systemPython, ['-m', 'venv', VENV_DIR]);
      }

      emit({ kind: 'start' });

      await runCommand(
        venvPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', ...VENV_PACKAGES],
        (line, stream) => {
          emit({ kind: 'log', line, stream });
        },
      );

      emit({ kind: 'complete' });

      return venvPython;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      emit({ kind: 'error', message });

      // Reset so the next call retries rather than returning the cached
      // rejection forever. Also nuke the venv dir: a half-built venv (a failed
      // `python -m venv` or an interpreter that's too old) would confuse the
      // reuse check on the next attempt. rm is best-effort — we rebuild either
      // way.
      venvReady = null;

      await rm(VENV_DIR, { recursive: true, force: true }).catch(() => {
        /* ignore */
      });

      throw err;
    } finally {
      venvInstallListeners = null;
    }
  })();

  return venvReady;
}

function parseResult(stdout: string): {
  userStdout: string;
  result: {
    success: boolean;
    outputValues: Record<string, unknown>;
    logs: string[];
    error: string | null;
    httpRequests: HttpRequests | null;
  } | null;
} {
  const startMarker = '__KIZEN_RESULT_START__';
  const endMarker = '__KIZEN_RESULT_END__';
  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    return { userStdout: stdout, result: null };
  }

  const userStdout = stdout.slice(0, startIdx).trimEnd();
  const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();

  try {
    const result = JSON.parse(jsonStr) as {
      success: boolean;
      outputValues: Record<string, unknown>;
      logs: string[];
      error: string | null;
      httpRequests: HttpRequests | null;
    };

    return { userStdout, result };
  } catch {
    return { userStdout: stdout, result: null };
  }
}

function failedExecutionResult(error: string): ExecutionResult {
  return {
    success: false,
    outputValues: {},
    logs: [],
    stdout: '',
    stderr: '',
    error,
    exitCode: 1,
    durationMs: 0,
  };
}

export async function executePythonStep(params: ExecuteStepParams): Promise<ExecutionResult> {
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;

  // Fail fast on a runtime the remote code-runner can't run, instead of
  // silently building a venv on whatever interpreter is handy.
  if (!isSupportedRuntime(params.scriptRuntime)) {
    return failedExecutionResult(
      `Unsupported runtime "${params.scriptRuntime}". Supported runtimes: ` +
        `${SUPPORTED_RUNTIMES.join(', ')}. Update the step's config.json "runtime" field ` +
        `(e.g. "python 3.13").`,
    );
  }

  const pythonBin = await ensureVenv(params.scriptRuntime, params.onInstallProgress);
  const start = Date.now();

  let tmpDir: string | undefined;

  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'kizen-step-'));

    const wrapperPath = join(tmpDir, 'wrapper.py');
    const scriptPath = join(tmpDir, 'script.py');

    await Promise.all([
      writeFile(wrapperPath, WRAPPER_SCRIPT, 'utf-8'),
      writeFile(scriptPath, params.script, 'utf-8'),
    ]);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      __KIZEN_INPUTS__: JSON.stringify(params.inputs),
      __KIZEN_SECRETS__: JSON.stringify(params.secrets),
      __KIZEN_SCRIPT_PATH__: scriptPath,
    };

    const { exitCode, stdout, stderr } = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const proc = spawn(pythonBin, [wrapperPath], {
        env,
        cwd: tmpDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, timeout);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      const finish = (code: number | null): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        });
      };

      proc.on('close', finish);
      proc.on('error', (err) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout: '',
          stderr: err.message,
        });
      });
    });

    const durationMs = Date.now() - start;
    const { userStdout, result } = parseResult(stdout);

    if (result) {
      const base: ExecutionResult = {
        success: result.success,
        outputValues: result.outputValues,
        logs: result.logs,
        stdout: userStdout,
        stderr,
        exitCode,
        durationMs,
      };

      if (result.error !== null) {
        base.error = result.error;
      }

      if (result.httpRequests) {
        base.httpRequests = result.httpRequests;
      }

      return base;
    }

    // If we couldn't parse the result, the wrapper itself likely failed
    const base: ExecutionResult = {
      success: false,
      outputValues: {},
      logs: [],
      stdout: userStdout,
      stderr,
      exitCode,
      durationMs,
    };

    if (exitCode !== 0) {
      base.error = `Process exited with code ${String(exitCode)}`;
    }

    return base;
  } finally {
    if (tmpDir) {
      void rm(tmpDir, { recursive: true, force: true });
    }
  }
}
