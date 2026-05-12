import type { AssistantField, IncludeOption } from '@kizenapps/engine';

export interface LinkField {
  key: string;
  type: 'link';
  text?: string;
  href: string;
  target?: '_blank';
  when?: string;
  include?: IncludeOption[] | undefined;
}

export interface ImageField {
  key: string;
  type: 'image';
  src: string;
  title?: string;
  link?: LinkField;
  width?: number | string;
  height?: number | string;
  when?: string;
  include?: IncludeOption[] | undefined;
}

export interface QrField {
  key: string;
  type: 'qr';
  value: string;
  size?: number;
  include?: IncludeOption[] | undefined;
  link?: LinkField;
  when?: string;
}

export type ExtendedAssistantField = AssistantField | LinkField | ImageField | QrField;
