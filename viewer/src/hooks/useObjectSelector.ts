import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../api.js';
import { useCredentials } from '../CredentialsContext.js';
import { useBootstrap } from '../BootstrapContext.js';
import { useLocalStorage } from './useLocalStorage.js';
import type { CustomObjectRecord, PaginatedResponse } from '../types.js';
import type { TypeaheadOption } from '../components/Typeahead.js';
import { SEARCH_DEBOUNCE_MS } from '../lib/constants.js';

export interface ObjectSelectorResult {
  selectedObject: { id: string; name: string } | null;
  setSelectedObject: (value: { id: string; name: string } | null) => void;
  objectSearch: string;
  setObjectSearch: (value: string) => void;
  objectsQuery: UseQueryResult<PaginatedResponse<CustomObjectRecord>>;
  objectOptions: TypeaheadOption[];
}

/**
 * Manages custom-object selection with localStorage persistence, debounced
 * search, and computed options (including the bootstrap client_object).
 *
 * @param storageKey - localStorage key for the selected object. Use a
 *   per-feature key so different sections on the same page can track
 *   independent selections.
 */
export function useObjectSelector(storageKey: string): ObjectSelectorResult {
  const request = useApi();
  const { apiKey, businessId } = useCredentials();
  const bootstrap = useBootstrap();

  const [selectedObject, setSelectedObject] = useLocalStorage<{
    id: string;
    name: string;
  } | null>(storageKey, null);
  const [objectSearch, setObjectSearch] = useState(() => selectedObject?.name ?? '');
  const [debouncedObjectSearch, setDebouncedObjectSearch] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedObjectSearch(objectSearch);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [objectSearch]);

  const objectsQuery = useQuery({
    queryKey: ['custom-objects', businessId, debouncedObjectSearch],
    queryFn: async () => {
      const params = new URLSearchParams({ page_size: '20' });

      if (debouncedObjectSearch) {
        params.set('search', debouncedObjectSearch);
      }

      const res = await request(`/custom-objects?${params.toString()}`);

      // Non-OK responses carry an error body with no `results`; fail the query
      // instead of letting the malformed shape reach consumers.
      if (!res.ok) {
        throw new Error(`Failed to fetch custom objects (${String(res.status)})`);
      }

      return (await res.json()) as PaginatedResponse<CustomObjectRecord>;
    },
    enabled: apiKey !== '' && debouncedObjectSearch.length >= 1,
    staleTime: 30_000,
  });

  const objectOptions: TypeaheadOption[] = (() => {
    const opts: TypeaheadOption[] =
      objectsQuery.data?.results.map((o) => ({ id: o.id, label: o.object_name })) ?? [];
    const co = bootstrap?.business.client_object;

    if (co?.access) {
      const matchesSearch =
        !debouncedObjectSearch ||
        co.object_name.toLowerCase().includes(debouncedObjectSearch.toLowerCase());

      if (matchesSearch) {
        opts.unshift({ id: co.id, label: co.object_name });
      }
    }

    return opts;
  })();

  return {
    selectedObject,
    setSelectedObject,
    objectSearch,
    setObjectSearch,
    objectsQuery,
    objectOptions,
  };
}
