import type { Block } from '@kizenapps/packager';

// Fallback grid constraints mirror PLUGIN_BLOCK_DEFAULT_DIMENSIONS in react-app
// (getDashletConstraints, area: 'plugin'), guarding against bundles that predate
// the dimension fields.
export const BLOCK_FALLBACK_DIMENSIONS = { minW: 2, maxW: 12, minH: 2, maxH: 24 } as const;

export interface BlockGridDimensions {
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

// The packager type declares min_w/max_w/min_h/max_h as required, but bundles
// built before the dimension fields existed can omit them at runtime — fall
// back per field, exactly as react-app does for missing block constraints.
export const resolveBlockDimensions = (
  block: Pick<Block, 'min_w' | 'max_w' | 'min_h' | 'max_h'>,
): BlockGridDimensions => ({
  minW: block.min_w || BLOCK_FALLBACK_DIMENSIONS.minW,
  maxW: block.max_w || BLOCK_FALLBACK_DIMENSIONS.maxW,
  minH: block.min_h || BLOCK_FALLBACK_DIMENSIONS.minH,
  maxH: block.max_h || BLOCK_FALLBACK_DIMENSIONS.maxH,
});
