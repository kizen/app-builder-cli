/**
 * How a command authenticates. The `appbuilder login` session is the default; an
 * API key (deprecated) is used only when `-c <path>` or `--profile <name>` asks for it.
 * Pure: it reads no files and no sessions, so every command can share it.
 */

import { quoteArg } from './shellArg.js';

export interface AuthFlags {
  credentials?: string;
  profile?: string;
  /** Kept for existing scripts; the sign-in session is already the default. */
  oauth?: boolean;
  env?: string;
}

export type AuthSelection =
  /** Exactly one of the two is set; `-c` wins when both were passed. */
  | { kind: 'api-key'; credentials: string; profile?: never }
  | { kind: 'api-key'; profile: string; credentials?: never }
  | { kind: 'oauth'; env?: string };

/** `ok: false` is a usage error. */
export type AuthSelectionResult =
  | { ok: true; selection: AuthSelection }
  | { ok: false; message: string };

const API_KEY_FLAGS_HINT =
  'To use an API key instead (deprecated), pass --profile <name> or -c <path>.';

export function selectAuth(flags: AuthFlags): AuthSelectionResult {
  const apiKey = flags.credentials !== undefined || flags.profile !== undefined;

  if (apiKey && flags.oauth === true) {
    return { ok: false, message: "--oauth can't be combined with -c or --profile." };
  }

  if (apiKey && flags.env !== undefined) {
    return {
      ok: false,
      message: "--env selects a sign-in session, so it can't be combined with -c or --profile.",
    };
  }

  if (flags.credentials !== undefined) {
    return { ok: true, selection: { kind: 'api-key', credentials: flags.credentials } };
  }

  if (flags.profile !== undefined) {
    return { ok: true, selection: { kind: 'api-key', profile: flags.profile } };
  }

  return {
    ok: true,
    selection: flags.env === undefined ? { kind: 'oauth' } : { kind: 'oauth', env: flags.env },
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
