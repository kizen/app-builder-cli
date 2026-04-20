import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import {
  type AssistantField,
  type SelectOption,
  type JSONValue,
  type UnknownJSON,
  runStringExpression,
  runObjectExpression,
  runOptionExpression,
} from '@kizenapps/engine';
import { FieldLabel } from '../FieldLabel.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { useApi } from '../../../api.js';
import { SEARCH_DEBOUNCE_MS } from '../../../lib/constants.js';
import { DropdownPortal } from '../../DropdownPortal.js';

export const SelectBlock: FC<{
  field: AssistantField;
  pluginApiName: string;
  disabled?: boolean;
}> = ({ field, pluginApiName, disabled = false }) => {
  const {
    state,
    setState,
    inferencePending,
    initialExpressionsPending,
    expressionsIdle,
    afterFieldChange,
    registerFieldResetter,
    isDisabled,
    shouldHide,
    errorState,
  } = useFieldBlock(field, disabled);

  const readyForRequests = !inferencePending && !initialExpressionsPending && expressionsIdle;

  const [dynamicOptions, setDynamicOptions] = useState<SelectOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const fetchedHashRef = useRef<string | null>(null);

  // Typeahead state
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const typeaheadAnchorRef = useRef<HTMLDivElement>(null);

  const isDynamic = Boolean(field.getFetchUrl || field.optionMapper);

  const value = (state as Record<string, { value?: SelectOption | SelectOption[] }>)[field.key]
    ?.value;

  const request = useApi();

  const setSelectValue = useCallback(
    (newValue: SelectOption | SelectOption[]) => {
      setState(
        (prev) =>
          ({
            ...prev,
            [field.key]: { type: 'select', value: newValue },
          }) as Record<string, UnknownJSON>,
      );

      afterFieldChange(field.key);
    },
    [afterFieldChange, field.key, setState],
  );

  useEffect(() => {
    registerFieldResetter(field.key, () => {
      setState((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)));
      setSearchText('');
      setDebouncedSearch('');
    });
  }, [field.key, registerFieldResetter, setState]);

  // Debounce search text for typeahead
  useEffect(() => {
    if (!field.typeahead) {
      return;
    }

    const timer = setTimeout(() => {
      setDebouncedSearch(searchText);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [searchText, field.typeahead]);

  // Build state for option fetching — includes `search` for typeahead fields
  const stateForFetch = useMemo(() => {
    if (field.typeahead) {
      return { ...state, search: debouncedSearch };
    }

    return state;
  }, [state, debouncedSearch, field.typeahead]);

  const fetchHash = useMemo(() => JSON.stringify(stateForFetch), [stateForFetch]);

  // Core fetch function — shared between typeahead and non-typeahead paths
  const fetchOptions = useCallback(
    async (fetchState: Record<string, unknown>): Promise<void> => {
      setOptionsLoading(true);

      try {
        const expressionState = {
          __kizen_state: { value: { ...fetchState, pluginApiName } },
        };

        let apiResult: unknown;

        if (field.getFetchUrl) {
          const url = await runStringExpression(field.getFetchUrl, expressionState);

          if (url) {
            const method = field.fetchMethod ?? 'GET';
            let headers: Record<string, string> = { 'Content-Type': 'application/json' };
            let body: string | null = null;

            if (field.getHeaders) {
              headers = (await runObjectExpression(field.getHeaders, expressionState)) as Record<
                string,
                string
              >;
            }

            if (method === 'POST' && field.getBody) {
              const bodyObj = await runObjectExpression(field.getBody, expressionState);

              body = JSON.stringify(bodyObj);
            }

            if (url.startsWith('/')) {
              const res = await request(url, { method, headers, ...(body != null && { body }) });
              const fetchedResult = (await res.json()) as unknown;

              apiResult = { data: fetchedResult };
            } else {
              const res = await fetch(url, { method, headers, ...(body != null && { body }) });

              if (res.ok) {
                apiResult = await res.json();
              }
            }
          }
        }

        if (field.optionMapper) {
          const mapped = await runOptionExpression(field.optionMapper, {
            __kizen_state: {
              value: { ...fetchState, result: apiResult as JSONValue, pluginApiName },
            },
          } as UnknownJSON);

          setDynamicOptions(structuredClone(mapped));
        } else if (Array.isArray(apiResult)) {
          setDynamicOptions(apiResult as SelectOption[]);
        }
      } catch {
        setDynamicOptions([]);
      } finally {
        setOptionsLoading(false);
      }
    },
    [field, pluginApiName, request],
  );

  // Non-typeahead dynamic fetch: triggered by state changes
  useEffect(() => {
    if (!isDynamic || !readyForRequests || shouldHide || field.typeahead) {
      return;
    }

    if (fetchedHashRef.current === fetchHash) {
      return;
    }

    fetchedHashRef.current = fetchHash;
    void fetchOptions(stateForFetch);
  }, [
    isDynamic,
    readyForRequests,
    fetchHash,
    stateForFetch,
    field.typeahead,
    shouldHide,
    fetchOptions,
  ]);

  // Typeahead dynamic fetch: triggered by debounced search when dropdown is open
  useEffect(() => {
    if (!isDynamic || !readyForRequests || shouldHide || !field.typeahead) {
      return;
    }

    if (!isOpen) {
      return;
    }

    if (fetchedHashRef.current === fetchHash) {
      return;
    }

    fetchedHashRef.current = fetchHash;
    void fetchOptions(stateForFetch);
  }, [
    isDynamic,
    readyForRequests,
    fetchHash,
    stateForFetch,
    field.typeahead,
    isOpen,
    shouldHide,
    fetchOptions,
  ]);

  // AutoSelect: when exactly one option is available, select it automatically
  useEffect(() => {
    if (!isDynamic || !field.autoSelect || field.typeahead || isDisabled || shouldHide || value) {
      return;
    }

    if (dynamicOptions.length === 1 && dynamicOptions[0]) {
      if (field.allow_multiple) {
        setSelectValue([dynamicOptions[0]]);
      } else {
        setSelectValue(dynamicOptions[0]);
      }
    }
  }, [
    isDynamic,
    field.autoSelect,
    field.typeahead,
    field.allow_multiple,
    isDisabled,
    shouldHide,
    value,
    dynamicOptions,
    setSelectValue,
  ]);

  if (shouldHide) {
    return null;
  }

  const options = isDynamic ? dynamicOptions : (field.options ?? []);

  if (field.allow_multiple) {
    const selectedValues = Array.isArray(value) ? value : [];

    return (
      <div className="flex flex-col gap-1">
        <FieldLabel field={field} />
        <div
          className={`rounded border p-2 text-[13px] ${
            errorState?.error ? 'border-red-300' : 'border-black/10'
          } ${isDisabled ? 'bg-neutral-50' : 'bg-white'}`}
        >
          {optionsLoading ? (
            <span className="text-neutral-400 text-[12px]">Loading options...</span>
          ) : options.length === 0 ? (
            <span className="text-neutral-400 text-[12px]">No options available</span>
          ) : (
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
              {options.map((opt) => {
                const isChecked = selectedValues.some((v) => v.value === opt.value);

                return (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={isDisabled}
                      onChange={() => {
                        const next = isChecked
                          ? selectedValues.filter((v) => v.value !== opt.value)
                          : [...selectedValues, opt];

                        setSelectValue(next);
                      }}
                      className="h-3 w-3 accent-blue-600"
                    />
                    <span className="text-[12px]">{opt.label}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        {errorState?.showMessage && errorState.message && (
          <span className="text-[11px] text-red-500">{errorState.message}</span>
        )}
      </div>
    );
  }

  if (field.typeahead) {
    const selectedLabel = value && !Array.isArray(value) ? value.label : '';

    return (
      <div className="flex flex-col gap-1">
        <FieldLabel field={field} />
        <div ref={typeaheadAnchorRef} className="relative">
          <input
            type="text"
            value={selectedLabel && !isOpen ? selectedLabel : searchText}
            placeholder={field.placeholder ?? 'Search...'}
            disabled={isDisabled}
            onChange={(e) => {
              setSearchText(e.target.value);

              // Clear selection when user edits text
              if (value) {
                setState((prev) =>
                  Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)),
                );
                afterFieldChange(field.key);
              }
            }}
            onFocus={() => {
              setIsOpen(true);

              // If there's already a selected value, show its label as search text
              if (selectedLabel) {
                setSearchText(selectedLabel);
              }
            }}
            onBlur={() => {
              setIsOpen(false);
            }}
            className={`w-full rounded border px-2 py-1.5 text-[13px] font-mono focus:outline-none focus:ring-1 ${
              errorState?.error
                ? 'border-red-300 focus:ring-red-400'
                : 'border-black/10 focus:ring-blue-400'
            } ${isDisabled ? 'bg-neutral-50 text-neutral-400' : 'bg-white'}`}
          />
          {selectedLabel && !isOpen && (
            <button
              type="button"
              onClick={() => {
                setState((prev) =>
                  Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)),
                );
                setSearchText('');
                setDebouncedSearch('');
                afterFieldChange(field.key);
              }}
              disabled={isDisabled}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400 hover:text-neutral-600"
              aria-label="Clear selection"
            >
              &times;
            </button>
          )}
        </div>
        <DropdownPortal anchorRef={typeaheadAnchorRef} open={isOpen}>
          {optionsLoading && (
            <div className="px-3 py-2 text-[12px] text-neutral-400">Loading...</div>
          )}
          {!optionsLoading && options.length === 0 && searchText.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-neutral-400">Start typing to search...</div>
          )}
          {!optionsLoading && options.length === 0 && searchText.length > 0 && (
            <div className="px-3 py-2 text-[12px] text-neutral-400">No results</div>
          )}
          {!optionsLoading &&
            options.map((opt) => (
              <div
                key={opt.value}
                className="cursor-pointer px-3 py-2 text-[12px] text-neutral-800 hover:bg-neutral-100"
                onClick={() => {
                  setSelectValue(opt);
                  setSearchText(opt.label);
                  setIsOpen(false);
                }}
              >
                {opt.label}
              </div>
            ))}
        </DropdownPortal>
        {errorState?.showMessage && errorState.message && (
          <span className="text-[11px] text-red-500">{errorState.message}</span>
        )}
      </div>
    );
  }

  // Use index-based values because SelectOption.value can be non-string at
  // runtime (arrays, objects) which native <option value> can't represent.
  const selectedIndex =
    value && !Array.isArray(value)
      ? options.findIndex((o) => JSON.stringify(o.value) === JSON.stringify(value.value))
      : -1;

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel field={field} />
      {optionsLoading ? (
        <div className="w-full rounded border border-black/10 px-2 py-1.5 text-[12px] text-neutral-400 bg-neutral-50">
          Loading options...
        </div>
      ) : (
        <select
          value={selectedIndex >= 0 ? String(selectedIndex) : ''}
          onChange={(e) => {
            const idx = Number(e.target.value);
            const opt = options[idx];

            if (opt) {
              setSelectValue(opt);
            }
          }}
          disabled={isDisabled}
          className={`w-full rounded border px-2 py-1.5 text-[13px] font-mono focus:outline-none focus:ring-1 ${
            errorState?.error
              ? 'border-red-300 focus:ring-red-400'
              : 'border-black/10 focus:ring-blue-400'
          } ${isDisabled ? 'bg-neutral-50 text-neutral-400' : 'bg-white'}`}
        >
          <option value="">{field.placeholder ?? 'Choose an option'}</option>
          {options.map((opt, i) => (
            <option key={opt.label} value={String(i)}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
      {errorState?.showMessage && errorState.message && (
        <span className="text-[11px] text-red-500">{errorState.message}</span>
      )}
    </div>
  );
};
