/**
 * Network + crypto helpers for the `encrypt` command, shared between the ink UI
 * and any non-interactive callers. Keeping these out of the React tree means the
 * dev/prod routing and envelope handling live in one testable place. KZN-16467.
 *
 * Both modes talk to the encryption API (plugin-wizard) DIRECTLY via
 * `resolveWizardBase(stage)` — the app-builder dev server is never involved, so
 * `appbuilder encrypt` works without `appbuilder dev` running:
 *   - on-machine (default): fetch the public key, then encrypt in-process.
 *   - remote (`--remote`): POST the plaintext to the wizard's /encrypt endpoint
 *     and let it do the crypto with the keypair it already holds.
 */
import { encrypt, serializeEnvelope } from '@kizenapps/packager';
import type { Credentials } from './credentials.js';
import { resolveWizardBase } from './wizardUrl.js';

export interface EncryptionContext {
  /**
   * When true, the wizard's /encrypt endpoint performs the encryption; otherwise
   * we fetch the public key and encrypt on-machine. Either way the request goes
   * straight to the wizard host — never through the app-builder dev server.
   */
  isRemote: boolean;
  /** Which encryption API to target. */
  stage: 'dev' | 'prod';
}

/** Phases reported while encrypting, so a UI can show progress. */
export type EncryptPhase = 'fetching-key' | 'encrypting';

/**
 * Node's fetch (undici) wraps socket failures in a generic `TypeError: fetch
 * failed`, stashing the real error (with its `code`) on `.cause`. Look in both
 * places so we can surface a friendlier "not running" message.
 */
function isConnRefused(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };

  return e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED';
}

/**
 * The auth headers every wizard endpoint requires: x-api-key, x-user-id,
 * x-business-id, and x-auth-environment.
 */
function authHeaders(credentials: Credentials): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': credentials.apiKey,
    'x-user-id': credentials.userId,
    'x-business-id': credentials.businessId,
    'x-auth-environment': credentials.environment,
  };
}

/** Wraps a fetch to the wizard so connection failures read clearly. */
async function wizardFetch(wizardBase: string, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${wizardBase}${path}`, init);
  } catch (err) {
    throw new Error(
      isConnRefused(err)
        ? `Plugin-wizard is not running at ${wizardBase}`
        : `Failed to reach plugin-wizard: ${(err as Error).message}`,
    );
  }
}

/**
 * Parses a wizard JSON response without throwing on a non-JSON body. Upstream
 * errors can arrive as HTML 502 pages, plain-text 429s, or an auth 401 raised
 * before the JSON handler runs — calling res.json() on those would throw an
 * opaque SyntaxError and hide the real status. Returning {} lets callers fall
 * back to a clear HTTP-status error.
 */
async function readJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();

  if (text === '') {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Fetches the public key for a plugin directly from the wizard host. Used by the
 * on-machine encryption path.
 */
export async function fetchPublicKey(
  ctx: EncryptionContext,
  credentials: Credentials,
  apiName: string,
): Promise<string> {
  const wizardBase = resolveWizardBase(ctx.stage);
  const res = await wizardFetch(wizardBase, '/get-public-key', {
    method: 'POST',
    headers: authHeaders(credentials),
    body: JSON.stringify({ api_name: apiName }),
  });

  const data = await readJsonSafe(res);

  if (!res.ok || typeof data.public_key !== 'string') {
    const errMsg = typeof data.error === 'string' ? data.error : `HTTP ${String(res.status)}`;

    throw new Error(`Failed to fetch public key: ${errMsg}`);
  }

  return data.public_key;
}

/** Encrypts a value in-process via @kizenapps/packager and returns the
 * serialized envelope's base64 `value`. */
function encryptLocally(publicKeyPem: string, value: string): string {
  const envelope = encrypt(value, publicKeyPem);
  const serialized = serializeEnvelope(envelope) as { encrypted?: boolean; value?: unknown };

  if (typeof serialized.value !== 'string') {
    throw new Error('Unexpected serialized envelope shape from @kizenapps/packager');
  }

  return serialized.value;
}

/**
 * Asks the wizard's /encrypt endpoint to encrypt the value with the keypair it
 * holds for `apiName`, returning the serialized envelope's base64 `value`. The
 * wizard fetches its own public key, so no separate get-public-key call is made.
 */
async function encryptRemote(
  ctx: EncryptionContext,
  credentials: Credentials,
  apiName: string,
  value: string,
): Promise<string> {
  const wizardBase = resolveWizardBase(ctx.stage);
  const res = await wizardFetch(wizardBase, '/encrypt', {
    method: 'POST',
    headers: authHeaders(credentials),
    body: JSON.stringify({ api_name: apiName, value }),
  });

  const data = await readJsonSafe(res);

  if (!res.ok || data.encrypted !== true || typeof data.value !== 'string') {
    const errMsg = typeof data.error === 'string' ? data.error : `HTTP ${String(res.status)}`;

    throw new Error(`Encryption via plugin-wizard failed: ${errMsg}`);
  }

  return data.value;
}

export async function encryptSecret(
  ctx: EncryptionContext,
  credentials: Credentials,
  apiName: string,
  value: string,
  onPhase?: (phase: EncryptPhase) => void,
): Promise<string> {
  if (ctx.isRemote) {
    onPhase?.('encrypting');

    return encryptRemote(ctx, credentials, apiName, value);
  }

  onPhase?.('fetching-key');

  const publicKey = await fetchPublicKey(ctx, credentials, apiName);

  onPhase?.('encrypting');

  return encryptLocally(publicKey, value);
}
