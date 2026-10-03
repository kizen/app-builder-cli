import type { ValidationIssue } from '@kizenapps/packager';
import { describe, expect, it } from 'vitest';
import { formatValidationIssues } from './formatValidationIssues.js';

const issue = (overrides: Partial<ValidationIssue>): ValidationIssue => ({
  rule: 'manifest/required-field',
  severity: 'error',
  message: 'api_name is required',
  ...overrides,
});

describe('formatValidationIssues', () => {
  it('returns an empty string when there are no issues', () => {
    expect(formatValidationIssues([])).toBe('');
  });

  it('prints a singular error header, the path, and the message with its rule', () => {
    expect(formatValidationIssues([issue({ path: 'kizen.json' })])).toBe(
      [
        '✗ 1 validation error',
        '',
        'kizen.json',
        '  ✗ api_name is required (manifest/required-field)',
      ].join('\n'),
    );
  });

  it('groups issues by path, falling back to the plugin api_name and then "general"', () => {
    const output = formatValidationIssues([
      issue({ path: 'src/blocks/a/script.js', message: 'first' }),
      issue({ pluginApiName: 'acme', message: 'second' }),
      issue({ path: 'src/blocks/a/script.js', message: 'third' }),
      issue({ message: 'fourth' }),
    ]);

    expect(output).toBe(
      [
        '✗ 4 validation errors',
        '',
        'src/blocks/a/script.js',
        '  ✗ first (manifest/required-field)',
        '  ✗ third (manifest/required-field)',
        '',
        'acme',
        '  ✗ second (manifest/required-field)',
        '',
        'general',
        '  ✗ fourth (manifest/required-field)',
      ].join('\n'),
    );
  });

  it('counts errors and warnings separately and marks warnings with ⚠', () => {
    const output = formatValidationIssues([
      issue({ path: 'kizen.json' }),
      issue({ path: 'kizen.json', severity: 'warning', rule: 'style/x', message: 'heads up' }),
    ]);

    expect(output.split('\n')[0]).toBe('✗ 1 validation error, 1 warning');
    expect(output).toContain('  ⚠ heads up (style/x)');
  });

  it('uses a warning header when only warnings are present', () => {
    const output = formatValidationIssues([
      issue({ severity: 'warning', path: 'a.js' }),
      issue({ severity: 'warning', path: 'b.js' }),
    ]);

    expect(output.split('\n')[0]).toBe('⚠ 2 validation warnings');
    expect(output).not.toContain('✗');
  });
});
