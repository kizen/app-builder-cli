/** An item a list can search: by its label, and its description when it has one. */
export interface SearchableItem {
  label: string;
  description?: string;
}

/**
 * The items that match `query`, each with its index in `items`: those whose label or description
 * contains every word of it, ignoring case and accents. An empty query matches every item.
 */
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
