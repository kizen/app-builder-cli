import type { FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';

export const FieldLabel: FC<{ field: AssistantField }> = ({ field }) => {
  if (!field.label) {
    return null;
  }

  return (
    <label className="text-[12px] font-medium text-neutral-600">
      {field.label}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
      {field.tooltip && (
        <span className="ml-1 text-neutral-400 cursor-help" title={field.tooltip}>
          ?
        </span>
      )}
    </label>
  );
};
