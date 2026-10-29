export interface SearchableItem {
  label: string;
  description?: string;
}

export function searchItems<T extends SearchableItem>(
  items: readonly T[],
  query: string,
): { item: T; index: number }[] {
  const fold = (text: string): string =>
    text
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);

  return items.flatMap((item, index) => {
    const text = fold(`${item.label} ${item.description ?? ''}`);

    return words.every((word) => text.includes(word)) ? [{ item, index }] : [];
  });
}
