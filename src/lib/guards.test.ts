import { describe, expect, it } from 'vitest';
import { errorMessage, ifExists, nonEmptyString } from './guards.js';

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe('ifExists', () => {
  it('ifExists resolves undefined on ENOENT and rethrows other errors', async () => {
    const denied = errno('EACCES');

    await expect(ifExists(Promise.resolve('contents'))).resolves.toBe('contents');
    await expect(ifExists(Promise.reject(errno('ENOENT')))).resolves.toBeUndefined();
    await expect(ifExists(Promise.reject(denied))).rejects.toBe(denied);
    await expect(ifExists(Promise.reject(new Error('ENOENT')))).rejects.toThrow('ENOENT');
  });
});

describe('nonEmptyString', () => {
  it('keeps a non-empty string and maps everything else to undefined', () => {
    expect(nonEmptyString('id-1')).toBe('id-1');
    expect(nonEmptyString(' ')).toBe(' ');
    expect(nonEmptyString('')).toBeUndefined();
    expect(nonEmptyString(42)).toBeUndefined();
    expect(nonEmptyString(null)).toBeUndefined();
  });
});

describe('errorMessage', () => {
  it("is an Error's message, else the value as a string", () => {
    expect(errorMessage(new TypeError('boom'))).toBe('boom');
    expect(errorMessage('plain text')).toBe('plain text');
    expect(errorMessage(42)).toBe('42');
  });
});
