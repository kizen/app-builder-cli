import { describe, expect, it } from 'vitest';
import {
  pinnedProfileNotice,
  selectAuth,
  type AuthFlags,
  type AuthSelectionResult,
} from './authSelection.js';

describe('selectAuth', () => {
  it.each<[string, AuthFlags, AuthSelectionResult]>([
    ['no flags uses the sign-in session', {}, { ok: true, selection: { kind: 'oauth' } }],
    [
      '--env selects that session',
      { env: 'staging' },
      { ok: true, selection: { kind: 'oauth', env: 'staging' } },
    ],
    [
      '-c uses that API-key file',
      { credentials: '/tmp/c.json' },
      { ok: true, selection: { kind: 'api-key', credentials: '/tmp/c.json' } },
    ],
    [
      '--profile uses that API-key profile',
      { profile: 'Demo' },
      { ok: true, selection: { kind: 'api-key', profile: 'Demo' } },
    ],
    [
      '-c wins over --profile',
      { credentials: '/tmp/c.json', profile: 'Demo' },
      { ok: true, selection: { kind: 'api-key', credentials: '/tmp/c.json' } },
    ],
    [
      '--env with --profile is a usage error',
      { env: 'staging', profile: 'Demo' },
      {
        ok: false,
        message: "--env selects a sign-in session, so it can't be combined with -c or --profile.",
      },
    ],
  ])('%s', (_label, flags, expected) => {
    expect(selectAuth(flags)).toStrictEqual(expected);
  });
});

describe('copy helpers', () => {
  it('pinned profile notice leaves safe values bare and single-quotes the rest', () => {
    for (const [profile, arg] of [
      ['kizen-go', 'kizen-go'],
      ['My Demo', "'My Demo'"],
      ["it's", "'it'\\''s'"],
      ['=x', "'=x'"],
    ] as const) {
      expect(pinnedProfileNotice(profile)).toContain(`Pass --profile ${arg} to use the API key.`);
    }

    // A control character is only ever shown JSON-escaped: no terminal escapes, still one line.
    for (const profile of ['x\u001b[2K\u001b[1A', 'a\nb']) {
      expect(pinnedProfileNotice(profile)).not.toMatch(/[\x00-\x1f\x7f]/);
    }
  });
});
