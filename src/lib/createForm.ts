import { ARTIFACT_TYPES } from './createArtifacts.js';
import type { ArtifactType } from './createArtifacts.js';

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

export const REQUIRED_FIELDS: readonly FieldName[] = ['name', 'apiName', 'description'];

export type FieldValues = Record<FieldName, string>;

export const API_NAME_PATTERN = /^[a-z_][a-z0-9_]+$/;

export const API_NAME_HINT =
  'must start with a letter or underscore and contain only lowercase letters, numbers, or underscores (minimum 2 characters)';

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
  const value = inputBuffer.trim();

  if (REQUIRED_FIELDS.includes(fieldName) && !value) {
    return `${FIELD_LABELS[fieldName]} is required`;
  }

  if (fieldName === 'apiName' && !API_NAME_PATTERN.test(value)) {
    return `${FIELD_LABELS[fieldName]} ${API_NAME_HINT}`;
  }

  return undefined;
}

export function normalizeFieldValue(fieldName: FieldName, inputBuffer: string): string {
  return fieldName === 'description' ? inputBuffer : inputBuffer.trim();
}

export function toggleArtifactSelection(
  selected: readonly ArtifactType[],
  type: ArtifactType,
): ArtifactType[] {
  const next = new Set(selected);

  if (next.has(type)) {
    next.delete(type);
  } else {
    next.add(type);
  }

  return ARTIFACT_TYPES.filter((candidate) => next.has(candidate));
}
