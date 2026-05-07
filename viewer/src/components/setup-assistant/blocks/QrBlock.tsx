import type { FC } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { QrField } from '../../../lib/setupAssistantTypes.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { LinkAnchor } from './LinkAnchor.js';

export const QrBlock: FC<{ field: QrField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  if (shouldHide) {
    return null;
  }

  const size = field.size ?? 128;
  const code = <QRCodeSVG value={field.value} size={size} />;

  if (field.link) {
    return (
      <LinkAnchor link={field.link} className="inline-block">
        {code}
      </LinkAnchor>
    );
  }

  return code;
};
