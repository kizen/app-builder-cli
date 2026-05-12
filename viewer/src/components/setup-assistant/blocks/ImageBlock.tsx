import type { CSSProperties, FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { useFieldBlock } from '../useFieldBlock.js';
import { LinkAnchor } from './LinkAnchor.js';

const toDimension = (v: number | undefined): string | undefined => {
  if (v === undefined) {
    return undefined;
  }

  return `${String(v)}px`;
};

export const ImageBlock: FC<{ field: AssistantField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  if (shouldHide) {
    return null;
  }

  const style: CSSProperties = {};
  const w = toDimension(field.width);
  const h = toDimension(field.height);

  if (w !== undefined) {
    style.width = w;
  }

  if (h !== undefined) {
    style.height = h;
  }

  const img = (
    <img
      src={field.src}
      alt={field.title ?? ''}
      style={Object.keys(style).length > 0 ? style : undefined}
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
