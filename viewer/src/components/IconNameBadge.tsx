import type { FC } from 'react';
import { VALID_ICONS, CUSTOM_ICON_NAMES } from '@shared/lib/validIcons.js';

// Names run from 3 to 30 characters (floppy-disk-circle-arrow-right). Capping
// the badge keeps a long name from stretching the row it sits in — three
// quarters of the valid names fit inside this without truncating, and the
// title attribute always carries the full name.
const MAX_WIDTH = 'max-w-[14ch]';

export const isKnownIconName = (name: string): boolean =>
  VALID_ICONS.has(name) || CUSTOM_ICON_NAMES.has(name);

/**
 * Shows the icon *name* a plugin configured, never a glyph.
 *
 * The viewer deliberately does not preview icon artwork: the appearance of a
 * named icon is decided by the Kizen app at runtime, and the icon set it draws
 * from is not redistributable. Rendering the name (amber when it is not a
 * recognized icon) is the useful signal for a plugin author anyway.
 */
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
