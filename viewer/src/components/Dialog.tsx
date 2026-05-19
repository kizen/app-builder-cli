import { useEffect, useRef, type FC, type ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
  xl: 'max-w-2xl',
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  open: boolean;
  onBackdropClick?: (() => void) | undefined;
  size?: DialogSize | undefined;
  // Exact pixel max-width override. When set, takes precedence over `size`.
  maxWidth?: number | string | undefined;
  // CSS height for the panel (e.g. '75vh'). When set, the panel becomes a flex
  // column at that exact height — children must use flex-1 / overflow to scroll.
  height?: string | undefined;
  ariaModal?: boolean | undefined;
  fontMono?: boolean | undefined;
  header?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  children: ReactNode;
}

export const Dialog: FC<DialogProps> = ({
  open,
  onBackdropClick,
  size = 'md',
  maxWidth,
  height,
  ariaModal = true,
  fontMono = true,
  header,
  footer,
  children,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  // Store the close handler in a ref so the focus-trap effect doesn't re-run
  // (and re-steal focus) every render when callers pass an inline function.
  const onCloseRef = useRef(onBackdropClick);

  useEffect(() => {
    onCloseRef.current = onBackdropClick;
  }, [onBackdropClick]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = contentRef.current;

    if (root === null) {
      return;
    }

    const firstFocusable = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);

    (firstFocusable ?? root).focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCloseRef.current?.();

        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);

      if (focusable.length === 0) {
        event.preventDefault();

        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (first === undefined || last === undefined) {
        return;
      }

      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);

      // Only restore focus if the caller hasn't already moved it somewhere
      // else between close and this cleanup.
      if (document.activeElement === document.body || root.contains(document.activeElement)) {
        previouslyFocused?.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal={ariaModal || undefined}
      className="fixed inset-0 z-[99999] flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-12"
      onClick={onBackdropClick}
    >
      <div
        ref={contentRef}
        tabIndex={-1}
        className={`w-full ${maxWidth === undefined ? SIZE_CLASS[size] : ''} rounded-lg border border-black/10 bg-white ${fontMono ? 'font-mono' : ''} shadow-xl focus:outline-none${height ? ' flex flex-col overflow-hidden' : ''}`}
        style={{
          ...(height ? { height } : null),
          ...(maxWidth !== undefined
            ? { maxWidth: typeof maxWidth === 'number' ? `${String(maxWidth)}px` : maxWidth }
            : null),
        }}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {header}
        {children}
        {footer != null && (
          <div className="flex justify-end gap-2 border-t border-black/8 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
};

export type DialogStatusDot = 'red' | 'green' | 'blue-pulse';

const DOT_CLASS: Record<DialogStatusDot, string> = {
  red: 'bg-red-500',
  green: 'bg-green-500',
  'blue-pulse': 'bg-blue-500 animate-pulse',
};

interface DialogHeaderProps {
  title: string;
  statusDot?: DialogStatusDot | undefined;
  onClose?: (() => void) | undefined;
}

export const DialogHeader: FC<DialogHeaderProps> = ({ title, statusDot, onClose }) => {
  const hasLeftIndicator = statusDot !== undefined;
  const hasRightControl = onClose !== undefined;

  const layoutClass = hasRightControl
    ? 'flex items-center justify-between'
    : hasLeftIndicator
      ? 'flex items-center gap-2'
      : '';

  return (
    <div className={`${layoutClass} border-b border-black/8 px-5 py-3`}>
      {hasLeftIndicator && <span className={`h-2 w-2 rounded-full ${DOT_CLASS[statusDot]}`} />}
      <span className="text-[13px] font-semibold text-neutral-900">{title}</span>
      {hasRightControl && (
        <button
          onClick={onClose}
          className="text-[12px] text-neutral-400 hover:text-neutral-700"
          aria-label="Close"
        >
          <FontAwesomeIcon icon={faXmark} />
        </button>
      )}
    </div>
  );
};
