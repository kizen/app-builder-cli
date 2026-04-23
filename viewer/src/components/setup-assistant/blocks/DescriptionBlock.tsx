import type { FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { useFieldBlock } from '../useFieldBlock.js';

export const DescriptionBlock: FC<{ field: AssistantField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  if (shouldHide) {
    return null;
  }

  return <div className="text-[13px] text-neutral-500 leading-relaxed">{field.content}</div>;
};
