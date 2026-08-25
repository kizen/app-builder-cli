import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_STAGE,
  compactEnvelope,
  defaultStageNotice,
  envelopeObject,
  invalidStageMessage,
  isValidStage,
  readManifestDefaults,
  resolveStage,
  stripTrailingNewlines,
  writeEnvelopeFile,
} from './encryptHelpers.js';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'encrypt-helpers-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Writes a kizen.json into a fresh subdirectory and returns that directory. */
async function manifestDir(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(workDir, name));

  await writeFile(join(dir, 'kizen.json'), contents, 'utf-8');

  return dir;
}

describe('envelopeObject', () => {
  it('marks the value as encrypted', () => {
    expect(envelopeObject('abc')).toEqual({ encrypted: true, value: 'abc' });
  });

  it('carries the value through verbatim', () => {
    const base64 = 'a/B+c=='.repeat(20);

    expect(envelopeObject(base64).value).toBe(base64);
  });
});

describe('compactEnvelope', () => {
  it('emits single-line JSON with no whitespace', () => {
    expect(compactEnvelope('abc')).toBe('{"encrypted":true,"value":"abc"}');
  });

  it('never contains a line break, even for a long base64 value', () => {
    const line = compactEnvelope('a/B+c=='.repeat(200));

    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('round-trips through JSON.parse back to the envelope object', () => {
    expect(JSON.parse(compactEnvelope('secret-value')) as unknown).toEqual({
      encrypted: true,
      value: 'secret-value',
    });
  });
});

describe('writeEnvelopeFile', () => {
  it('writes pretty JSON with a trailing newline', async () => {
    const path = join(workDir, 'envelope.json');

    await writeEnvelopeFile(path, 'abc');

    expect(await readFile(path, 'utf-8')).toBe('{\n  "encrypted": true,\n  "value": "abc"\n}\n');
  });

  it('keeps a long base64 value on a single line', async () => {
    const path = join(workDir, 'envelope-long.json');
    const base64 = 'a/B+c=='.repeat(200);

    await writeEnvelopeFile(path, base64);

    const lines = (await readFile(path, 'utf-8')).split('\n');
    const valueLine = lines.find((l) => l.includes('"value"'));

    expect(valueLine).toBe(`  "value": "${base64}"`);
  });

  it('produces a file that parses back to the envelope', async () => {
    const path = join(workDir, 'envelope-parse.json');

    await writeEnvelopeFile(path, 'xyz');

    expect(JSON.parse(await readFile(path, 'utf-8')) as unknown).toEqual({
      encrypted: true,
      value: 'xyz',
    });
  });

  it('rejects when the destination directory does not exist', async () => {
    await expect(writeEnvelopeFile(join(workDir, 'nope', 'out.json'), 'abc')).rejects.toThrow();
  });
});

describe('stage resolution', () => {
  it('accepts exactly dev and prod', () => {
    expect(isValidStage('dev')).toBe(true);
    expect(isValidStage('prod')).toBe(true);
    expect(isValidStage('production')).toBe(false);
    expect(isValidStage('DEV')).toBe(false);
    expect(isValidStage('')).toBe(false);
  });

  it('quotes the rejected value in the error message', () => {
    expect(invalidStageMessage('staging')).toBe(
      'Error: --stage must be "dev" or "prod" (got: "staging")',
    );
  });

  it('defaults to prod when --stage is omitted', () => {
    expect(DEFAULT_STAGE).toBe('prod');
    expect(resolveStage(undefined)).toEqual({ stage: 'prod', wasDefaulted: true });
  });

  it('passes an explicit stage through without flagging it as defaulted', () => {
    expect(resolveStage('dev')).toEqual({ stage: 'dev', wasDefaulted: false });
    expect(resolveStage('prod')).toEqual({ stage: 'prod', wasDefaulted: false });
  });

  it('does not flag an invalid stage as defaulted (the command exits before use)', () => {
    expect(resolveStage('staging')).toEqual({ stage: 'prod', wasDefaulted: false });
  });

  it('warns on stderr that prod keys were assumed', () => {
    expect(defaultStageNotice('prod')).toBe(
      'No --stage given; defaulting to prod encryption keys (pass --stage dev to override)\n',
    );
  });
});

describe('readManifestDefaults', () => {
  it('reads api_name from a single-object manifest', async () => {
    const dir = await manifestDir(
      'obj-',
      JSON.stringify({ api_name: 'acme_plugin', name: 'Acme' }),
    );

    expect(await readManifestDefaults(dir)).toEqual({ apiName: 'acme_plugin' });
  });

  it('reads api_name from the first entry of an array manifest', async () => {
    const dir = await manifestDir(
      'arr-',
      JSON.stringify([{ api_name: 'first_app' }, { api_name: 'second_app' }]),
    );

    expect(await readManifestDefaults(dir)).toEqual({ apiName: 'first_app' });
  });

  it('omits apiName when the manifest has an empty api_name', async () => {
    const dir = await manifestDir('empty-', JSON.stringify({ api_name: '' }));

    expect(await readManifestDefaults(dir)).toEqual({});
  });

  it('omits apiName when api_name is missing or not a string', async () => {
    const missing = await manifestDir('missing-', JSON.stringify({ name: 'Acme' }));
    const wrongType = await manifestDir('wrong-', JSON.stringify({ api_name: 42 }));

    expect(await readManifestDefaults(missing)).toEqual({});
    expect(await readManifestDefaults(wrongType)).toEqual({});
  });

  it('returns no defaults outside a plugin directory', async () => {
    expect(await readManifestDefaults(join(workDir, 'does-not-exist'))).toEqual({});
  });

  it('returns no defaults when kizen.json is malformed', async () => {
    const dir = await manifestDir('bad-', '{ not json');

    expect(await readManifestDefaults(dir)).toEqual({});
  });

  it('returns no defaults for an empty array manifest', async () => {
    const dir = await manifestDir('emptyarr-', '[]');

    expect(await readManifestDefaults(dir)).toEqual({});
  });
});

describe('stripTrailingNewlines', () => {
  it('strips a trailing LF, CRLF, or lone CR', () => {
    expect(stripTrailingNewlines('secret\n')).toBe('secret');
    expect(stripTrailingNewlines('secret\r\n')).toBe('secret');
    expect(stripTrailingNewlines('secret\r')).toBe('secret');
  });

  it('strips a run of trailing line breaks', () => {
    expect(stripTrailingNewlines('secret\n\n\n')).toBe('secret');
    expect(stripTrailingNewlines('secret\r\n\r\n')).toBe('secret');
  });

  it('leaves a value with no trailing break untouched', () => {
    expect(stripTrailingNewlines('secret')).toBe('secret');
  });

  it('preserves interior line breaks (a PEM key stays intact)', () => {
    expect(stripTrailingNewlines('-----BEGIN-----\nbody\n-----END-----\n')).toBe(
      '-----BEGIN-----\nbody\n-----END-----',
    );
  });

  it('preserves trailing spaces and tabs, which may be part of the secret', () => {
    expect(stripTrailingNewlines('secret  \n')).toBe('secret  ');
    expect(stripTrailingNewlines('secret\t')).toBe('secret\t');
  });

  it('reduces a newline-only value to the empty string', () => {
    expect(stripTrailingNewlines('\n')).toBe('');
    expect(stripTrailingNewlines('')).toBe('');
  });
});
