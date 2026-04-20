import { useEffect, useState, type FC, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface DropdownPortalProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Renders children into a fixed-position portal anchored below (or above) a
 * reference element. Because it portals to `document.body`, the dropdown is
 * never clipped by ancestor `overflow` or `max-height` rules.
 */
export const DropdownPortal: FC<DropdownPortalProps> = ({
  anchorRef,
  open,
  children,
  className,
}) => {
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }

    const update = (): void => {
      const el = anchorRef.current;

      if (!el) {
        return;
      }

      const rect = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const maxH = 192; // max-h-48 = 12rem = 192px
      const gap = 4;

      // Flip above the anchor if not enough room below
      if (spaceBelow < maxH + gap && rect.top > spaceBelow) {
        setStyle({
          position: 'fixed',
          zIndex: 999999,
          left: rect.left,
          width: rect.width,
          bottom: window.innerHeight - rect.top + gap,
          maxHeight: maxH,
        });
      } else {
        setStyle({
          position: 'fixed',
          zIndex: 999999,
          left: rect.left,
          width: rect.width,
          top: rect.bottom + gap,
          maxHeight: maxH,
        });
      }
    };

    update();

    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);

    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchorRef]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      style={style}
      className={`overflow-auto rounded border border-black/10 bg-white font-mono shadow-lg ${className ?? ''}`}
      onMouseDown={(e) => {
        // Prevent blur on the input so the dropdown stays interactive,
        // and stop propagation so document-level click-outside handlers
        // don't treat portal clicks as "outside".
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {children}
    </div>,
    document.body,
  );
};
