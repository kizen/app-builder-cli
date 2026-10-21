import { describe, expect, it } from 'vitest';
import {
  API_KEY_FLAGS_HINT,
  notSignedInWithApiKeyHint,
  pinnedProfileNotice,
  selectAuth,
  type AuthFlags,
  type AuthSelectionResult,
} from './authSelection.js';

const OAUTH_WITH_API_KEY = "--oauth can't be combined with -c or --profile.";
const ENV_WITH_API_KEY =
  "--env selects a sign-in session, so it can't be combined with -c or --profile.";

describe('selectAuth', () => {
  it.each<[string, AuthFlags, AuthSelectionResult]>([
    ['no flags uses the sign-in session', {}, { ok: true, selection: { kind: 'oauth' } }],
    [
      '--oauth is a no-op alias for the default',
      { oauth: true },
      { ok: true, selection: { kind: 'oauth' } },
    ],
    [
      '--env selects that session without --oauth',
      { env: 'staging' },
      { ok: true, selection: { kind: 'oauth', env: 'staging' } },
    ],
    [
      '--oauth --env selects that session',
      { oauth: true, env: 'staging' },
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
      '--oauth with -c is a usage error',
      { oauth: true, credentials: '/tmp/c.json' },
      {
        ok: false,
        message: OAUTH_WITH_API_KEY,
      },
    ],
    [
      '--oauth with --profile is a usage error',
      { oauth: true, profile: 'Demo' },
      {
        ok: false,
        message: OAUTH_WITH_API_KEY,
      },
    ],
    [
      '--oauth --env with --profile reports --oauth first',
      { oauth: true, env: 'go', profile: 'Demo' },
      {
        ok: false,
        message: OAUTH_WITH_API_KEY,
      },
    ],
    [
      '--env with --profile is a usage error',
      { env: 'staging', profile: 'Demo' },
      {
        ok: false,
        message: ENV_WITH_API_KEY,
      },
    ],
    [
      '--env with -c is a usage error',
      { env: 'staging', credentials: '/tmp/c.json' },
      {
        ok: false,
        message: ENV_WITH_API_KEY,
      },
    ],
    [
      '--oauth: false is the same as leaving it out',
      { oauth: false, profile: 'Demo' },
      { ok: true, selection: { kind: 'api-key', profile: 'Demo' } },
    ],
  ])('%s', (_label, flags, expected) => {
    expect(selectAuth(flags)).toStrictEqual(expected);
  });

  it('never sets the other API-key field', () => {
    const result = selectAuth({ profile: 'Demo' });

    expect(result.ok && Object.keys(result.selection)).toStrictEqual(['kind', 'profile']);
  });
});

describe('copy helpers', () => {
  it('appends the API-key flags to the not-signed-in message', () => {
    expect(notSignedInWithApiKeyHint("You're not signed in.")).toBe(
      `You're not signed in. ${API_KEY_FLAGS_HINT}`,
    );
    expect(API_KEY_FLAGS_HINT).toContain('--profile <name>');
    expect(API_KEY_FLAGS_HINT).toContain('-c <path>');
  });

  it('names the pinned profile and the flag that uses it, on one line', () => {
    const notice = pinnedProfileNotice('Demo');

    expect(notice).toBe(
      'Ignoring the API-key profile "Demo" pinned in .kizenapp/config.json and using your sign-in session. Pass --profile Demo to use the API key.',
    );
    expect(notice).not.toContain('\n');
  });

  it('pinned profile notice quotes a profile name with a space so the command pastes', () => {
    expect(pinnedProfileNotice('My Demo')).toBe(
      'Ignoring the API-key profile "My Demo" pinned in .kizenapp/config.json and using your sign-in session. Pass --profile "My Demo" to use the API key.',
    );
  });

  it('pinned profile notice stays one line for a name containing a newline', () => {
    const notice = pinnedProfileNotice('a\nb');

    expect(notice).not.toContain('\n');
    expect(notice).toBe(
      'Ignoring the API-key profile "a\\nb" pinned in .kizenapp/config.json and using your sign-in session. Pass --profile "a\\nb" to use the API key.',
    );
  });
});
