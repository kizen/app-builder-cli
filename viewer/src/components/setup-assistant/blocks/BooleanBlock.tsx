import { useCallback, useEffect, type FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { useFieldBlock } from '../useFieldBlock.js';

export const BooleanBlock: FC<{ field: AssistantField; disabled?: boolean }> = ({
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
    (state as Record<string, { value?: boolean }>)[field.key]?.value ?? field.default ?? false;
  const checked = value === true || value === 'true';

  const setBooleanValue = useCallback(
    (newValue: boolean | undefined) => {
      setState((prev) => ({
        ...prev,
        [field.key]: { type: 'boolean', value: newValue },
      }));

      afterFieldChange(field.key);
    },
    [field.key, setState, afterFieldChange],
  );

  useEffect(() => {
    registerFieldResetter(field.key, () => {
      setBooleanValue(undefined);
    });
  }, [field.key, registerFieldResetter, setBooleanValue]);

  if (shouldHide) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            setBooleanValue(e.target.checked);
          }}
          disabled={isDisabled}
          className="h-3.5 w-3.5 cursor-pointer accent-blue-600"
        />
        <span className={`text-[13px] ${isDisabled ? 'text-neutral-400' : 'text-neutral-700'}`}>
          {field.label}
          {field.required && <span className="text-red-500 ml-0.5">*</span>}
        </span>
        {field.tooltip && (
          <span className="text-[11px] text-neutral-400" title={field.tooltip}>
            ?
          </span>
        )}
      </label>
      {errorState?.showMessage && errorState.message && (
        <span className="text-[11px] text-red-500">{errorState.message}</span>
      )}
    </div>
  );
};
