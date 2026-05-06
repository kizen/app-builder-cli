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
import { kizenRequestHandler, useApi } from '../../../api.js';
import { SEARCH_DEBOUNCE_MS } from '../../../lib/constants.js';
import { DropdownPortal } from '../../DropdownPortal.js';
import { createKizenApiClient } from '../../../lib/kizenApiClient.js';
import { useToast } from '../../../ToastContext.js';

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

  const showToast = useToast();

  const readyForRequests = !inferencePending && !initialExpressionsPending && expressionsIdle;

  const [dynamicOptionsCache, setDynamicOptionsCache] = useState<Record<string, SelectOption[]>>(
    {},
  );
  const [optionsLoading, setOptionsLoading] = useState(false);
  const fetchedHashesRef = useRef<Set<string>>(new Set());
  const contextResultRef = useRef<unknown>(undefined);

  // Typeahead state
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const typeaheadAnchorRef = useRef<HTMLDivElement>(null);

  const isDynamic = Boolean(field.getFetchUrl || field.optionMapper);

  const value = (state as Record<string, { value?: SelectOption | SelectOption[] }>)[field.key]
    ?.value;

  const request = useApi();

  const apiClient = useMemo(() => createKizenApiClient(request), [request]);

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

  // Strip the field's own key so toggling a multi-select option doesn't refetch
  const fetchHash = useMemo(() => {
    const partial = Object.fromEntries(
      Object.entries(stateForFetch).filter(([k]) => k !== field.key),
    );

    return JSON.stringify(partial);
  }, [stateForFetch, field.key]);

  const performHttp = useCallback(
    async (
      method: string,
      url: string,
      headers: Record<string, string>,
      body: string | null,
    ): Promise<unknown> => {
      if (url.startsWith('/')) {
        return kizenRequestHandler(apiClient)(method, url, {
          headers,
          ...(body != null && { body }),
        });
      }

      const res = await fetch(url, { method, headers, ...(body != null && { body }) });

      if (!res.ok) {
        throw new Error('Error fetching options');
      }

      return res.json();
    },
    [apiClient],
  );

  // Core fetch — handles optional context fetch, then options fetch, then mapping
  const fetchOptions = useCallback(
    async (fetchState: Record<string, unknown>, hash: string): Promise<void> => {
      if (fetchedHashesRef.current.has(hash)) {
        return;
      }

      fetchedHashesRef.current.add(hash);
      setOptionsLoading(true);

      const method = field.fetchMethod ?? 'GET';

      // Phase 1: context fetch (cached per component lifetime)
      let contextResult = contextResultRef.current;

      if (field.getContextUrl && contextResult === undefined) {
        try {
          const contextExpressionState: UnknownJSON = {
            __kizen_state: { value: { ...fetchState, pluginApiName } },
          } as UnknownJSON;

          const contextUrl = await runStringExpression(
            field.getContextUrl,
            contextExpressionState,
          );

          if (contextUrl) {
            let headers: Record<string, string> = { 'Content-Type': 'application/json' };
            let body: string | null = null;

            if (field.getHeaders) {
              headers = (await runObjectExpression(
                field.getHeaders,
                contextExpressionState,
              )) as Record<string, string>;
            }

            if (method === 'POST' && field.getBody) {
              const bodyObj = await runObjectExpression(field.getBody, contextExpressionState);

              body = JSON.stringify(bodyObj);
            }

            contextResult = await performHttp(method, contextUrl, headers, body);
          }
        } catch (err) {
          showToast({
            variant: 'failure',
            message: `Error fetching options for ${field.label ?? field.key}: ${
              err instanceof Error ? err.message : 'Unknown error'
            }`,
          });
          fetchedHashesRef.current.delete(hash);
          setOptionsLoading(false);

          return;
        }
      }

      contextResultRef.current = contextResult;

      // Phase 2: options fetch + mapping
      try {
        const expressionState: UnknownJSON = {
          __kizen_state: {
            value: { ...fetchState, context: contextResult as JSONValue, pluginApiName },
          },
        } as UnknownJSON;

        let apiResult: unknown;

        if (field.getFetchUrl) {
          const url = await runStringExpression(field.getFetchUrl, expressionState);

          if (url) {
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

            apiResult = await performHttp(method, url, headers, body);
          }
        }

        if (field.optionMapper) {
          const mapped = await runOptionExpression(field.optionMapper, {
            __kizen_state: {
              value: {
                ...fetchState,
                result: apiResult as JSONValue,
                context: contextResult as JSONValue,
                pluginApiName,
              },
            },
          } as UnknownJSON);

          setDynamicOptionsCache((prev) => ({ ...prev, [hash]: structuredClone(mapped) }));
        } else if (Array.isArray(apiResult)) {
          setDynamicOptionsCache((prev) => ({ ...prev, [hash]: apiResult as SelectOption[] }));
        } else {
          throw new Error('API result is not an array');
        }
      } catch {
        // Cache empty so the UI shows "no options" instead of stale data,
        // and won't keep retrying the same hash.
        setDynamicOptionsCache((prev) => ({ ...prev, [hash]: [] }));
      } finally {
        setOptionsLoading(false);
      }
    },
    [field, pluginApiName, performHttp, showToast],
  );

  // Non-typeahead dynamic fetch: triggered by state changes
  useEffect(() => {
    if (!isDynamic || !readyForRequests || shouldHide || field.typeahead) {
      return;
    }

    void fetchOptions(stateForFetch, fetchHash);
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

    if (!isOpen || !debouncedSearch) {
      return;
    }

    void fetchOptions(stateForFetch, fetchHash);
  }, [
    isDynamic,
    readyForRequests,
    fetchHash,
    stateForFetch,
    field.typeahead,
    isOpen,
    debouncedSearch,
    shouldHide,
    fetchOptions,
  ]);

  // AutoSelect-driven fetch: kick off a fetch even before the menu opens, so a
  // single available option can be selected automatically.
  useEffect(() => {
    if (
      !isDynamic ||
      !field.autoSelect ||
      field.typeahead ||
      isDisabled ||
      shouldHide ||
      !readyForRequests
    ) {
      return;
    }

    void fetchOptions(stateForFetch, fetchHash);
  }, [
    isDynamic,
    field.autoSelect,
    field.typeahead,
    isDisabled,
    shouldHide,
    readyForRequests,
    fetchOptions,
    stateForFetch,
    fetchHash,
  ]);

  const dynamicOptions = useMemo(
    () => dynamicOptionsCache[fetchHash] ?? [],
    [dynamicOptionsCache, fetchHash],
  );

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
          {optionsLoading && options.length === 0 ? (
            <span className="text-neutral-400 text-[12px]">Loading options...</span>
          ) : options.length === 0 ? (
            <span className="text-neutral-400 text-[12px]">No options available</span>
          ) : (
            <div
              className={`flex flex-col gap-1 max-h-48 overflow-y-auto transition-opacity ${
                optionsLoading ? 'opacity-60' : ''
              }`}
            >
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
      {optionsLoading && options.length === 0 ? (
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
          className={`w-full rounded border px-2 py-1.5 text-[13px] font-mono focus:outline-none focus:ring-1 transition-opacity ${
            errorState?.error
              ? 'border-red-300 focus:ring-red-400'
              : 'border-black/10 focus:ring-blue-400'
          } ${isDisabled ? 'bg-neutral-50 text-neutral-400' : 'bg-white'} ${
            optionsLoading ? 'opacity-60' : ''
          }`}
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
