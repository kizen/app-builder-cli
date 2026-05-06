import type { FC } from 'react';
import QRCode from 'react-qr-code';
import type { QrField } from '../../../lib/setupAssistantTypes.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { LinkAnchor } from './LinkAnchor.js';

export const QrBlock: FC<{ field: QrField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  if (shouldHide) {
    return null;
  }

  const size = field.size ?? 128;
  const code = <QRCode value={field.value} size={size} />;

  if (field.link) {
    return (
      <LinkAnchor link={field.link} className="inline-block">
        {code}
      </LinkAnchor>
    );
  }

  return code;
};
