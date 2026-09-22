import { useCallback, useEffect, useState, type FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { FieldLabel } from '../FieldLabel.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { SETUP_ASSISTANT_DEBOUNCE_MS } from '../../../lib/constants.js';

export const ApiKeyBlock: FC<{ field: AssistantField; disabled?: boolean }> = ({
  field,
  disabled = false,
}) => {
  const {
    state,
    setState,
    afterFieldChange,
    registerFieldResetter,
    isDisabled,
    shouldHide,
    errorState,
  } = useFieldBlock(field, disabled);

  const stored = (state as Record<string, { value?: string; hasValue?: boolean } | undefined>)[
    field.key
  ];
  const hasValue = Boolean(stored?.hasValue);

  const [internalValue, setInternalValue] = useState(stored?.value ?? '');

  const setValue = useCallback(
    (newValue: string) => {
      setState((prev) => ({
        ...prev,
        [field.key]: { type: 'api_key', value: newValue },
      }));

      afterFieldChange(field.key);
    },
    [field.key, setState, afterFieldChange],
  );

  const clear = useCallback(() => {
    setInternalValue('');
    setState((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)));
    afterFieldChange(field.key);
  }, [field.key, setState, afterFieldChange]);

  useEffect(() => {
    registerFieldResetter(field.key, clear);
  }, [field.key, registerFieldResetter, clear]);

  useEffect(() => {
    if (hasValue) {
      return;
    }

    const timer = setTimeout(() => {
      setValue(internalValue);
    }, SETUP_ASSISTANT_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [internalValue, hasValue, setValue]);

  if (shouldHide) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel field={field} />
      {hasValue ? (
        <div className="flex items-center justify-between gap-2 rounded border border-black/10 bg-neutral-50 px-2 py-1.5 text-[13px]">
          <span className="font-mono text-neutral-400">••••••••••••</span>
          <button
            type="button"
            disabled={isDisabled}
            onClick={clear}
            className="shrink-0 text-[11px] font-medium text-blue-600 hover:underline disabled:opacity-50"
          >
            Replace
          </button>
        </div>
      ) : (
        <input
          type="password"
          value={internalValue}
          onChange={(e) => {
            setInternalValue(e.target.value);
          }}
          onBlur={() => {
            setValue(internalValue);
          }}
          placeholder={field.placeholder ?? 'Enter API key'}
          disabled={isDisabled}
          className={`rounded border px-2 py-1.5 text-[13px] font-mono focus:outline-none focus:ring-1 ${
            errorState?.error
              ? 'border-red-300 focus:ring-red-400'
              : 'border-black/10 focus:ring-blue-400'
          } ${isDisabled ? 'bg-neutral-50 text-neutral-400' : 'bg-white'}`}
        />
      )}
      <span className="text-[11px] text-neutral-400">
        Saved to Integration Secrets as{' '}
        <code className="rounded bg-neutral-100 px-1 py-0.5">{field.secret ?? field.key}</code> on
        the next Save. Never stored in plugin config.
      </span>
      {errorState?.showMessage && errorState.message && (
        <span className="text-[11px] text-red-500">{errorState.message}</span>
      )}
    </div>
  );
};
