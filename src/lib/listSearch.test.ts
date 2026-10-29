import { describe, expect, it } from 'vitest';
import { searchItems } from './listSearch.js';

const ITEMS = [
  { label: 'Contacts (client_client)' },
  { label: 'Deals (deal_pipeline)', description: 'Pipeline' },
  { label: 'Déals (old_deals)' },
];

describe('searchItems', () => {
  it('matches every item, in order with its index, for an empty query', () => {
    expect(searchItems(ITEMS, '  ').map(({ index }) => index)).toStrictEqual([0, 1, 2]);
  });

  it('matches every word of the query in the label or description, ignoring case and accents', () => {
    expect(searchItems(ITEMS, 'DEALS').map(({ index }) => index)).toStrictEqual([1, 2]);
    expect(searchItems(ITEMS, 'deals pipe').map(({ index }) => index)).toStrictEqual([1]);
    expect(searchItems(ITEMS, 'client contacts').map(({ item }) => item)).toStrictEqual([ITEMS[0]]);
    expect(searchItems(ITEMS, 'nope')).toStrictEqual([]);
  });
});
