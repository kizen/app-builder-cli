import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findKizenPython } from './kizenVenv.js';
import {
  CODE_STEP_MIN_PYTHON,
  findCodeStepPython,
  findPython,
  probePython,
} from './pythonProbe.js';

/** What each fake binary prints for its version; a missing key is a binary that isn't installed. */
const hooks = vi.hoisted(() => ({
  versions: {} as Record<string, string>,
  spawned: [] as string[][],
}));

vi.mock('node:child_process', () => ({
  spawn: (bin: string, args: string[]) => {
    hooks.spawned.push([bin, ...args]);

    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    const version = hooks.versions[bin];

    setImmediate(() => {
      if (version === undefined) {
        proc.emit('error', Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }));

        return;
      }

      proc.stdout.emit('data', Buffer.from(`${version}\n`));
      proc.emit('close', 0);
    });

    return proc;
  },
}));

afterEach(() => {
  hooks.versions = {};
  hooks.spawned = [];
});

const PROBE_ARGS = ['-c', "import sys; print('%d.%d' % sys.version_info[:2])"];

describe('probePython', () => {
  it('reads major.minor from the interpreter, and null when it is missing', async () => {
    hooks.versions = { python3: '3.13' };

    await expect(probePython('python3')).resolves.toStrictEqual([3, 13]);
    await expect(probePython('python9')).resolves.toBeNull();
    expect(hooks.spawned).toStrictEqual([
      ['python3', ...PROBE_ARGS],
      ['python9', ...PROBE_ARGS],
    ]);
  });
});

describe('findCodeStepPython (pythonExecutor, unchanged)', () => {
  it('keeps the 3.10 minimum', () => {
    expect(CODE_STEP_MIN_PYTHON).toStrictEqual([3, 10]);
  });

  it('prefers the runtime binary and stops there without probing python3', async () => {
    hooks.versions = { 'python3.13': '3.13', python3: '3.12' };

    await expect(findCodeStepPython('python-3-13')).resolves.toBe('python3.13');
    expect(hooks.spawned.map(([bin]) => bin)).toStrictEqual(['python3.13']);
  });

  it('falls back to python3, and probes only python3 for a runtime without a version', async () => {
    hooks.versions = { python3: '3.10' };

    await expect(findCodeStepPython('python-3-12')).resolves.toBe('python3');
    await expect(findCodeStepPython('python')).resolves.toBe('python3');
    expect(hooks.spawned.map(([bin]) => bin)).toStrictEqual(['python3.12', 'python3', 'python3']);
  });

  it('throws the same error text as before the extraction', async () => {
    hooks.versions = { python3: '3.9' };

    await expect(findCodeStepPython('python-3-13')).rejects.toThrow(
      'No Python >= 3.10 found for runtime "python-3-13". The local runner needs Python 3.10+ ' +
        'to install the bundled packages (e.g. psycopg 3.3), matching the remote code-runner ' +
        '(3.12 / 3.13). Tried python3.13: not found, python3: 3.9 (too old). ' +
        'Install Python 3.12 or 3.13 and retry.',
    );
  });
});

describe('findPython', () => {
  it('keeps the earlier candidate on a tie when preferring the newest', async () => {
    hooks.versions = { a: '3.13', b: '3.13' };

    await expect(findPython(['a', 'b'], [3, 12], 'newest')).resolves.toStrictEqual({
      found: { bin: 'a', version: [3, 13] },
      tried: [],
    });
  });
});

describe('findKizenPython', () => {
  it('accepts Python 3.14 and prefers it over 3.12', async () => {
    hooks.versions = { 'python3.14': '3.14', 'python3.12': '3.12', python3: '3.12' };

    await expect(findKizenPython()).resolves.toStrictEqual({
      bin: 'python3.14',
      version: [3, 14],
    });
  });

  it('prefers the newest even when it is the last candidate, with no upper cap', async () => {
    hooks.versions = { 'python3.12': '3.12', python3: '3.15' };

    await expect(findKizenPython()).resolves.toStrictEqual({ bin: 'python3', version: [3, 15] });
    expect(hooks.spawned.map(([bin]) => bin)).toStrictEqual([
      'python3.14',
      'python3.13',
      'python3.12',
      'python3',
    ]);
  });

  it('rejects Python 3.11 as too old and names every candidate it tried', async () => {
    hooks.versions = { python3: '3.11' };

    await expect(findKizenPython()).rejects.toThrow(
      'No Python 3.12 or newer found to run kizen. Tried python3.14: not found, ' +
        'python3.13: not found, python3.12: not found, python3: 3.11 (too old). ' +
        'Install Python 3.12 or newer and retry.',
    );
  });
});
