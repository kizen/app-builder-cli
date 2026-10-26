import { describe, expect, it } from 'vitest';
import {
  accountRequest,
  pinnedProfileNotice,
  selectAuth,
  type AccountFlags,
  type AccountRequestResult,
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
    expect(selectAuth(flags, {})).toStrictEqual(expected);
  });
});

describe('selectAuth and a named saved account', () => {
  it.each<[string, AuthFlags, Record<string, string>, AuthSelectionResult]>([
    [
      '--business with --env selects that saved account in that session',
      { env: 'staging', business: 'Acme', user: 'u1' },
      {},
      {
        ok: true,
        selection: {
          kind: 'oauth',
          env: 'staging',
          account: { business: 'Acme', user: 'u1', source: 'flags' },
        },
      },
    ],
    [
      'APPBUILDER_BUSINESS selects that saved account',
      {},
      { APPBUILDER_BUSINESS: 'Acme' },
      {
        ok: true,
        selection: {
          kind: 'oauth',
          account: { business: 'Acme', user: undefined, source: 'env' },
        },
      },
    ],
    [
      '--business with --profile is a usage error',
      { profile: 'Demo', business: 'Acme' },
      {},
      {
        ok: false,
        message:
          "--business selects a saved sign-in account, so it can't be combined with -c or --profile.",
      },
    ],
    [
      '--user with -c is a usage error',
      { credentials: '/tmp/c.json', user: 'u1' },
      {},
      {
        ok: false,
        message:
          "--user selects a saved sign-in account, so it can't be combined with -c or --profile.",
      },
    ],
    [
      '-c ignores APPBUILDER_BUSINESS and APPBUILDER_USER',
      { credentials: '/tmp/c.json' },
      { APPBUILDER_BUSINESS: 'Acme', APPBUILDER_USER: 'u1' },
      { ok: true, selection: { kind: 'api-key', credentials: '/tmp/c.json' } },
    ],
    [
      '--profile ignores a lone APPBUILDER_USER',
      { profile: 'Demo' },
      { APPBUILDER_USER: 'u1' },
      { ok: true, selection: { kind: 'api-key', profile: 'Demo' } },
    ],
    [
      'the session with a lone APPBUILDER_USER is a usage error',
      {},
      { APPBUILDER_USER: 'u1' },
      { ok: false, message: 'APPBUILDER_USER only applies with APPBUILDER_BUSINESS.' },
    ],
  ])('%s', (_label, flags, processEnv, expected) => {
    expect(selectAuth(flags, processEnv)).toStrictEqual(expected);
  });
});

describe('accountRequest', () => {
  it.each<[string, AccountFlags, Record<string, string>, AccountRequestResult]>([
    ['nothing names an account: the current one', {}, {}, { ok: true, request: undefined }],
    [
      '--business alone',
      { business: 'Acme' },
      {},
      { ok: true, request: { business: 'Acme', user: undefined, source: 'flags' } },
    ],
    [
      'the flags replace the variables as a pair',
      { business: 'Acme' },
      { APPBUILDER_BUSINESS: 'Other', APPBUILDER_USER: 'u9' },
      { ok: true, request: { business: 'Acme', user: undefined, source: 'flags' } },
    ],
    [
      'the variables when no flag is passed',
      {},
      { APPBUILDER_BUSINESS: 'Other', APPBUILDER_USER: 'u9' },
      { ok: true, request: { business: 'Other', user: 'u9', source: 'env' } },
    ],
    [
      'an empty APPBUILDER_BUSINESS is unset',
      {},
      { APPBUILDER_BUSINESS: '' },
      { ok: true, request: undefined },
    ],
    [
      'an empty APPBUILDER_USER is unset',
      {},
      { APPBUILDER_BUSINESS: 'Other', APPBUILDER_USER: '' },
      { ok: true, request: { business: 'Other', user: undefined, source: 'env' } },
    ],
    [
      '--user without --business',
      { user: 'u1' },
      { APPBUILDER_BUSINESS: 'Other' },
      { ok: false, message: '--user only applies with --business.' },
    ],
    [
      'APPBUILDER_USER without APPBUILDER_BUSINESS',
      {},
      { APPBUILDER_BUSINESS: '', APPBUILDER_USER: 'u1' },
      { ok: false, message: 'APPBUILDER_USER only applies with APPBUILDER_BUSINESS.' },
    ],
  ])('%s', (_label, flags, processEnv, expected) => {
    expect(accountRequest(flags, processEnv)).toStrictEqual(expected);
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
