import { useCallback, useEffect, useState, type FC } from 'react';
import type { AssistantField, SelectOption, UnknownJSON } from '@kizenapps/engine';
import { FieldLabel } from '../FieldLabel.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { useApi } from '../../../api.js';

export const FieldBlock: FC<{
  field: AssistantField;
  disabled?: boolean;
}> = ({ field, disabled = false }) => {
  const {
    interpolateValue,
    state,
    setState,
    registerFieldResetter,
    afterFieldChange,
    isDisabled,
    shouldHide,
    errorState,
  } = useFieldBlock(field, disabled);

  const objectId = interpolateValue(field.object_id ?? '') as string | undefined;

  const [fieldOptions, setFieldOptions] = useState<SelectOption[]>([]);
  const [objectName, setObjectName] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetchedForObject, setFetchedForObject] = useState<string | null>(null);

  const request = useApi();

  // Fetch fields when objectId changes
  useEffect(() => {
    if (!objectId || objectId === fetchedForObject || shouldHide) {
      return;
    }

    const fetchFields = async (): Promise<void> => {
      setLoading(true);

      try {
        const objRes = await request(`/custom-objects/${objectId}`);
        const objData = (await objRes.json()) as { object_name?: string };

        setObjectName(objData.object_name ?? '');

        const fieldsRes = await request(`/custom-objects/${objectId}/fields`);
        const fieldsData = (await fieldsRes.json()) as
          | { results?: { id: string; display_name: string }[] }
          | { id: string; display_name: string }[];
        const items = Array.isArray(fieldsData) ? fieldsData : (fieldsData.results ?? []);

        setFieldOptions(items.map((f) => ({ label: f.display_name, value: f.id })));

        setFetchedForObject(objectId);
      } catch {
        setFieldOptions([]);
      } finally {
        setLoading(false);
      }
    };

    void fetchFields();
  }, [objectId, fetchedForObject, request, field.key, shouldHide]);

  const value = (state as Record<string, { value?: SelectOption | SelectOption[] }>)[field.key]
    ?.value;

  const onChange = useCallback(
    (newValue: SelectOption | SelectOption[]) => {
      setState(
        (prev) =>
          ({
            ...prev,
            [field.key]: {
              type: 'field',
              value: newValue,
              associatedObject: { id: objectId, name: objectName },
            },
          }) as Record<string, UnknownJSON>,
      );

      afterFieldChange(field.key);
    },
    [field.key, setState, objectId, objectName, afterFieldChange],
  );

  useEffect(() => {
    registerFieldResetter(field.key, () => {
      setState((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field.key)));
    });
  }, [field.key, registerFieldResetter, setState]);

  if (shouldHide) {
    return null;
  }

  const fieldDisabled = !objectId || isDisabled;

  if (field.allow_multiple) {
    const selectedValues = Array.isArray(value) ? value : [];

    return (
      <div className="flex flex-col gap-1">
        <FieldLabel field={field} />
        <div
          className={`rounded border p-2 text-[13px] ${
            errorState?.error ? 'border-red-300' : 'border-black/10'
          } ${fieldDisabled ? 'bg-neutral-50' : 'bg-white'}`}
        >
          {loading ? (
            <span className="text-neutral-400 text-[12px]">Loading fields...</span>
          ) : !objectId ? (
            <span className="text-neutral-400 text-[12px]">Select an object first</span>
          ) : fieldOptions.length === 0 ? (
            <span className="text-neutral-400 text-[12px]">No fields available</span>
          ) : (
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
              {fieldOptions.map((opt) => {
                const isChecked = selectedValues.some((v) => v.value === opt.value);

                return (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={fieldDisabled}
                      onChange={() => {
                        const next = isChecked
                          ? selectedValues.filter((v) => v.value !== opt.value)
                          : [...selectedValues, opt];

                        onChange(next);
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

  const selectedValue = value && !Array.isArray(value) ? value.value : '';

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel field={field} />
      {loading ? (
        <div className="w-full rounded border border-black/10 px-2 py-1.5 text-[12px] text-neutral-400 bg-neutral-50">
          Loading fields...
        </div>
      ) : (
        <select
          value={selectedValue}
          onChange={(e) => {
            const opt = fieldOptions.find((o) => o.value === e.target.value);

            if (opt) {
              onChange(opt);
            }
          }}
          disabled={fieldDisabled}
          className={`w-full rounded border px-2 py-1.5 text-[13px] font-mono focus:outline-none focus:ring-1 ${
            errorState?.error
              ? 'border-red-300 focus:ring-red-400'
              : 'border-black/10 focus:ring-blue-400'
          } ${fieldDisabled ? 'bg-neutral-50 text-neutral-400' : 'bg-white'}`}
        >
          <option value="">{!objectId ? 'Select an object first' : 'Choose a field'}</option>
          {fieldOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
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
