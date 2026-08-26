import type { FC } from 'react';
import { VALID_ICONS, CUSTOM_ICON_NAMES } from '@shared/lib/validIcons.js';

const MAX_WIDTH = 'max-w-[14ch]';

export const isKnownIconName = (name: string): boolean =>
  VALID_ICONS.has(name) || CUSTOM_ICON_NAMES.has(name);

export const IconNameBadge: FC<{ name: string; className?: string }> = ({
  name,
  className = '',
}) => (
  <span
    className={`inline-block ${MAX_WIDTH} truncate rounded px-1 align-middle font-mono ${
      isKnownIconName(name) ? 'bg-neutral-100 text-neutral-400' : 'bg-amber-100 text-amber-600'
    } ${className}`}
    title={
      isKnownIconName(name)
        ? `Icon “${name}” — rendered by the Kizen app at runtime`
        : `“${name}” is not a recognized icon name`
    }
  >
    {name}
  </span>
);
