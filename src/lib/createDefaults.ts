/**
 * The developer business id and environment `create` writes into a new plugin when the user
 * doesn't pass them. These are only defaults: `create` never authenticates.
 *
 * Signed in (any `appbuilder login` session), they come only from the session and the API-key
 * file is never read. Signed out, they fall back to the API-key `credentials.json`, as before.
 */

import type { Credentials, Environment } from './credentials.js';
import type { HeadlessDefaults } from './createHeadless.js';
import { resolveSessionEnvironment } from './oauthSession.js';

export interface CreateDefaultsDeps {
  /** Environments with a sign-in session. */
  listSessions: () => Promise<Environment[]>;
  /** The environment's current session; may throw for an unreadable one. */
  readSession: (environment: Environment) => Promise<{ businessId: string } | null>;
  loadGlobalCredentials: () => Promise<Credentials | null>;
  /**
   * The raw `-e, --environment` value, trimmed and blank meaning absent as createHeadless reads it.
   * Signed in, an invalid one (or several sessions and no -e) defaults to go; createHeadless
   * rejects an invalid one.
   */
  requestedEnvironment?: string;
}

export async function resolveCreateDefaults(deps: CreateDefaultsDeps): Promise<HeadlessDefaults> {
  const signedIn = await deps.listSessions().catch((): Environment[] => []);

  if (signedIn.length === 0) {
    const globalCreds = await deps.loadGlobalCredentials();

    return {
      businessId: globalCreds?.businessId ?? '',
      environment: globalCreds?.environment ?? 'go',
    };
  }

  const resolved = await resolveSessionEnvironment(
    deps.requestedEnvironment?.trim() || undefined,
    () => Promise.resolve(signedIn),
  );
  const environment = resolved.ok ? resolved.environment : 'go';

  const session = await deps.readSession(environment).catch(() => null);

  return { businessId: session?.businessId ?? '', environment };
}
