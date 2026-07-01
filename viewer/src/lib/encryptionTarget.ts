// The encryption target selects which environment's keypair a plugin secret is
// bound to (dev ⇒ only dev can decrypt, prod ⇒ only prod can decrypt).
//
// We default to 'prod': in practice almost every plugin ships to production, so
// prod is the right default. A developer working locally can switch to 'dev' and
// the choice is persisted per project. (KZN-16467; the old
// release_environments-based auto-detection was dropped — it guessed 'dev' for
// most plugins, which was wrong far more often than right.)
export type EncryptionTargetSetting = 'dev' | 'prod';

/** The target used when the user hasn't explicitly chosen one. */
export const DEFAULT_ENCRYPTION_TARGET: EncryptionTargetSetting = 'prod';
