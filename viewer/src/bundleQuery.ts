import type { BundlePlugin } from './types.js';

export const bundleQueryOptions = {
  queryKey: ['bundle'] as const,
  queryFn: async (): Promise<BundlePlugin[]> => {
    const res = await fetch('/api/bundle');

    if (!res.ok) {
      throw new Error('Failed to fetch bundle.json');
    }

    return res.json() as Promise<BundlePlugin[]>;
  },
};
