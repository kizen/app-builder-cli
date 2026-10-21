/**
 * The developer business id and environment `create` writes into a new plugin when the user
 * doesn't pass them. These are only defaults: `create` never authenticates.
 *
 * Signed in (any `appbuilder login` session), they come only from the session and the API-key
 * file is never read. Signed out, they fall back to the API-key `credentials.json`, as before.
 */

import { isEnvironment, type Credentials, type Environment } from './credentials.js';
import type { HeadlessDefaults } from './createHeadless.js';

export interface CreateDefaultsDeps {
  /** Environments with a sign-in session. */
  listSessions: () => Promise<Environment[]>;
  /** The environment's current session; may throw for an unreadable one. */
  readSession: (environment: Environment) => Promise<{ businessId: string } | null>;
  loadGlobalCredentials: () => Promise<Credentials | null>;
  /** The raw `-e, --environment` value. An invalid one is ignored here; createHeadless rejects it. */
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

  const requested = deps.requestedEnvironment?.trim();
  const environment: Environment = isEnvironment(requested)
    ? requested
    : ((signedIn.length === 1 ? signedIn[0] : undefined) ?? 'go');

  const session = await deps.readSession(environment).catch(() => null);

  return { businessId: session?.businessId ?? '', environment };
}
