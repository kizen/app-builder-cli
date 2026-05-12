import type { FC } from 'react';
import { useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { getQrCodeValue } from '@kizenapps/engine/util';
import type { QrField } from '../../../lib/setupAssistantTypes.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { LinkAnchor } from './LinkAnchor.js';
import { useAuthParams } from './util.js';

export const QrBlock: FC<{ field: QrField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);

  const getParam = useAuthParams();

  const qrValue = useMemo(
    () => getQrCodeValue(field.value, field.include, getParam),
    [field.value, field.include, getParam],
  );

  if (shouldHide) {
    return null;
  }

  const size = field.size ?? 128;
  const code = <QRCodeSVG value={qrValue} size={size} />;

  if (field.link) {
    return (
      <div className="flex justify-center">
        <LinkAnchor link={field.link} className="inline-block">
          {code}
        </LinkAnchor>
      </div>
    );
  }

  return <div className="flex justify-center">{code}</div>;
};
