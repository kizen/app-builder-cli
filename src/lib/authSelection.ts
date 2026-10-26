/**
 * How a command authenticates. The `appbuilder login` session is the default; an
 * API key (deprecated) is used only when `-c <path>` or `--profile <name>` asks for it.
 * Pure: it reads no files and no sessions, so every command can share it.
 */

import { quoteArg } from './shellArg.js';

/** `--business` / `--user`: a saved account to use instead of the current one. */
export interface AccountFlags {
  business?: string;
  user?: string;
}

export interface AuthFlags extends AccountFlags {
  credentials?: string;
  profile?: string;
  env?: string;
}

/** The environment variables that name a saved account when the flags don't. */
export const BUSINESS_ENV = 'APPBUILDER_BUSINESS';
export const USER_ENV = 'APPBUILDER_USER';

/**
 * A saved account a command names, by business id or name and optionally user id. `source` says
 * where it came from, so an error can name what to change.
 */
export interface AccountRequest {
  business: string;
  user?: string | undefined;
  source?: 'flags' | 'env' | undefined;
}

export type AccountRequestResult =
  | { ok: true; request: AccountRequest | undefined }
  | { ok: false; message: string };

/**
 * The saved account a command names: `--business` (and `--user`), else `APPBUILDER_BUSINESS`
 * (and `APPBUILDER_USER`), else undefined for the current account. The flags replace the
 * variables as a pair, and a user id without a business is a usage error. An empty variable
 * counts as unset.
 */
export function accountRequest(
  flags: AccountFlags,
  processEnv: Readonly<Record<string, string | undefined>>,
): AccountRequestResult {
  if (flags.business !== undefined) {
    return { ok: true, request: { business: flags.business, user: flags.user, source: 'flags' } };
  }

  if (flags.user !== undefined) {
    return { ok: false, message: '--user only applies with --business.' };
  }

  const business = processEnv[BUSINESS_ENV] || undefined;
  const user = processEnv[USER_ENV] || undefined;

  if (business === undefined) {
    return user === undefined
      ? { ok: true, request: undefined }
      : { ok: false, message: `${USER_ENV} only applies with ${BUSINESS_ENV}.` };
  }

  return { ok: true, request: { business, user, source: 'env' } };
}

export type AuthSelection =
  /** Exactly one of the two is set; `-c` wins when both were passed. */
  | { kind: 'api-key'; credentials: string; profile?: never }
  | { kind: 'api-key'; profile: string; credentials?: never }
  /** `account` names a saved account; without it, the current one. */
  | { kind: 'oauth'; env?: string; account?: AccountRequest };

/** `ok: false` is a usage error. */
export type AuthSelectionResult =
  | { ok: true; selection: AuthSelection }
  | { ok: false; message: string };

const API_KEY_FLAGS_HINT =
  'To use an API key instead (deprecated), pass --profile <name> or -c <path>.';

/**
 * `processEnv` supplies `APPBUILDER_BUSINESS` / `APPBUILDER_USER` for the sign-in session; an API
 * key ignores them.
 */
export function selectAuth(
  flags: AuthFlags,
  processEnv: Readonly<Record<string, string | undefined>>,
): AuthSelectionResult {
  const apiKey = flags.credentials !== undefined || flags.profile !== undefined;

  if (apiKey && flags.env !== undefined) {
    return {
      ok: false,
      message: "--env selects a sign-in session, so it can't be combined with -c or --profile.",
    };
  }

  if (apiKey && (flags.business !== undefined || flags.user !== undefined)) {
    return {
      ok: false,
      message: `${flags.business === undefined ? '--user' : '--business'} selects a saved sign-in account, so it can't be combined with -c or --profile.`,
    };
  }

  if (flags.credentials !== undefined) {
    return { ok: true, selection: { kind: 'api-key', credentials: flags.credentials } };
  }

  if (flags.profile !== undefined) {
    return { ok: true, selection: { kind: 'api-key', profile: flags.profile } };
  }

  const account = accountRequest(flags, processEnv);

  if (!account.ok) {
    return account;
  }

  return {
    ok: true,
    selection: {
      kind: 'oauth',
      ...(flags.env !== undefined && { env: flags.env }),
      ...(account.request !== undefined && { account: account.request }),
    },
  };
}

/**
 * The notice for a `.kizenapp/config.json` profile pin, which no longer opts into API keys. The
 * profile comes from the repo, so a name with control characters is only shown JSON-escaped.
 */
export const pinnedProfileNotice = (profile: string): string =>
  `Ignoring the API-key profile ${JSON.stringify(profile)} pinned in .kizenapp/config.json and using your sign-in session.${/[\x00-\x1f\x7f]/.test(profile) ? '' : ` Pass --profile ${quoteArg(profile)} to use the API key.`}`;

export const notSignedInWithApiKeyHint = (notSignedInMessage: string): string =>
  `${notSignedInMessage} ${API_KEY_FLAGS_HINT}`;
