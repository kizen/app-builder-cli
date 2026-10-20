import { request } from 'node:http';
import { expect } from 'vitest';
import type { Environment } from '../lib/credentials.js';
import { OAuthError } from '../lib/oauth.js';
import type { OAuthSession, OAuthStore } from '../lib/oauthStore.js';

/** The fake clock the OAuth tests run at. */
export const NOW = 1_700_000_000_000;

export const ISSUER = 'https://staging.kizen.com';

/**
 * Deliberately not the conventional /oauth2/token path, so a passing test proves
 * the flow used the token endpoint it discovered or stored.
 */
export const TOKEN_ENDPOINT = `${ISSUER}/discovered/token`;

/** A stored staging session, fresh for an hour at `NOW`; pass the fields a test cares about. */
export const oauthSession = (overrides: Partial<OAuthSession> = {}): OAuthSession => ({
  environment: 'staging',
  loginId: 'login-a',
  issuer: ISSUER,
  clientId: 'client-1',
  tokenEndpoint: TOKEN_ENDPOINT,
  accessToken: 'access-0',
  refreshToken: 'refresh-0',
  expiresAt: NOW + 3600 * 1000,
  scope: 'read write offline_access',
  ...overrides,
});

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** What `promise` rejects with, asserted to be an `ErrorClass` (an OAuthError by default). */
export async function rejectionOf(promise: Promise<unknown>): Promise<OAuthError>;
export async function rejectionOf<E>(
  promise: Promise<unknown>,
  ErrorClass: abstract new (...args: never[]) => E,
): Promise<E>;
export async function rejectionOf(
  promise: Promise<unknown>,
  ErrorClass: abstract new (...args: never[]) => unknown = OAuthError,
): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );

  expect(error).toBeInstanceOf(ErrorClass);

  return error;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A promise and the function that resolves it. */
export const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

/** A fetch response that never arrives; only the request's abort signal ends it. */
export const hangUntilAbort = (init?: RequestInit): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason as Error);
    });
  });

/** Whether `environment`'s session lock can be taken right now (released again if so). */
export const lockIsFree = async (store: OAuthStore, environment: Environment): Promise<boolean> => {
  try {
    await (
      await store.acquireLock(environment, { retryMs: 1, waitMs: 0 })
    )();

    return true;
  } catch {
    return false;
  }
};

/** GETs a loopback URL with node:http (no proxy), resolving with the status and body. */
export const httpGet = (url: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    request(url, { agent: false }, (res) => {
      let body = '';

      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    })
      .on('error', reject)
      .end();
  });

export interface PausingStore {
  store: OAuthStore;
  /** Resolves once the first lock is taken; the caller is then paused, holding it. */
  holding: Promise<void>;
  /** Lets the paused caller go on. */
  resume: () => void;
  /** Resolves once the caller mutates (`action`) or goes back for the lock: either way it has acted. */
  acted: Promise<void>;
  lockCalls: () => number;
}

/**
 * `store`, but the first `acquireLock` pauses between taking the lock and
 * returning it until `resume()`, and `acted` signals the paused caller's next
 * step: its `action` or another `acquireLock`.
 */
export const pausingStore = (
  store: OAuthStore,
  action: 'writeSession' | 'deleteSession',
): PausingStore => {
  const holding = deferred();
  const resume = deferred();
  const acted = deferred();
  let lockCalls = 0;
  const paused: OAuthStore = {
    ...store,
    acquireLock: async (environment, options) => {
      // Read before awaiting, so an overlapping second caller can't move the pause off call 1.
      const call = ++lockCalls;

      if (call > 1) {
        acted.resolve();
      }

      const lock = await store.acquireLock(environment, options);

      if (call === 1) {
        holding.resolve();
        await resume.promise;
      }

      return lock;
    },
  };

  if (action === 'writeSession') {
    paused.writeSession = (session) => {
      acted.resolve();

      return store.writeSession(session);
    };
  } else {
    paused.deleteSession = (environment) => {
      acted.resolve();

      return store.deleteSession(environment);
    };
  }

  return {
    store: paused,
    holding: holding.promise,
    resume: () => {
      resume.resolve();
    },
    acted: acted.promise,
    lockCalls: () => lockCalls,
  };
};
