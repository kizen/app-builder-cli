import { useParams } from '@tanstack/react-router';
import { useState, type FC } from 'react';
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

function pkStorageKey(apiName: string, environment: string): string {
  return `secrets-pk::${apiName}::${environment}`;
}

function loadStoredKey(apiName: string, environment: string): string | null {
  try {
    return localStorage.getItem(pkStorageKey(apiName, environment));
  } catch {
    return null;
  }
}

function saveStoredKey(apiName: string, environment: string, pem: string): void {
  try {
    localStorage.setItem(pkStorageKey(apiName, environment), pem);
  } catch {
    // Ignore storage failures (private browsing, quota exceeded, etc.)
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export const SecretsPage: FC = () => {
  const { apiName } = useParams({ from: '/$apiName/secrets' });
  const credentials = useCredentials();
  const { apiKey, userId, businessId, environment } = credentials;

  // Public key — persisted in localStorage, collapsed once loaded
  const [publicKey, setPublicKey] = useState<string | null>(() =>
    loadStoredKey(apiName, environment),
  );
  const [pkCollapsed, setPkCollapsed] = useState<boolean>(
    () => loadStoredKey(apiName, environment) !== null,
  );
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

  const hasCredentials = Boolean(apiKey && userId && businessId);

  const { isError: isBootstrapError, isLoading: isBootstrapLoading } = useQuery(
    bootstrapQueryOptions(credentials),
  );

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
        },
        body: JSON.stringify({ api_name: apiName, environment }),
      });

      const data = (await res.json()) as Record<string, unknown>;

      if (res.ok && typeof data.public_key === 'string') {
        setPublicKey(data.public_key);
        saveStoredKey(apiName, environment, data.public_key);
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
    if (!publicKey || !secretValue.trim()) {
      return;
    }

    setEncryptLoading(true);
    setEncryptError(null);
    setEncryptedValue(null);

    try {
      const res = await fetch('/api/local/encrypt', {
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
    a.download = `${apiName}-${environment}-public-key.pem`;
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
      {/* ── Section 1: Public Key ──────────────────────────────────────────── */}
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
              <label className="mb-1 block text-[12px] font-medium text-neutral-600">Plugin</label>
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

      {/* ── Section 2: Encrypt a Secret ───────────────────────────────────── */}
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-neutral-900">Encrypt a Secret</h2>
        <p className="mt-1 text-[12px] text-neutral-400">
          Encrypts a secret using the public key. Output is ready to paste into{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-[11px]">kizen.json</code>.
        </p>
      </div>

      {publicKey === null ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-700">
          <FontAwesomeIcon icon={faKey} className="shrink-0 text-[11px]" />
          Fetch the public key above first.
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
            disabled={encryptLoading || !secretValue.trim()}
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
              setValidateInput(e.target.value);
              setValidationResult(null);
            }}
            placeholder={`Paste the { "encrypted": true, "value": "…" } JSON, or just the raw base64 value`}
            rows={4}
            className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-[11px] text-neutral-700 outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>

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
