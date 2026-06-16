import { useEffect, useRef, useState, type FC, type MouseEvent } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRightFromBracket, faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { Tooltip } from './Tooltip.js';
import { useToast } from '../ToastContext.js';

export type ScriptResult = { kind: 'value'; value: unknown } | { kind: 'error'; message: string };

const MAX_LEN = 120;

export const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
};

const formatValue = (value: unknown): { compact: string; full: string; empty: boolean } => {
  if (value === undefined) {
    return { compact: 'no return value', full: 'undefined', empty: true };
  }

  if (typeof value === 'string') {
    return { compact: value === '' ? '""' : value, full: value, empty: value === '' };
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    const stringified = String(value);

    return { compact: stringified, full: stringified, empty: false };
  }

  try {
    return { compact: JSON.stringify(value), full: JSON.stringify(value, null, 2), empty: false };
  } catch {
    // e.g. circular references — not representable as JSON.
    return { compact: '[unserializable value]', full: '[unserializable value]', empty: false };
  }
};

const truncate = (text: string): string =>
  text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}…` : text;

export const ScriptResultPill: FC<{ result: ScriptResult }> = ({ result }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useToast();

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const isError = result.kind === 'error';
  const { compact, full, empty } = isError
    ? { compact: result.message, full: result.message, empty: false }
    : formatValue(result.value);

  const handleCopy = (e: MouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation();

    void navigator.clipboard
      .writeText(full)
      .then(() => {
        setCopied(true);

        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }

        timerRef.current = setTimeout(() => {
          setCopied(false);
        }, 1200);
      })
      .catch((e: unknown) => {
        console.error('Failed to copy to clipboard:', e);
        showToast({ message: 'Could not copy to clipboard', variant: 'failure' });
      });
  };

  return (
    <Tooltip text={copied ? 'Copied!' : full}>
      <span
        role="button"
        tabIndex={-1}
        title="Click to copy"
        onClick={handleCopy}
        className={`inline-flex max-w-[240px] cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
          copied
            ? 'border-emerald-300 bg-emerald-100 text-emerald-800'
            : isError
              ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
              : empty
                ? 'border-black/8 bg-neutral-50 text-neutral-400 hover:bg-neutral-100'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
        }`}
      >
        <FontAwesomeIcon
          icon={copied ? faCheck : isError ? faXmark : faArrowRightFromBracket}
          className="shrink-0 text-[9px] opacity-70"
        />
        <span className="min-w-0 truncate">{copied ? 'Copied!' : truncate(compact)}</span>
      </span>
    </Tooltip>
  );
};
