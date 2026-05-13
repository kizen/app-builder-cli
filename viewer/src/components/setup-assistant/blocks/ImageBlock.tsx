import type { FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { useFieldBlock } from '../useFieldBlock.js';
import { LinkAnchor } from './LinkAnchor.js';

const isDimensionless = (field: AssistantField): boolean =>
  !field.width && !field.height;

const getWidth = (field: AssistantField): string => {
  if (isDimensionless(field)) {
    return '100%';
  }

  if (field.width || field.width === 0) {
    return `${String(field.width)}px`;
  }

  return 'auto';
};

const getHeight = (field: AssistantField): string => {
  if (isDimensionless(field)) {
    return 'auto';
  }

  if (field.height || field.height === 0) {
    return `${String(field.height)}px`;
  }

  return 'auto';
};

export const ImageBlock: FC<{ field: AssistantField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  if (shouldHide) {
    return null;
  }

  const img = (
    <img
      src={field.src}
      alt={field.title ?? ''}
      title={field.title}
      style={{
        width: getWidth(field),
        height: getHeight(field),
        maxWidth: '100%',
      }}
    />
  );

  if (field.link) {
    return (
      <div className="flex justify-center">
        <LinkAnchor
          link={{
            ...field.link,
            ...(field.include !== undefined && { include: field.include }),
          }}
          className="inline-block"
        >
          {img}
        </LinkAnchor>
      </div>
    );
  }

  return <div className="flex justify-center">{img}</div>;
};
