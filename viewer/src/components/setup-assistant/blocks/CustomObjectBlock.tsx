import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import type { AssistantField, UnknownJSON } from '@kizenapps/engine';
import { FieldLabel } from '../FieldLabel.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { useApi } from '../../../api.js';
import { useBootstrap } from '../../../BootstrapContext.js';
import { Typeahead, type TypeaheadOption } from '../../Typeahead.js';

interface ObjectValue {
  id: string;
  objectName: string;
}

export const CustomObjectBlock: FC<{
  field: AssistantField;
  disabled?: boolean;
}> = ({ field, disabled = false }) => {
  const {
    state,
    setState,
    getNestedFields,
    reInferFieldsForObject,
    shouldDisableField,
    registerFieldResetter,
    afterFieldChange,
    isDisabled,
    shouldHide,
    errorState,
  } = useFieldBlock(field, disabled);

  const fieldDisabled = shouldDisableField(field.key) || isDisabled;

  const [searchText, setSearchText] = useState('');
  const [options, setOptions] = useState<TypeaheadOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const request = useApi();
  const bootstrap = useBootstrap();

  const fetchObjects = useCallback(
    async (search: string) => {
      setLoading(true);

      try {
        const params = new URLSearchParams({ page_size: '20' });

        if (search) {
          params.set('search', search);
        }

        const res = await request(`/custom-objects?${params.toString()}`);
        const data = (await res.json()) as
          | { results?: { id: string; object_name: string }[] }
          | { id: string; object_name: string }[];
        const items = Array.isArray(data) ? data : (data.results ?? []);
        const opts: TypeaheadOption[] = items.map((o) => ({ id: o.id, label: o.object_name }));

        const co = bootstrap?.business.client_object;

        if (co?.access) {
          const matchesSearch =
            !search || co.object_name.toLowerCase().includes(search.toLowerCase());

          if (matchesSearch) {
            opts.unshift({ id: co.id, label: co.object_name });
          }
        }

        setOptions(opts);
      } catch {
        // Keep prior options so the typeahead dropdown doesn't wipe on a transient error.
      } finally {
        setLoading(false);
      }
    },
    [request, bootstrap],
  );

  const multiValue = field.allow_multiple
    ? ((state as Record<string, { value?: ObjectValue[] }>)[field.key]?.value ?? [])
    : [];

  const handleMultiSelect = useCallback(
    (id: string, objectName: string) => {
      const existing = (state as Record<string, { value?: ObjectValue[] }>)[field.key]?.value ?? [];

      // Don't add duplicates
      if (existing.some((v) => v.id === id)) {
        return;
      }

      setState(
        (prev) =>
          ({
            ...prev,
            [field.key]: {
              type: 'custom_object',
              value: [...existing, { id, objectName }],
            },
          }) as Record<string, UnknownJSON>,
      );

      afterFieldChange(field.key);
      setSearchText('');
    },
    [state, field.key, setState, afterFieldChange],
  );

  const handleMultiRemove = useCallback(
    (id: string) => {
      const existing = (state as Record<string, { value?: ObjectValue[] }>)[field.key]?.value ?? [];

      setState(
        (prev) =>
          ({
            ...prev,
            [field.key]: {
              type: 'custom_object',
              value: existing.filter((v) => v.id !== id),
            },
          }) as Record<string, UnknownJSON>,
      );

      afterFieldChange(field.key);
    },
    [state, field.key, setState, afterFieldChange],
  );

  const singleValue = !field.allow_multiple
    ? (state as Record<string, { value?: ObjectValue }>)[field.key]?.value
    : undefined;

  // Initialize search text from single value
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!field.allow_multiple && singleValue?.objectName && !initializedRef.current) {
      setSearchText(singleValue.objectName);
      initializedRef.current = true;
    }
  }, [field.allow_multiple, singleValue]);

  const handleSingleChange = useCallback(
    (text: string) => {
      setSearchText(text);

      // If a value was selected and user is now typing, clear the selection
      if (singleValue) {
        setState((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)),
        );

        afterFieldChange(field.key);
      }

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        void fetchObjects(text);
      }, 300);
    },
    [singleValue, field.key, setState, afterFieldChange, fetchObjects],
  );

  const handleSingleSelect = useCallback(
    (id: string, objectName: string) => {
      setSearchText(objectName);

      setState((prev) => ({
        ...prev,
        [field.key]: {
          type: 'custom_object',
          value: { id, objectName },
        },
      }));

      // Reset dependent field selectors
      const fieldDeps = getNestedFields().filter((f: AssistantField) =>
        f.object_id?.includes(field.key),
      );

      for (const f of fieldDeps) {
        setState((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== f.key)));
      }

      void reInferFieldsForObject(field.key);

      afterFieldChange(field.key);
    },
    [field.key, setState, getNestedFields, reInferFieldsForObject, afterFieldChange],
  );

  const handleSearchChange = useCallback(
    (text: string) => {
      if (field.allow_multiple) {
        setSearchText(text);

        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }

        debounceRef.current = setTimeout(() => {
          void fetchObjects(text);
        }, 300);
      } else {
        handleSingleChange(text);
      }
    },
    [field.allow_multiple, handleSingleChange, fetchObjects],
  );

  const handleSelect = useCallback(
    (id: string, label: string) => {
      if (field.allow_multiple) {
        handleMultiSelect(id, label);
      } else {
        handleSingleSelect(id, label);
      }
    },
    [field.allow_multiple, handleMultiSelect, handleSingleSelect],
  );

  useEffect(() => {
    registerFieldResetter(field.key, () => {
      setState((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)));

      setSearchText('');
      initializedRef.current = false;
    });
  }, [field.key, registerFieldResetter, setState]);

  if (shouldHide) {
    return null;
  }

  if (field.allow_multiple) {
    // Filter out already-selected items from typeahead options
    const filteredOptions = options.filter((opt) => !multiValue.some((v) => v.id === opt.id));

    return (
      <div className="flex flex-col gap-1">
        <FieldLabel field={field} />
        {multiValue.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1">
            {multiValue.map((item) => (
              <span
                key={item.id}
                className="inline-flex items-center gap-1 rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700"
              >
                {item.objectName}
                <button
                  type="button"
                  onClick={() => {
                    handleMultiRemove(item.id);
                  }}
                  disabled={fieldDisabled}
                  className="text-neutral-400 hover:text-neutral-600"
                  aria-label={`Remove ${item.objectName}`}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
        <Typeahead
          value={searchText}
          onChange={handleSearchChange}
          onSelect={handleSelect}
          options={filteredOptions}
          loading={loading}
          placeholder={field.placeholder ?? 'Search for objects...'}
          disabled={fieldDisabled}
          keepOpenOnSelect
        />
        {errorState?.showMessage && errorState.message && (
          <span className="text-[11px] text-red-500">{errorState.message}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel field={field} />
      <div className="relative">
        <Typeahead
          value={searchText}
          onChange={handleSearchChange}
          onSelect={handleSelect}
          options={options}
          loading={loading}
          placeholder={field.placeholder ?? 'Search for an object...'}
          disabled={fieldDisabled}
        />
        {singleValue && (
          <button
            type="button"
            onClick={() => {
              setState((prev) =>
                Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)),
              );

              setSearchText('');
              initializedRef.current = false;

              afterFieldChange(field.key);
            }}
            disabled={fieldDisabled}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400 hover:text-neutral-600"
            aria-label="Clear selection"
          >
            &times;
          </button>
        )}
      </div>
      {errorState?.showMessage && errorState.message && (
        <span className="text-[11px] text-red-500">{errorState.message}</span>
      )}
    </div>
  );
};
