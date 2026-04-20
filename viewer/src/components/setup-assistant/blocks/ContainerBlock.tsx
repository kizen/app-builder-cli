import type { FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { SetupAssistantRow } from '../SetupAssistantRow.js';
import { useFieldBlock } from '../useFieldBlock.js';

export const ContainerBlock: FC<{
  field: AssistantField;
  pluginApiName: string;
  disabled?: boolean;
}> = ({ field, pluginApiName, disabled = false }) => {
  const { shouldHide } = useFieldBlock(field, disabled);
  const columns = field.columns ?? 1;

  if (shouldHide) {
    return null;
  }

  return (
    <div>
      {field.label && (
        <h3 className="text-[14px] font-semibold text-neutral-800 mb-3 mt-4">{field.label}</h3>
      )}
      <div
        className="gap-4"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${String(columns)}, 1fr)`,
        }}
      >
        {field.fields?.map((f) => (
          <SetupAssistantRow
            key={f.key}
            field={f}
            pluginApiName={pluginApiName}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
};
