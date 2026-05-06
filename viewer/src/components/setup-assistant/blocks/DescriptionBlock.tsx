import type { FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { renderMarkdown } from '../../../lib/markdown.js';
import { useFieldBlock } from '../useFieldBlock.js';

export const DescriptionBlock: FC<{ field: AssistantField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  if (shouldHide) {
    return null;
  }

  return (
    <div
      className="text-[13px] text-neutral-500 leading-relaxed [&_a]:text-blue-600 [&_a]:underline [&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_em]:italic [&_code]:bg-neutral-100 [&_code]:px-1 [&_code]:rounded"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(field.content ?? '') }}
    />
  );
};
