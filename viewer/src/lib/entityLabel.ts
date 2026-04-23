interface EntityField {
  name: string;
  value: unknown;
}

interface EntityRecord {
  id: string;
  fields: Record<string, EntityField>;
}

function getFieldValue(fields: Record<string, EntityField>, fieldName: string): string {
  const field = Object.values(fields).find((f) => f.name === fieldName);

  return typeof field?.value === 'string' ? field.value : '';
}

export function getEntityLabel(entity: EntityRecord, isClientObject: boolean): string {
  if (isClientObject) {
    const firstName = getFieldValue(entity.fields, 'first_name');
    const lastName = getFieldValue(entity.fields, 'last_name');
    const email = getFieldValue(entity.fields, 'email');
    const name = [firstName, lastName].filter(Boolean).join(' ');

    return name ? `${name} (${email})` : email || entity.id;
  }

  const displayField = Object.values(entity.fields).find((f) => f.name === 'display_name');

  return typeof displayField?.value === 'string' ? displayField.value : entity.id;
}
