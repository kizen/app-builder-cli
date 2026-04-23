import { useCallback, useEffect, useState, type FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { FieldLabel } from '../FieldLabel.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { SETUP_ASSISTANT_DEBOUNCE_MS } from '../../../lib/constants.js';

export const TextBlock: FC<{ field: AssistantField; disabled?: boolean }> = ({
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

  const value =
    (state as Record<string, { value?: string }>)[field.key]?.value ?? field.default ?? '';
  const [internalValue, setInternalValue] = useState(value);

  const setValue = useCallback(
    (newValue: string) => {
      setState((prev) => ({
        ...prev,
        [field.key]: { type: 'text', value: newValue },
      }));

      afterFieldChange(field.key);
    },
    [field.key, setState, afterFieldChange],
  );

  useEffect(() => {
    registerFieldResetter(field.key, () => {
      setInternalValue('');

      setValue('');
    });
  }, [field.key, registerFieldResetter, setValue]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setValue(internalValue);
    }, SETUP_ASSISTANT_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [internalValue, setValue]);

  if (shouldHide) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel field={field} />
      <input
        type="text"
        value={internalValue}
        onChange={(e) => {
          setInternalValue(e.target.value);
        }}
        placeholder={field.placeholder ?? field.default ?? 'Enter text'}
        disabled={isDisabled}
        className={`rounded border px-2 py-1.5 text-[13px] font-mono focus:outline-none focus:ring-1 ${
          errorState?.error
            ? 'border-red-300 focus:ring-red-400'
            : 'border-black/10 focus:ring-blue-400'
        } ${isDisabled ? 'bg-neutral-50 text-neutral-400' : 'bg-white'}`}
      />
      {errorState?.showMessage && errorState.message && (
        <span className="text-[11px] text-red-500">{errorState.message}</span>
      )}
    </div>
  );
};
