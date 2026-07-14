import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../api.js';
import { useCredentials } from '../CredentialsContext.js';
import { useBootstrap } from '../BootstrapContext.js';
import { useLocalStorage } from './useLocalStorage.js';
import { useObjectSelector } from './useObjectSelector.js';
import type { ObjectSelectorResult } from './useObjectSelector.js';
import { getEntityLabel } from '../lib/entityLabel.js';
import type { EntityRecord, PaginatedResponse } from '../types.js';
import type { TypeaheadOption } from '../components/Typeahead.js';
import { SEARCH_DEBOUNCE_MS } from '../lib/constants.js';
import { sandboxSelectedEntityKey, sandboxSelectedObjectKey } from '../lib/storageKeys.js';

export interface EntitySelectorResult extends ObjectSelectorResult {
  selectedEntity: { id: string; label: string } | null;
  setSelectedEntity: (value: { id: string; label: string } | null) => void;
  entitySearch: string;
  setEntitySearch: (value: string) => void;
  entitiesQuery: UseQueryResult<PaginatedResponse<EntityRecord>>;
  entityOptions: TypeaheadOption[];
}

/**
 * Extends `useObjectSelector` with entity (record) selection.
 *
 * Both DataAdornmentSection and JsActionSection share the same selectedObject
 * key (see `sandboxSelectedObjectKey` in `lib/storageKeys.ts`) so they reflect
 * the same context when shown together on SandboxPage.
 *
 * Pass `variant` to namespace the storage keys when a caller needs a second,
 * independent selection on the same page (e.g. the "action record" pair used
 * to drive `actionEntity()` in JsActionSection).
 */
export function useEntitySelector(pluginApiName: string, variant = ''): EntitySelectorResult {
  const objectSelector = useObjectSelector(sandboxSelectedObjectKey(pluginApiName, variant));
  const { selectedObject } = objectSelector;

  const request = useApi();
  const { apiKey } = useCredentials();
  const bootstrap = useBootstrap();

  const [selectedEntity, setSelectedEntity] = useLocalStorage<{
    id: string;
    label: string;
  } | null>(sandboxSelectedEntityKey(pluginApiName, variant), null);
  const [entitySearch, setEntitySearch] = useState(() => selectedEntity?.label ?? '');
  const [debouncedEntitySearch, setDebouncedEntitySearch] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedEntitySearch(entitySearch);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [entitySearch]);

  const entitiesQuery = useQuery({
    queryKey: ['entity-records', selectedObject?.id, debouncedEntitySearch],
    queryFn: async () => {
      const params = new URLSearchParams({ page_size: '20' });

      if (debouncedEntitySearch) {
        params.set('search', debouncedEntitySearch);
      }

      const objectId = selectedObject?.id ?? '';
      const res = await request(`/records/${objectId}/search?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      // Non-OK responses (e.g. a 403 for an object this API key can't read)
      // carry an error body with no `results`; fail the query instead of
      // letting the malformed shape reach consumers.
      if (!res.ok) {
        throw new Error(`Failed to search records (${String(res.status)})`);
      }

      return (await res.json()) as PaginatedResponse<EntityRecord>;
    },
    enabled: apiKey !== '' && selectedObject !== null,
    staleTime: 30_000,
  });

  const isClientObject = selectedObject?.id === bootstrap?.business.client_object?.id;
  const entityOptions: TypeaheadOption[] =
    entitiesQuery.data?.results.map((e) => ({
      id: e.id,
      label: getEntityLabel(e, isClientObject),
    })) ?? [];

  return {
    ...objectSelector,
    selectedEntity,
    setSelectedEntity,
    entitySearch,
    setEntitySearch,
    entitiesQuery,
    entityOptions,
  };
}
