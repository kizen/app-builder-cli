import { describe, expect, it, vi } from 'vitest';
import type { Credentials, Environment } from './credentials.js';
import { resolveCreateDefaults, type CreateDefaultsDeps } from './createDefaults.js';
import { loginRequired } from './oauth.js';

const SAVED_CREDENTIALS = {
  businessId: 'api-key-business',
  environment: 'fmo',
} as Credentials;

interface Fixture {
  deps: CreateDefaultsDeps;
  loadGlobalCredentials: ReturnType<typeof vi.fn<() => Promise<Credentials | null>>>;
  readSession: ReturnType<typeof vi.fn<CreateDefaultsDeps['readSession']>>;
}

/** Session business ids keyed by environment; a `null` session throws like a corrupt file. */
function makeDeps(
  sessions: Partial<Record<Environment, string | null>>,
  credentials: Credentials | null = SAVED_CREDENTIALS,
  requestedEnvironment?: string,
): Fixture {
  const loadGlobalCredentials = vi.fn(() => Promise.resolve(credentials));
  const readSession = vi.fn<CreateDefaultsDeps['readSession']>((environment) => {
    const businessId = sessions[environment];

    if (businessId === null) {
      return Promise.reject(loginRequired(environment, 'unreadable session file'));
    }

    return Promise.resolve(businessId === undefined ? null : { businessId });
  });
  const deps: CreateDefaultsDeps = {
    listSessions: () => Promise.resolve(Object.keys(sessions) as Environment[]),
    readSession,
    loadGlobalCredentials,
    ...(requestedEnvironment !== undefined && { requestedEnvironment }),
  };

  return { deps, loadGlobalCredentials, readSession };
}

describe('resolveCreateDefaults', () => {
  it('signed in to one environment defaults business and environment from that session without reading credentials.json', async () => {
    const { deps, loadGlobalCredentials } = makeDeps({ staging: 'staging-business' });

    await expect(resolveCreateDefaults(deps)).resolves.toEqual({
      businessId: 'staging-business',
      environment: 'staging',
    });
    expect(loadGlobalCredentials).not.toHaveBeenCalled();
  });

  it("signed in with -e defaults the business from that environment's session", async () => {
    const { deps, loadGlobalCredentials } = makeDeps(
      { go: 'go-business', staging: 'staging-business' },
      SAVED_CREDENTIALS,
      ' staging ',
    );

    await expect(resolveCreateDefaults(deps)).resolves.toEqual({
      businessId: 'staging-business',
      environment: 'staging',
    });
    expect(loadGlobalCredentials).not.toHaveBeenCalled();
  });

  it("signed in to several environments without -e defaults to go and go's session", async () => {
    const { deps, loadGlobalCredentials } = makeDeps({
      staging: 'staging-business',
      go: 'go-business',
    });

    await expect(resolveCreateDefaults(deps)).resolves.toEqual({
      businessId: 'go-business',
      environment: 'go',
    });
    expect(loadGlobalCredentials).not.toHaveBeenCalled();
  });

  it('signed in but no session for the requested environment leaves the business empty', async () => {
    const { deps, loadGlobalCredentials } = makeDeps(
      { staging: 'staging-business' },
      SAVED_CREDENTIALS,
      'fmo',
    );

    await expect(resolveCreateDefaults(deps)).resolves.toEqual({
      businessId: '',
      environment: 'fmo',
    });
    expect(loadGlobalCredentials).not.toHaveBeenCalled();
  });

  it('an unreadable session leaves the business empty instead of failing', async () => {
    const { deps, loadGlobalCredentials, readSession } = makeDeps({ staging: null });

    await expect(resolveCreateDefaults(deps)).resolves.toEqual({
      businessId: '',
      environment: 'staging',
    });
    expect(readSession).toHaveBeenCalledWith('staging');
    expect(loadGlobalCredentials).not.toHaveBeenCalled();
  });

  it('signed out falls back to credentials.json defaults as before', async () => {
    const { deps, readSession } = makeDeps({});

    await expect(resolveCreateDefaults(deps)).resolves.toEqual({
      businessId: 'api-key-business',
      environment: 'fmo',
    });
    expect(readSession).not.toHaveBeenCalled();
  });

  it('signed out with no credentials.json defaults to go and an empty business', async () => {
    const { deps } = makeDeps({}, null);

    await expect(resolveCreateDefaults(deps)).resolves.toEqual({
      businessId: '',
      environment: 'go',
    });
  });

  it('a session list that fails to read falls back to credentials.json defaults', async () => {
    const { deps } = makeDeps({});

    deps.listSessions = () => Promise.reject(new Error('EACCES'));

    await expect(resolveCreateDefaults(deps)).resolves.toEqual({
      businessId: 'api-key-business',
      environment: 'fmo',
    });
  });
});
