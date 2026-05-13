import type { FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { useFieldBlock } from '../useFieldBlock.js';
import { LinkAnchor } from './LinkAnchor.js';

export const LinkBlock: FC<{ field: AssistantField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  if (shouldHide) {
    return null;
  }

  return (
    <LinkAnchor link={field} className="text-[13px] text-blue-600 underline">
      {field.text}
    </LinkAnchor>
  );
};
