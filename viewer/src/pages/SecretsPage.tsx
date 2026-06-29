import { useParams } from '@tanstack/react-router';
import { useEffect, useState, type FC } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faCopy,
  faDownload,
  faKey,
  faLock,
  faSpinner,
  faTriangleExclamation,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { useQuery } from '@tanstack/react-query';
import { Card } from '../components/Card.js';
import { useCredentials } from '../CredentialsContext.js';
import { bootstrapQueryOptions } from '../bootstrapQuery.js';
import { useLocalStorage } from '../hooks/useLocalStorage.js';
import {
  DEFAULT_ENCRYPTION_TARGET,
  type EncryptionTargetSetting,
} from '../lib/encryptionTarget.js';

// Where the encryption runs, mirroring the `encrypt` CLI's --remote flag and the
// code step runner's Local/Remote toggle:
//   - 'local'  → the dev server encrypts in-process (/api/local/encrypt) using the
//                public key fetched below.
//   - 'remote' → the plugin-wizard's /encrypt endpoint does the crypto with the
//                keypair it holds (no public key needed client-side).
type EncryptionMode = 'local' | 'remote';

// ── Types (mirror the /api/local/validate response shape) ─────────────────────

interface CheckResult {
  label: string;
  expected: string;
  actual: string;
  pass: boolean;
}

interface ValidationResult {
  valid: boolean;
  checks: CheckResult[];
  error?: string;
}

// ── localStorage helpers ───────────────────────────────────────────────────────

function pkStorageKey(apiName: string, environment: string, target: string): string {
  return `secrets-pk::${apiName}::${environment}::${target}`;
}

function loadStoredKey(apiName: string, environment: string, target: string): string | null {
  try {
    return localStorage.getItem(pkStorageKey(apiName, environment, target));
  } catch {
    return null;
  }
}

function saveStoredKey(apiName: string, environment: string, target: string, pem: string): void {
  try {
    localStorage.setItem(pkStorageKey(apiName, environment, target), pem);
  } catch {
    // Ignore storage failures (private browsing, quota exceeded, etc.)
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export const SecretsPage: FC = () => {
  const { apiName } = useParams({ from: '/$apiName/secrets' });
  const credentials = useCredentials();
  const { apiKey, userId, businessId, environment } = credentials;

  // Encryption routing — defaults to 'prod' (almost every plugin ships to
  // production); the user can switch to 'dev' and we persist the choice per
  // project. The setting maps 1:1 to the dev/prod target. (KZN-16467)
  const [encryptionTarget, setEncryptionTarget] = useState<EncryptionTargetSetting>(
    DEFAULT_ENCRYPTION_TARGET,
  );
  const [encryptionSettingLoaded, setEncryptionSettingLoaded] = useState(false);

  // Local (in-process) vs remote (plugin-wizard API) encryption. Persisted across
  // sessions like the code step runner's mode toggle.
  const [encryptionMode, setEncryptionMode] = useLocalStorage<EncryptionMode>(
    'kizen-encryption-mode',
    'local',
  );

  // Public key — persisted in localStorage (namespaced by env + target),
  // collapsed once loaded. Loaded via effect since the target resolves async.
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [pkCollapsed, setPkCollapsed] = useState<boolean>(false);
  const [pkLoading, setPkLoading] = useState(false);
  const [pkError, setPkError] = useState<string | null>(null);
  const [pkCopied, setPkCopied] = useState(false);

  // Encrypt
  const [secretValue, setSecretValue] = useState('');
  const [encryptedValue, setEncryptedValue] = useState<string | null>(null);
  const [encryptError, setEncryptError] = useState<string | null>(null);
  const [encryptLoading, setEncryptLoading] = useState(false);
  const [encryptCopied, setEncryptCopied] = useState(false);

  // Validator
  const [validateInput, setValidateInput] = useState('');
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [validateLoading, setValidateLoading] = useState(false);
  const [validateHasWhitespace, setValidateHasWhitespace] = useState(false);

  const hasCredentials = Boolean(apiKey && userId && businessId);

  const { isError: isBootstrapError, isLoading: isBootstrapLoading } = useQuery(
    bootstrapQueryOptions(credentials),
  );

  // Load the saved per-project override once on mount.
  useEffect(() => {
    let cancelled = false;

    void fetch('/api/encryption-target')
      .then((res) => res.json() as Promise<{ target?: string }>)
      .then((data) => {
        // Only 'dev'/'prod' are valid now; anything else (incl. a legacy 'auto'
        // from before the heuristic was dropped) keeps the 'prod' default.
        if (!cancelled && (data.target === 'dev' || data.target === 'prod')) {
          setEncryptionTarget(data.target);
        }
      })
      .catch(() => {
        // Keep the default ('prod') if the setting can't be read.
      })
      .finally(() => {
        if (!cancelled) {
          setEncryptionSettingLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Show the cached public key for the current (apiName, environment, target)
  // namespace. Re-runs when the target changes so dev/prod keys never bleed.
  // Wait until the saved override has resolved so the target is final —
  // otherwise we'd briefly load the wrong namespace's key.
  useEffect(() => {
    if (!encryptionSettingLoaded) {
      return;
    }

    const stored = loadStoredKey(apiName, environment, encryptionTarget);

    setPublicKey(stored);
    setPkCollapsed(stored !== null);
  }, [apiName, environment, encryptionTarget, encryptionSettingLoaded]);

  // Drop any prior encrypt result/error. Used when the mode or target changes so
  // a stale envelope (encrypted under different settings) can't be mistaken for a
  // fresh one — they're visually indistinguishable in the output textarea.
  const clearEncryptResult = (): void => {
    setEncryptedValue(null);
    setEncryptError(null);
  };

  const handleModeChange = (next: EncryptionMode): void => {
    setEncryptionMode(next);
    clearEncryptResult();
  };

  const handleTargetChange = (next: EncryptionTargetSetting): void => {
    setEncryptionTarget(next);
    clearEncryptResult();

    void fetch('/api/encryption-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: next }),
    }).catch(() => {
      // Non-fatal: the selection still applies for this session.
    });
  };

  const handleGetPublicKey = async (): Promise<void> => {
    setPkLoading(true);
    setPkError(null);
    setPublicKey(null);

    try {
      const res = await fetch('/api/wizard/get-public-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-user-id': userId,
          'x-business-id': businessId,
          'x-encryption-target': encryptionTarget,
          'x-auth-environment': environment,
        },
        body: JSON.stringify({ api_name: apiName }),
      });

      const data = (await res.json()) as Record<string, unknown>;

      if (res.ok && typeof data.public_key === 'string') {
        setPublicKey(data.public_key);
        saveStoredKey(apiName, environment, encryptionTarget, data.public_key);
        setPkCollapsed(true);
      } else {
        setPkError(
          typeof data.error === 'string'
            ? data.error
            : `Unexpected response (${String(res.status)})`,
        );
      }
    } catch (err) {
      setPkError((err as Error).message);
    } finally {
      setPkLoading(false);
    }
  };

  const handleEncrypt = async (): Promise<void> => {
    // Until the saved override resolves, encryptionTarget is the 'prod' default —
    // encrypting now could bind a secret to prod keys when the user had saved a
    // 'dev' override. Wait for it, like the public-key effect does.
    if (!encryptionSettingLoaded) {
      return;
    }

    // Local mode encrypts in-process with the fetched public key, so it requires
    // one; remote mode delegates to the wizard and needs only the api_name.
    if (!secretValue.trim() || (encryptionMode === 'local' && !publicKey)) {
      return;
    }

    setEncryptLoading(true);
    setEncryptError(null);
    setEncryptedValue(null);

    try {
      // Remote: the wizard's /encrypt (via the dev-server proxy) does the crypto
      // with the keypair for `apiName`, selected by x-encryption-target.
      // Local: the dev server encrypts in-process using publicKeyPem.
      const res =
        encryptionMode === 'remote'
          ? await fetch('/api/wizard/encrypt', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'x-user-id': userId,
                'x-business-id': businessId,
                'x-encryption-target': encryptionTarget,
                'x-auth-environment': environment,
              },
              body: JSON.stringify({ api_name: apiName, value: secretValue }),
            })
          : await fetch('/api/local/encrypt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ publicKeyPem: publicKey, value: secretValue }),
            });

      const data = (await res.json()) as Record<string, unknown>;

      if (res.ok && data.encrypted === true && typeof data.value === 'string') {
        setEncryptedValue(JSON.stringify({ encrypted: true, value: data.value }, null, 2));
      } else {
        setEncryptError(
          typeof data.error === 'string'
            ? data.error
            : `Unexpected response (${String(res.status)})`,
        );
      }
    } catch (err) {
      setEncryptError((err as Error).message);
    } finally {
      setEncryptLoading(false);
    }
  };

  const handleStripWhitespace = (): void => {
    // Collapse all whitespace runs. If the result is valid JSON, re-pretty-print
    // it so the textarea stays readable; otherwise just use the collapsed string.
    const collapsed = validateInput.replace(/\s+/g, '');

    try {
      const parsed = JSON.parse(collapsed) as Record<string, unknown>;

      setValidateInput(JSON.stringify(parsed, null, 2));
    } catch {
      setValidateInput(collapsed);
    }

    setValidateHasWhitespace(false);
    setValidationResult(null);
  };

  const handleValidate = async (): Promise<void> => {
    if (!validateInput.trim()) {
      return;
    }

    setValidateLoading(true);
    setValidationResult(null);

    // Accept either the full { encrypted: true, value: "..." } JSON
    // or the raw base64 value string directly.
    let raw = validateInput.trim();

    try {
      const outer = JSON.parse(raw) as Record<string, unknown>;

      if (typeof outer.value === 'string') {
        raw = outer.value;
      }
    } catch {
      // Not JSON — treat as raw base64.
    }

    try {
      const res = await fetch('/api/local/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: raw }),
      });

      const data = (await res.json()) as ValidationResult;

      setValidationResult(data);
    } catch (err) {
      setValidationResult({ valid: false, checks: [], error: (err as Error).message });
    } finally {
      setValidateLoading(false);
    }
  };

  const handleCopyPublicKey = (): void => {
    if (!publicKey) {
      return;
    }

    void navigator.clipboard.writeText(publicKey).then(() => {
      setPkCopied(true);
      setTimeout(() => {
        setPkCopied(false);
      }, 2000);
    });
  };

  const handleDownloadPublicKey = (): void => {
    if (!publicKey) {
      return;
    }

    const blob = new Blob([publicKey], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = `${apiName}-${environment}-${encryptionTarget}-public-key.pem`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyEncrypted = (): void => {
    if (!encryptedValue) {
      return;
    }

    void navigator.clipboard.writeText(encryptedValue).then(() => {
      setEncryptCopied(true);
      setTimeout(() => {
        setEncryptCopied(false);
      }, 2000);
    });
  };

  // ── Guard states ─────────────────────────────────────────────────────────────

  if (!hasCredentials) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <FontAwesomeIcon icon={faLock} className="text-[22px] text-neutral-300" />
          <div>
            <p className="text-[13px] font-medium text-neutral-500">No credentials configured</p>
            <p className="mt-1 text-[12px] text-neutral-400">
              A credential profile with a valid API key, user ID, and business ID is required to use
              this page. Set one up in{' '}
              <code className="rounded bg-neutral-100 px-1 py-0.5 text-[11px]">
                ~/.kizenappbuilder/credentials.json
              </code>{' '}
              and restart the server.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (isBootstrapLoading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-8">
          <FontAwesomeIcon icon={faSpinner} className="animate-spin text-[20px] text-neutral-300" />
        </div>
      </Card>
    );
  }

  if (isBootstrapError) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <FontAwesomeIcon icon={faTriangleExclamation} className="text-[22px] text-amber-400" />
          <div>
            <p className="text-[13px] font-medium text-neutral-500">Authentication failed</p>
            <p className="mt-1 text-[12px] text-neutral-400">
              Your credentials were rejected. Please enter valid credentials and refresh.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  // ── Main content ──────────────────────────────────────────────────────────────

  return (
    <Card>
      {/* ── Encryption controls ────────────────────────────────────────────── */}
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <span className="block text-[12px] font-medium text-neutral-600">Encryption</span>
          <p className="mt-0.5 text-[11px] text-neutral-400">
            Where encryption runs, and which environment&apos;s keys secrets are encrypted against.
          </p>
        </div>
        <div className="flex shrink-0 items-end gap-3">
          <div role="group" aria-label="Encryption mode">
            <span className="mb-1 block text-[11px] font-medium text-neutral-500">Mode</span>
            <div className="flex overflow-hidden rounded-lg border border-black/10 text-[12px] font-medium">
              {(['local', 'remote'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={encryptionMode === mode}
                  onClick={() => {
                    handleModeChange(mode);
                  }}
                  className={`px-2.5 py-1.5 transition-colors ${
                    encryptionMode === mode
                      ? 'bg-neutral-700 text-white'
                      : 'bg-white text-neutral-500 hover:bg-neutral-100'
                  }`}
                >
                  {mode === 'local' ? 'Local' : 'Remote'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label
              htmlFor="enc-target"
              className="mb-1 block text-[11px] font-medium text-neutral-500"
            >
              Keys
            </label>
            <select
              id="enc-target"
              value={encryptionTarget}
              onChange={(e) => {
                handleTargetChange(e.target.value as EncryptionTargetSetting);
              }}
              className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-[12px] text-neutral-700 outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="prod">Prod</option>
              <option value="dev">Dev</option>
            </select>
          </div>
        </div>
      </div>

      {encryptionTarget === 'dev' && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-700">
          <FontAwesomeIcon icon={faTriangleExclamation} className="shrink-0 text-[11px]" />
          <span>
            <strong className="font-semibold">Dev keys selected.</strong> Be sure you know what
            you&apos;re doing — most apps use the production encryption service. Secrets encrypted
            with dev keys won&apos;t decrypt in production.
          </span>
        </div>
      )}

      <hr className="mb-6 border-black/8" />

      {/* ── Section 1: Public Key — local mode only; remote needs no client-side key ── */}
      {encryptionMode === 'local' && (
        <>
          {publicKey !== null && pkCollapsed ? (
            // Collapsed summary row
            <div className="flex items-center justify-between rounded-lg border border-black/8 bg-neutral-50 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faCheck} className="text-[11px] text-green-600" />
                <span className="text-[12px] font-medium text-neutral-700">Public key loaded</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setPkCollapsed(false);
                  }}
                  className="rounded px-2 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50"
                >
                  Show
                </button>
                <span className="text-neutral-300">·</span>
                <button
                  type="button"
                  onClick={() => {
                    void handleGetPublicKey();
                  }}
                  disabled={pkLoading}
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
                >
                  {pkLoading && (
                    <FontAwesomeIcon icon={faSpinner} className="animate-spin text-[10px]" />
                  )}
                  Refresh
                </button>
              </div>
            </div>
          ) : (
            // Expanded section
            <>
              <div className="mb-5">
                <div className="flex items-center justify-between">
                  <h2 className="text-[15px] font-semibold text-neutral-900">Public Key</h2>
                  {publicKey !== null && (
                    <button
                      type="button"
                      onClick={() => {
                        setPkCollapsed(true);
                      }}
                      className="text-[11px] font-medium text-neutral-400 hover:text-neutral-600"
                    >
                      Collapse
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[12px] text-neutral-400">
                  Fetch the public key for{' '}
                  <code className="rounded bg-neutral-100 px-1 py-0.5 text-[11px]">{apiName}</code>.
                  Required for encryption below.
                </p>
              </div>

              <div className="flex flex-col gap-4">
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-neutral-600">
                    Plugin
                  </label>
                  <div className="rounded-lg border border-black/10 bg-neutral-50 px-3 py-2 text-[13px] text-neutral-500">
                    {apiName}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    void handleGetPublicKey();
                  }}
                  disabled={pkLoading}
                  className="flex items-center justify-center gap-2 rounded-lg bg-neutral-700 px-4 py-2 text-[13px] font-medium text-white hover:bg-neutral-800 active:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pkLoading && (
                    <FontAwesomeIcon icon={faSpinner} className="animate-spin text-[12px]" />
                  )}
                  {pkLoading ? 'Fetching…' : publicKey !== null ? 'Refresh Key' : 'Get Public Key'}
                </button>

                {pkError !== null && (
                  <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600">
                    {pkError}
                  </p>
                )}

                {publicKey !== null && (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="text-[12px] font-medium text-neutral-600">
                        Public key (PEM)
                      </label>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={handleCopyPublicKey}
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50"
                        >
                          <FontAwesomeIcon icon={faCopy} className="text-[10px]" />
                          {pkCopied ? 'Copied!' : 'Copy'}
                        </button>
                        <button
                          type="button"
                          onClick={handleDownloadPublicKey}
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50"
                        >
                          <FontAwesomeIcon icon={faDownload} className="text-[10px]" />
                          Download
                        </button>
                      </div>
                    </div>
                    <textarea
                      readOnly
                      value={publicKey}
                      rows={5}
                      className="w-full rounded-lg border border-black/10 bg-neutral-50 px-3 py-2 font-mono text-[11px] text-neutral-600 outline-none"
                    />
                  </div>
                )}
              </div>
            </>
          )}

          <hr className="my-6 border-black/8" />
        </>
      )}

      {/* ── Section 2: Encrypt a Secret ───────────────────────────────────── */}
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-neutral-900">Encrypt a Secret</h2>
        <p className="mt-1 text-[12px] text-neutral-400">
          {encryptionMode === 'remote'
            ? 'Encrypts a secret via the remote plugin-wizard API. '
            : 'Encrypts a secret in-process using the public key. '}
          Output is ready to paste into{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-[11px]">kizen.json</code>.
        </p>
      </div>

      {encryptionMode === 'local' && publicKey === null ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-700">
          <FontAwesomeIcon icon={faKey} className="shrink-0 text-[11px]" />
          Fetch the public key above first, or switch to Remote mode.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="secret-value"
              className="mb-1 block text-[12px] font-medium text-neutral-600"
            >
              Secret value
            </label>
            <input
              id="secret-value"
              type="password"
              value={secretValue}
              onChange={(e) => {
                setSecretValue(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleEncrypt();
                }
              }}
              placeholder="Enter the plaintext secret…"
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          <button
            type="button"
            onClick={() => {
              void handleEncrypt();
            }}
            disabled={encryptLoading || !secretValue.trim() || !encryptionSettingLoaded}
            className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {encryptLoading && (
              <FontAwesomeIcon icon={faSpinner} className="animate-spin text-[12px]" />
            )}
            {encryptLoading ? 'Encrypting…' : 'Encrypt'}
          </button>

          {encryptError !== null && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600">
              {encryptError}
            </p>
          )}

          {encryptedValue !== null && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[12px] font-medium text-neutral-600">
                  Encrypted envelope
                </label>
                <button
                  type="button"
                  onClick={handleCopyEncrypted}
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50"
                >
                  <FontAwesomeIcon icon={faCopy} className="text-[10px]" />
                  {encryptCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <textarea
                readOnly
                value={encryptedValue}
                rows={5}
                className="w-full rounded-lg border border-black/10 bg-neutral-50 px-3 py-2 font-mono text-[11px] text-neutral-600 outline-none"
              />
            </div>
          )}
        </div>
      )}

      <hr className="my-6 border-black/8" />

      {/* ── Section 3: Validate ────────────────────────────────────────────── */}
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-neutral-900">Validate an Encrypted Value</h2>
        <p className="mt-1 text-[12px] text-neutral-400">
          Paste an encrypted envelope to verify it is well-formed.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <label
            htmlFor="validate-input"
            className="mb-1 block text-[12px] font-medium text-neutral-600"
          >
            Encrypted value
          </label>
          <textarea
            id="validate-input"
            value={validateInput}
            onChange={(e) => {
              const v = e.target.value;

              setValidateInput(v);
              setValidationResult(null);
              // Warn if the base64 portion of the pasted value contains embedded
              // whitespace — a common copy-paste artifact from line-wrapped output
              // that causes JSON.parse to fail with a "bad control character" error.
              // Detect it by checking whether base64 characters appear on both sides
              // of a whitespace run.
              setValidateHasWhitespace(/[A-Za-z0-9+/=]{4,}\s+[A-Za-z0-9+/=]{4,}/.test(v));
            }}
            placeholder={`Paste the { "encrypted": true, "value": "…" } JSON, or just the raw base64 value`}
            rows={4}
            className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-[11px] text-neutral-700 outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>

        {validateHasWhitespace && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
            <span>
              The pasted value contains whitespace inside the base64 string — a common copy-paste
              artifact from line-wrapped output.
            </span>
            <button
              type="button"
              onClick={handleStripWhitespace}
              className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium text-amber-800 underline hover:no-underline"
            >
              Strip whitespace
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            void handleValidate();
          }}
          disabled={validateLoading || !validateInput.trim()}
          className="flex items-center justify-center gap-2 rounded-lg bg-neutral-700 px-4 py-2 text-[13px] font-medium text-white hover:bg-neutral-800 active:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {validateLoading && (
            <FontAwesomeIcon icon={faSpinner} className="animate-spin text-[12px]" />
          )}
          {validateLoading ? 'Validating…' : 'Validate'}
        </button>

        {validationResult !== null && (
          <div
            className={`rounded-lg border px-4 py-3 ${
              validationResult.valid ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
            }`}
          >
            {validationResult.error !== undefined ? (
              <p className="text-[12px] text-red-600">{validationResult.error}</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                <p
                  className={`text-[12px] font-semibold ${
                    validationResult.valid ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {validationResult.valid ? 'All checks passed' : 'Validation failed'}
                </p>
                <div className="flex flex-col gap-1.5">
                  {validationResult.checks.map((check) => (
                    <div key={check.label} className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-1.5">
                        <FontAwesomeIcon
                          icon={check.pass ? faCheck : faXmark}
                          className={`w-3 shrink-0 text-[10px] ${
                            check.pass ? 'text-green-600' : 'text-red-500'
                          }`}
                        />
                        <span className="text-[11px] text-neutral-600">{check.label}</span>
                      </div>
                      <span
                        className={`font-mono text-[11px] ${
                          check.pass ? 'text-neutral-500' : 'text-red-600'
                        }`}
                      >
                        {check.actual}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};
