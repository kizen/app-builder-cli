import { request } from 'node:http';
import { expect } from 'vitest';
import { OAuthError } from '../lib/oauth.js';
import type { OAuthAccount, OAuthSession, OAuthStore } from '../lib/oauthStore.js';

/** The fake clock the OAuth tests run at. */
export const NOW = 1_700_000_000_000;

export const ISSUER = 'https://staging.kizen.com';

/**
 * Deliberately not the conventional /oauth2/token path, so a passing test proves
 * the flow used the token endpoint it discovered or stored.
 */
export const TOKEN_ENDPOINT = `${ISSUER}/discovered/token`;

/** Two accounts: different businesses, different users. */
export const ACCOUNT_A: OAuthAccount = { businessId: 'biz-a', userId: 'user-a' };
export const ACCOUNT_B: OAuthAccount = { businessId: 'biz-b', userId: 'user-b' };

/** `{ businessId, userId }` of a session, as the store's pointer holds it. */
export const accountOf = ({ businessId, userId }: OAuthAccount): OAuthAccount => ({
  businessId,
  userId,
});

/** A stored staging session for account A, fresh for an hour at `NOW`; override what a test needs. */
export const oauthSession = (overrides: Partial<OAuthSession> = {}): OAuthSession => ({
  environment: 'staging',
  ...ACCOUNT_A,
  businessName: 'Acme A',
  fullName: 'Ada A',
  email: 'ada@a.test',
  issuer: ISSUER,
  clientId: 'client-1',
  tokenEndpoint: TOKEN_ENDPOINT,
  accessToken: 'access-0',
  refreshToken: 'refresh-0',
  expiresAt: NOW + 3600 * 1000,
  scope: 'read write offline_access',
  ...overrides,
});

/** Stores `session` and makes its account current for its environment, as `login` does. */
export const signIn = async (store: OAuthStore, session: OAuthSession): Promise<void> => {
  await store.writeSession(session);
  await store.setCurrent(session.environment, accountOf(session));
};

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

export interface HeldStore {
  store: OAuthStore;
  /** Resolves when the held method is first called, before it has done anything. */
  reached: Promise<void>;
  /** Lets every held call go ahead. */
  release: () => void;
}

/**
 * `store` with `method` held: a call waits for `release()` before it runs, so a test can land a
 * logout or a switch to another account between a refresh's last check and its mutation.
 */
export const holdingStore = (
  store: OAuthStore,
  method: 'writeSession' | 'deleteSession',
): HeldStore => {
  const reached = deferred();
  const released = deferred();
  const hold = async (): Promise<void> => {
    reached.resolve();
    await released.promise;
  };

  return {
    store:
      method === 'writeSession'
        ? {
            ...store,
            writeSession: async (session) => {
              await hold();
              await store.writeSession(session);
            },
          }
        : {
            ...store,
            deleteSession: async (environment, account) => {
              await hold();

              return store.deleteSession(environment, account);
            },
          },
    reached: reached.promise,
    release: () => {
      released.resolve();
    },
  };
};
