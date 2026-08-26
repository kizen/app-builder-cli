import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRequirementsFile, resolvePythonBinary } from './pythonRuntime.js';

const REQUIREMENTS_PATH = fileURLToPath(
  new URL('../server/python-requirements.txt', import.meta.url),
);

describe('parseRequirementsFile', () => {
  it('returns one entry per non-empty line', () => {
    expect(parseRequirementsFile('requests\nnumpy\npytz')).toEqual(['requests', 'numpy', 'pytz']);
  });

  it('drops blank and whitespace-only lines', () => {
    expect(parseRequirementsFile('requests\n\n   \n\t\nnumpy\n')).toEqual(['requests', 'numpy']);
  });

  it('drops full-line comments, indented or not', () => {
    expect(parseRequirementsFile('# header\n   # indented\nrequests')).toEqual(['requests']);
  });

  it('strips inline comments and their leading whitespace', () => {
    expect(parseRequirementsFile('requests  # HTTP library\nnumpy\t# math')).toEqual([
      'requests',
      'numpy',
    ]);
  });

  it('preserves version specifiers and extras verbatim', () => {
    const parsed = parseRequirementsFile(
      'psycopg[binary]>=3.3,<4.0\nsqlalchemy>=2.0,<2.1\npymysql[rsa,ed25519]',
    );

    expect(parsed).toEqual([
      'psycopg[binary]>=3.3,<4.0',
      'sqlalchemy>=2.0,<2.1',
      'pymysql[rsa,ed25519]',
    ]);
  });

  it('trims surrounding whitespace, including CRLF carriage returns', () => {
    expect(parseRequirementsFile('  requests  \r\nnumpy\r\n')).toEqual(['requests', 'numpy']);
  });

  it('returns an empty list for empty or comment-only input', () => {
    expect(parseRequirementsFile('')).toEqual([]);
    expect(parseRequirementsFile('\n\n')).toEqual([]);
    expect(parseRequirementsFile('# only a comment\n')).toEqual([]);
  });

  it('yields clean pip positional arguments for the bundled requirements file', async () => {
    const content = await readFile(REQUIREMENTS_PATH, 'utf-8');
    const packages = parseRequirementsFile(content);

    expect(packages.length).toBeGreaterThan(0);
    expect(packages).toContain('requests');

    for (const pkg of packages) {
      expect(pkg).not.toContain('#');
      expect(pkg).toBe(pkg.trim());
      expect(pkg.length).toBeGreaterThan(0);
    }
  });
});

describe('resolvePythonBinary', () => {
  it('maps the deployed hyphen form to a dotted interpreter name', () => {
    expect(resolvePythonBinary('python-3-12')).toBe('python3.12');
    expect(resolvePythonBinary('python-3-13')).toBe('python3.13');
  });

  it('maps the dot form callers use without a runtime', () => {
    expect(resolvePythonBinary('python-3.12')).toBe('python3.12');
    expect(resolvePythonBinary('python-3.13')).toBe('python3.13');
  });

  it('handles multi-digit major and minor components', () => {
    expect(resolvePythonBinary('python-4-10')).toBe('python4.10');
    expect(resolvePythonBinary('python-10-2')).toBe('python10.2');
  });

  it('falls back to python3 for anything that is not the two accepted forms', () => {
    expect(resolvePythonBinary('python3.13')).toBe('python3');
    expect(resolvePythonBinary('python-3')).toBe('python3');
    expect(resolvePythonBinary('python-3-13-beta')).toBe('python3');
    expect(resolvePythonBinary('python-3-x')).toBe('python3');
    expect(resolvePythonBinary('node-20')).toBe('python3');
    expect(resolvePythonBinary('')).toBe('python3');
  });

  it('anchors the match so a prefixed or suffixed runtime does not slip through', () => {
    expect(resolvePythonBinary('xpython-3-13')).toBe('python3');
    expect(resolvePythonBinary('python-3-13 ')).toBe('python3');
  });
});
