export const FIELDS = [
  'name',
  'apiName',
  'externalLink',
  'description',
  'developerBusinessId',
] as const;

export type FieldName = (typeof FIELDS)[number];

export const FIELD_LABELS: Record<FieldName, string> = {
  name: 'Name',
  apiName: 'API name',
  externalLink: 'External link',
  description: 'Description',
  developerBusinessId: 'Business ID',
};

export const REQUIRED_FIELDS: readonly FieldName[] = ['name', 'apiName'];

export type FieldValues = Record<FieldName, string>;

export function inferApiName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function emptyValues(defaultBusinessId: string): FieldValues {
  return {
    name: '',
    apiName: '',
    externalLink: '',
    description: '',
    developerBusinessId: defaultBusinessId,
  };
}

export function validateField(fieldName: FieldName, inputBuffer: string): string | undefined {
  if (REQUIRED_FIELDS.includes(fieldName) && !inputBuffer.trim()) {
    return `${FIELD_LABELS[fieldName]} is required`;
  }

  return undefined;
}

export function normalizeFieldValue(fieldName: FieldName, inputBuffer: string): string {
  return fieldName === 'description' ? inputBuffer : inputBuffer.trim();
}
