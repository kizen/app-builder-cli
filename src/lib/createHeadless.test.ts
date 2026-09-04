import { describe, expect, it, vi } from 'vitest';
import {
  PLACEHOLDER_DESCRIPTION,
  parseArtifactSelection,
  resolveHeadlessInput,
  runHeadlessCreate,
} from './createHeadless.js';
import type { HeadlessDeps } from './createHeadless.js';
import { ARTIFACT_TYPES } from './createArtifacts.js';

const defaults = { businessId: 'biz-1', environment: 'go' } as const;

describe('parseArtifactSelection', () => {
  it('defaults to one of every type', () => {
    expect(parseArtifactSelection(undefined)).toEqual([...ARTIFACT_TYPES]);
  });

  it.each(['all', '  ', ''])('treats %j as every type', (raw) => {
    expect(parseArtifactSelection(raw)).toEqual([...ARTIFACT_TYPES]);
  });

  it('supports an explicit empty selection', () => {
    expect(parseArtifactSelection('none')).toEqual([]);
  });

  it('parses a comma-separated list, ignoring whitespace', () => {
    expect(parseArtifactSelection('block, jsAction')).toEqual(['block', 'jsAction']);
  });

  it('de-duplicates repeated types', () => {
    expect(parseArtifactSelection('block,block')).toEqual(['block']);
  });

  it('rejects an unknown type by name', () => {
    expect(() => parseArtifactSelection('block,nope')).toThrow(/nope/);
  });
});

describe('resolveHeadlessInput', () => {
  it('requires a name, which the scaffold cannot invent', () => {
    expect(() => resolveHeadlessInput({}, defaults, '/tmp/x')).toThrow(
      /--name is required for a non-interactive run/,
    );
  });

  it('infers api_name from the name when not given', () => {
    const input = resolveHeadlessInput({ name: 'My Plugin' }, defaults, '/tmp/x');

    expect(input.apiName).toBe('my_plugin');
  });

  it('rejects an api_name the packager would reject', () => {
    expect(() =>
      resolveHeadlessInput({ name: 'X', apiName: 'Bad-Name' }, defaults, '/tmp/x'),
    ).toThrow(/invalid/);
  });

  it('substitutes placeholder text for a missing description', () => {
    const input = resolveHeadlessInput({ name: 'My Plugin' }, defaults, '/tmp/x');

    expect(input.description).toBe(PLACEHOLDER_DESCRIPTION);
    expect(input.description).not.toBe('');
  });

  it('keeps an explicit description', () => {
    const input = resolveHeadlessInput(
      { name: 'My Plugin', description: 'Real words.' },
      defaults,
      '/tmp/x',
    );

    expect(input.description).toBe('Real words.');
  });

  it('falls back to the configured business id and environment', () => {
    const input = resolveHeadlessInput({ name: 'My Plugin' }, defaults, '/tmp/x');

    expect(input.developerBusinessId).toBe('biz-1');
    expect(input.developerEnvironment).toBe('go');
  });

  it('uses --environment to key the business id', () => {
    const input = resolveHeadlessInput(
      { name: 'My Plugin', businessId: 'biz-2', environment: 'staging' },
      defaults,
      '/tmp/x',
    );

    expect(input.developerBusinessId).toBe('biz-2');
    expect(input.developerEnvironment).toBe('staging');
  });

  it('rejects an unknown --environment by name', () => {
    expect(() =>
      resolveHeadlessInput({ name: 'My Plugin', environment: 'prod' }, defaults, '/tmp/x'),
    ).toThrow(/Unknown environment "prod"/);
  });

  it('borrows the saved environment for an overriding --business-id', () => {
    const input = resolveHeadlessInput(
      { name: 'My Plugin', businessId: 'biz-2' },
      defaults,
      '/tmp/x',
    );

    expect(input.developerEnvironment).toBe('go');
  });

  it('requires --environment with --business-id when nothing is saved', () => {
    expect(() =>
      resolveHeadlessInput(
        { name: 'My Plugin', businessId: 'biz-2' },
        { businessId: '', environment: 'go' },
        '/tmp/x',
      ),
    ).toThrow(/--environment is required/);
  });

  it('scaffolds every artifact type by default', () => {
    expect(resolveHeadlessInput({ name: 'My Plugin' }, defaults, '/tmp/x').artifacts).toEqual([
      ...ARTIFACT_TYPES,
    ]);
  });
});

describe('runHeadlessCreate', () => {
  const makeDeps = (
    overrides: Partial<HeadlessDeps> = {},
  ): HeadlessDeps & { out: string[]; err: string[]; codes: number[] } => {
    const out: string[] = [];
    const err: string[] = [];
    const codes: number[] = [];

    return {
      precheckTargetDir: vi.fn().mockResolvedValue('ok'),
      createPlugin: vi.fn().mockResolvedValue(undefined),
      writeStdout: (text: string) => out.push(text),
      writeStderr: (text: string) => err.push(text),
      setExitCode: (code: number) => codes.push(code),
      out,
      err,
      codes,
      ...overrides,
    };
  };

  it('scaffolds and reports success', async () => {
    const deps = makeDeps();

    await runHeadlessCreate({ name: 'My Plugin' }, defaults, '/tmp/x', deps);

    expect(deps.createPlugin).toHaveBeenCalledOnce();
    expect(deps.codes).toEqual([]);
    expect(deps.out.join('')).toContain('my_plugin');
    expect(deps.out.join('')).toMatch(/thumbnail\.png .*replace/);
  });

  it('exits non-zero without scaffolding when a required flag is missing', async () => {
    const deps = makeDeps();

    await runHeadlessCreate({}, defaults, '/tmp/x', deps);

    expect(deps.createPlugin).not.toHaveBeenCalled();
    expect(deps.codes).toEqual([1]);
  });

  it.each(['has-manifest', 'has-kizenapp'] as const)(
    'refuses to overwrite a directory reporting %s',
    async (reason) => {
      const deps = makeDeps({ precheckTargetDir: vi.fn().mockResolvedValue(reason) });

      await runHeadlessCreate({ name: 'My Plugin' }, defaults, '/tmp/x', deps);

      expect(deps.createPlugin).not.toHaveBeenCalled();
      expect(deps.codes).toEqual([1]);
    },
  );

  it('warns but still succeeds when no business id is configured', async () => {
    const deps = makeDeps();

    await runHeadlessCreate(
      { name: 'My Plugin' },
      { businessId: '', environment: 'go' },
      '/tmp/x',
      deps,
    );

    expect(deps.createPlugin).toHaveBeenCalledOnce();
    expect(deps.codes).toEqual([]);
    expect(deps.err.join('')).toMatch(/developer_business_id/);
  });
});
