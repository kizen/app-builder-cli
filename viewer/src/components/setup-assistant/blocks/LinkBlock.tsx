import type { FC } from 'react';
import type { LinkField } from '../../../lib/setupAssistantTypes.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { LinkAnchor } from './LinkAnchor.js';

export const LinkBlock: FC<{ field: LinkField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  if (shouldHide) {
    return null;
  }

  return (
    <LinkAnchor link={field} className="text-[13px] text-blue-600 underline">
      {field.text ?? field.href}
    </LinkAnchor>
  );
};
