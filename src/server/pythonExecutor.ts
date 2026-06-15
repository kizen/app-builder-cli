import { spawn } from 'node:child_process';
import { writeFile, rm, mkdtemp, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import requirementsTxt from './python-requirements.txt';
import { type ExecutionResult, type HttpRequests } from '../../shared/lib/execution.js';
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
  inputs: Record<string, string>;
  secrets: Record<string, string>;
  timeout?: number;
  onInstallProgress?: VenvInstallListener;
}

const VENV_DIR = join(process.cwd(), '.kizenapp', 'venv');

// Parse a pip requirements file: strip blank lines, full-line comments, and
// inline comments (e.g. `requests  # HTTP library`) so that every element is
// a clean specifier that pip accepts as a positional argument.
function parseRequirementsFile(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim().replace(/\s+#.*$/, ''))
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// ./python-requirements.txt is the single source of truth for packages.
// Keep it in sync with the remote code-runner:
//   webapp/apps/code_runner/runtimes/python/requirements.txt
const VENV_PACKAGES = parseRequirementsFile(requirementsTxt);

if (VENV_PACKAGES.length === 0) {
  throw new Error('python-requirements.txt bundled no packages — check the build output');
}

let venvReady: Promise<string> | null = null;

function resolvePythonBinary(runtime: string): string {
  // e.g. "python-3.9" -> try "python3.9" first
  const match = /^python-(\d+\.\d+)$/.exec(runtime);

  if (match?.[1]) {
    return `python${match[1]}`;
  }

  return 'python3';
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

const installListeners = new Set<VenvInstallListener>();

function emitInstall(event: VenvInstallEvent): void {
  for (const listener of installListeners) {
    listener(event);
  }
}

function ensureVenv(runtime: string, listener?: VenvInstallListener): Promise<string> {
  if (listener) {
    installListeners.add(listener);
  }

  if (!venvReady) {
    venvReady = (async () => {
      const venvPython = join(VENV_DIR, 'bin', 'python');

      try {
        await access(venvPython);
      } catch {
        const systemPython = resolvePythonBinary(runtime);

        await runCommand(systemPython, ['-m', 'venv', VENV_DIR]);
      }

      emitInstall({ kind: 'start' });

      try {
        await runCommand(
          venvPython,
          ['-m', 'pip', 'install', '--disable-pip-version-check', ...VENV_PACKAGES],
          (line, stream) => {
            emitInstall({ kind: 'log', line, stream });
          },
        );

        emitInstall({ kind: 'complete' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        emitInstall({ kind: 'error', message });

        // Reset so the next call retries rather than returning the cached
        // rejection forever. Also nuke the venv dir: if `python -m venv`
        // failed mid-create, the remnants will confuse the access() check
        // on the next attempt. rm is best-effort — we'll rebuild either way.
        venvReady = null;

        await rm(VENV_DIR, { recursive: true, force: true }).catch(() => {
          /* ignore */
        });

        throw err;
      } finally {
        installListeners.clear();
      }

      return venvPython;
    })();
  }

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

export async function executePythonStep(params: ExecuteStepParams): Promise<ExecutionResult> {
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;
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
