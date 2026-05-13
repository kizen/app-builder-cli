import type { FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { usePluginSafeHTML } from '@kizenapps/engine/react';
import { renderMarkdown } from '../../../lib/markdown.js';
import { useFieldBlock } from '../useFieldBlock.js';

export const DescriptionBlock: FC<{ field: AssistantField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  const markdown = renderMarkdown(field.content ?? '');

  const { html } = usePluginSafeHTML(markdown);

  if (shouldHide) {
    return null;
  }

  return (
    <div
      className="text-[13px] text-neutral-500 leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
