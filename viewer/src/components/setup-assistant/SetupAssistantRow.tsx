import type { FC } from 'react';
import type { AssistantField } from '@kizenapps/engine';
import { BooleanBlock } from './blocks/BooleanBlock.js';
import { ContainerBlock } from './blocks/ContainerBlock.js';
import { CustomObjectBlock } from './blocks/CustomObjectBlock.js';
import { DescriptionBlock } from './blocks/DescriptionBlock.js';
import { FieldBlock } from './blocks/FieldBlock.js';
import { ImageBlock } from './blocks/ImageBlock.js';
import { LinkBlock } from './blocks/LinkBlock.js';
import { NumberBlock } from './blocks/NumberBlock.js';
import { QrBlock } from './blocks/QrBlock.js';
import { SelectBlock } from './blocks/SelectBlock.js';
import { TextBlock } from './blocks/TextBlock.js';

interface BlockProps {
  field: AssistantField;
  pluginApiName: string;
  disabled?: boolean;
}

const fieldTypeComponents: Record<AssistantField['type'], FC<BlockProps>> = {
  container: ContainerBlock,
  custom_object: CustomObjectBlock,
  field: FieldBlock,
  text: TextBlock,
  description: DescriptionBlock,
  number: NumberBlock,
  select: SelectBlock,
  boolean: BooleanBlock,
  qr: QrBlock,
  image: ImageBlock,
  link: LinkBlock,
};

export const SetupAssistantRow: FC<{
  field: AssistantField;
  pluginApiName: string;
  disabled?: boolean;
}> = ({ field, pluginApiName, disabled = false }) => {
  const FieldComponent = fieldTypeComponents[field.type];

  return <FieldComponent field={field} pluginApiName={pluginApiName} disabled={disabled} />;
};
