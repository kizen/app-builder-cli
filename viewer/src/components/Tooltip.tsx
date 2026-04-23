import { useState, type FC, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  text: string;
  children: ReactNode;
}

export const Tooltip: FC<TooltipProps> = ({ text, children }) => {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <span
        onMouseEnter={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();

          setPos({ x: rect.left, y: rect.top });
        }}
        onMouseLeave={() => {
          setPos(null);
        }}
      >
        {children}
      </span>
      {pos &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 max-w-xs break-all rounded bg-neutral-700 px-2 py-1 text-[11px] text-neutral-100 shadow-lg"
            style={{ left: pos.x, top: pos.y, transform: 'translateY(calc(-100% - 4px))' }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
};
