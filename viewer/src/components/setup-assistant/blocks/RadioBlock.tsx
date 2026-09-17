import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import type { AssistantField, SelectOption, UnknownJSON } from '@kizenapps/engine';
import { FieldLabel } from '../FieldLabel.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { SETUP_ASSISTANT_DEBOUNCE_MS } from '../../../lib/constants.js';

export const RadioBlock: FC<{ field: AssistantField; disabled?: boolean }> = ({
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
    evaluateExpression,
  } = useFieldBlock(field, disabled);

  const options = useMemo(() => field.options ?? [], [field.options]);

  const value =
    (state as Record<string, { value?: SelectOption }>)[field.key]?.value ??
    options.find((opt) => opt.value === field.default);

  const [disabledOptions, setDisabledOptions] = useState<Record<string, boolean>>({});

  const setRadioValue = useCallback(
    (option: SelectOption) => {
      setState(
        (prev) =>
          ({
            ...prev,
            [field.key]: { type: 'radio', value: option },
          }) as Record<string, UnknownJSON>,
      );

      afterFieldChange(field.key);
    },
    [field.key, setState, afterFieldChange],
  );

  const clearRadioValue = useCallback(() => {
    setState((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)));
    afterFieldChange(field.key);
  }, [field.key, setState, afterFieldChange]);

  useEffect(() => {
    registerFieldResetter(field.key, clearRadioValue);
  }, [field.key, registerFieldResetter, clearRadioValue]);

  useEffect(() => {
    if ((state as Record<string, { value?: SelectOption }>)[field.key]?.value) {
      return;
    }

    const defaultOption = options.find((opt) => opt.value === field.default);

    if (defaultOption) {
      setRadioValue(defaultOption);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stateHash = useMemo(() => JSON.stringify(state), [state]);

  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(() => {
      void Promise.all(
        options.map(async (opt) => {
          if (!opt.disabled) {
            return [opt.value, false] as const;
          }

          const result = await evaluateExpression(
            opt.disabled,
            `${field.key}__option__${opt.value}`,
          );

          return [opt.value, Boolean(result)] as const;
        }),
      ).then((results) => {
        if (!cancelled) {
          setDisabledOptions(Object.fromEntries(results));
        }
      });
    }, SETUP_ASSISTANT_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [field.key, options, evaluateExpression, stateHash]);

  // A disabled option is never a legal saved value — fall back to `default`, unless the
  // default is itself disabled, in which case there's no legal value to fall back to.
  useEffect(() => {
    if (!value || !disabledOptions[value.value]) {
      return;
    }

    const fallback = options.find((opt) => opt.value === field.default);

    if (fallback && !disabledOptions[fallback.value] && fallback.value !== value.value) {
      setRadioValue(fallback);
    } else {
      clearRadioValue();
    }
  }, [disabledOptions, value, options, field.default, setRadioValue, clearRadioValue]);

  if (shouldHide) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel field={field} />
      <div
        className={`inline-flex max-w-full flex-wrap self-start overflow-hidden rounded-lg border text-[12px] font-medium ${
          errorState?.error ? 'border-red-300' : 'border-black/10'
        }`}
      >
        {options.map((opt, i) => {
          const isSelected = value?.value === opt.value;
          const isOptionDisabled = isDisabled || Boolean(disabledOptions[opt.value]);

          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={isSelected}
              disabled={isOptionDisabled}
              onClick={() => {
                setRadioValue(opt);
              }}
              className={`px-3 py-1.5 transition-colors ${i > 0 ? 'border-l border-black/10' : ''} ${
                isSelected
                  ? 'bg-neutral-700 text-white'
                  : isOptionDisabled
                    ? 'cursor-not-allowed bg-neutral-50 text-neutral-300'
                    : 'bg-white text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {errorState?.showMessage && errorState.message && (
        <span className="text-[11px] text-red-500">{errorState.message}</span>
      )}
    </div>
  );
};
