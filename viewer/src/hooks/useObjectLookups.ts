import { useCallback } from 'react';
import { useApi } from '../api.js';
import { useBootstrap } from '../BootstrapContext.js';

interface ObjectMatch {
  id: string;
  object_name: string;
}

interface ObjectDetails {
  id: string;
  objectName: string;
  fields: { id: string; name: string; displayName: string }[];
}

export const useObjectLookups = (): {
  getObjectByAPIName: (objectApiName: string) => Promise<ObjectMatch[] | undefined>;
  getCustomObjectDetails: (objectId: string) => Promise<ObjectDetails>;
} => {
  const request = useApi();
  const bootstrap = useBootstrap();

  const getObjectByAPIName = useCallback(
    async (objectApiName: string) => {
      try {
        const res = await request(
          `/api/custom-objects?filters=${encodeURIComponent(JSON.stringify({ api_name: objectApiName }))}`,
        );
        const data = (await res.json()) as
          | { results?: { id: string; object_name: string }[] }
          | { id: string; object_name: string }[];
        const results = Array.isArray(data) ? data : data.results;

        if (results && results.length > 0) {
          return results;
        }
      } catch {
        // fall through to client object check
      }

      const co = bootstrap?.business.client_object;

      if (co?.access && co.name === objectApiName) {
        return [{ id: co.id, object_name: co.object_name }];
      }

      return undefined;
    },
    [request, bootstrap],
  );

  const getCustomObjectDetails = useCallback(
    async (objectId: string) => {
      try {
        const [objRes, fieldsRes] = await Promise.all([
          request(`/api/custom-objects/${objectId}`),
          request(`/api/custom-objects/${objectId}/fields`),
        ]);
        const objData = (await objRes.json()) as { object_name?: string };
        const fieldsData = (await fieldsRes.json()) as
          | { results?: { id: string; name: string; display_name: string }[] }
          | { id: string; name: string; display_name: string }[];
        const fields = Array.isArray(fieldsData) ? fieldsData : (fieldsData.results ?? []);

        return {
          id: objectId,
          objectName: objData.object_name ?? '',
          fields: fields.map((f) => ({
            id: f.id,
            name: f.name,
            displayName: f.display_name,
          })),
        };
      } catch {
        return { id: objectId, objectName: '', fields: [] };
      }
    },
    [request],
  );

  return { getObjectByAPIName, getCustomObjectDetails };
};
