import type { BundlePlugin } from './types.js';

export const bundleQueryOptions = {
  queryKey: ['bundle'] as const,
  queryFn: async (): Promise<BundlePlugin[]> => {
    const res = await fetch('/api/bundle');

    if (!res.ok) {
      throw new Error('Failed to fetch bundle.json');
    }

    const json = (await res.json()) as unknown;

    // /api/bundle serves `{}` when no bundle has been built; normalize here so
    // every consumer can treat the data as an array.
    return Array.isArray(json) ? (json as BundlePlugin[]) : [];
  },
};
