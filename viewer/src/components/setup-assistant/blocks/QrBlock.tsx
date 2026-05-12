import type { FC } from 'react';
import { useCallback, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { getQrCodeValue } from '@kizenapps/engine/util';
import type { IncludeOption } from '@kizenapps/engine';
import type { QrField } from '../../../lib/setupAssistantTypes.js';
import { useFieldBlock } from '../useFieldBlock.js';
import { useCredentials } from '../../../CredentialsContext.js';
import { LinkAnchor } from './LinkAnchor.js';
import { useBootstrap } from '../../../BootstrapContext.js';

export const QrBlock: FC<{ field: QrField }> = ({ field }) => {
  const { shouldHide } = useFieldBlock(field);
  const { businessId } = useCredentials();
  const bootstrap = useBootstrap();

  const getParam = useCallback(
    (key: IncludeOption): string => {
      switch (key) {
        case 'user_id':
          return bootstrap?.team.user ?? '';
        case 'business_id':
          return businessId;
        case 'email':
          return bootstrap?.team.email ?? '';
        case 'name':
          return bootstrap?.team.full_name ?? '';
        case 'base_url':
          return '';
      }
    },
    [businessId, bootstrap],
  );

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
      <LinkAnchor link={field.link} className="inline-block">
        {code}
      </LinkAnchor>
    );
  }

  return code;
};
