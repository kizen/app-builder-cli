/**
 * Finding a system Python: probe each candidate binary for its version and pick one that's new
 * enough. Shared by the code-step venv (`src/server/pythonExecutor.ts`) and the kizen venv
 * (`kizenVenv.ts`).
 */
import { spawn } from 'node:child_process';
import { resolvePythonBinary } from './pythonRuntime.js';

export type PythonVersion = readonly [major: number, minor: number];

export interface FoundPython {
  bin: string;
  version: PythonVersion;
}

export function meetsMinimum([major, minor]: PythonVersion, minimum: PythonVersion): boolean {
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

export function formatVersion(version: PythonVersion): string {
  return `${String(version[0])}.${String(version[1])}`;
}

const newer = (a: PythonVersion, b: PythonVersion): boolean =>
  a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

// Probe an interpreter for its (major, minor) version. Resolves null if the
// binary is missing or can't run, so callers can try the next candidate.
export function probePython(bin: string): Promise<[number, number] | null> {
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

export interface FindPythonResult {
  /** Undefined when no candidate meets the minimum. */
  found: FoundPython | undefined;
  /** One `<bin>: not found` or `<bin>: <x.y> (too old)` per candidate rejected. */
  tried: string[];
}

/**
 * Probes `candidates` in order against `minimum`. `first` stops at the first one that meets it;
 * `newest` probes them all and picks the newest that does (the earlier candidate on a tie).
 */
export async function findPython(
  candidates: readonly string[],
  minimum: PythonVersion,
  prefer: 'first' | 'newest',
  probe: (bin: string) => Promise<PythonVersion | null> = probePython,
): Promise<FindPythonResult> {
  const tried: string[] = [];
  let found: FoundPython | undefined;

  for (const bin of candidates) {
    const version = await probe(bin);

    if (!version) {
      tried.push(`${bin}: not found`);

      continue;
    }

    if (!meetsMinimum(version, minimum)) {
      tried.push(`${bin}: ${formatVersion(version)} (too old)`);

      continue;
    }

    if (found === undefined || newer(version, found.version)) {
      found = { bin, version };
    }

    if (prefer === 'first') {
      break;
    }
  }

  return { found, tried };
}

// The bundled requirements (psycopg 3.3 in particular) require Python >= 3.10,
// matching the remote code-runner which only ships 3.12 / 3.13 images. A venv
// built on an older interpreter fails `pip install` with a cryptic
// "No matching distribution found for psycopg[binary]<4.0,>=3.3".
export const CODE_STEP_MIN_PYTHON: PythonVersion = [3, 10];

// Pick a system interpreter new enough to install the code-step venv's bundled
// requirements. Prefer the exact version the runtime asked for, then fall back
// to python3. Throws a clear, actionable error when nothing usable is found.
export async function findCodeStepPython(
  runtime: string,
  probe: (bin: string) => Promise<PythonVersion | null> = probePython,
): Promise<string> {
  const preferred = resolvePythonBinary(runtime);
  const candidates = preferred === 'python3' ? ['python3'] : [preferred, 'python3'];
  const { found, tried } = await findPython(candidates, CODE_STEP_MIN_PYTHON, 'first', probe);

  if (found !== undefined) {
    return found.bin;
  }

  throw new Error(
    `No Python >= ${formatVersion(CODE_STEP_MIN_PYTHON)} found for runtime "${runtime}". ` +
      `The local runner needs Python ${formatVersion(CODE_STEP_MIN_PYTHON)}+ to install the bundled ` +
      `packages (e.g. psycopg 3.3), matching the remote code-runner (3.12 / 3.13). ` +
      `Tried ${tried.join(', ')}. Install Python 3.12 or 3.13 and retry.`,
  );
}
