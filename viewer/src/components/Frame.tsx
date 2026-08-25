import type { FloatingFrameConfig } from '@kizenapps/engine';
import type { UnknownJSON } from '@kizenapps/engine';
import { useFloatingFrame } from '@kizenapps/engine/react';
import { getEnabledState } from '@kizenapps/engine/util';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSidebarWidth } from '../SidebarContext.js';
import { isKnownIconName } from './IconNameBadge.js';
import { floatingFramePositionKey } from '../lib/storageKeys.js';
import { Tooltip } from './Tooltip.js';

// Built once — constructing a Segmenter per render is needlessly expensive.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The first user-perceived character. Neither `value[0]` nor `[...value][0]`
// will do: the former splits surrogate pairs, and the latter splits grapheme
// clusters such as emoji ZWJ sequences and combining marks.
const firstGrapheme = (value: string): string | undefined => {
  for (const { segment } of GRAPHEMES.segment(value)) {
    return segment;
  }

  return undefined;
};

const FRAME_HEADER_SIZE = 36;
const DEFAULT_POSITION_GAP = 20;
const BASE_Z = 9000;

interface CircleTriggerProps {
  frameId: string;
  side: 'left' | 'right';
  color: string;
  zIndex: number;
  onClick: () => void;
  CustomIcon: (({ className }: { className?: string }) => ReactNode) | null;
  circleIcon: string;
  when?: string;
  whenEnabled?: boolean | null;
}

// Renders into the anchor div managed by SandboxPage so each trigger stacks independently
const CircleTrigger = ({
  frameId,
  side,
  color,
  zIndex,
  onClick,
  CustomIcon,
  circleIcon,
  when,
  whenEnabled,
}: CircleTriggerProps): ReactNode | null => {
  const anchorEl = document.getElementById(`${frameId}-trigger-${side}`);

  if (!anchorEl) {
    return null;
  }

  // A data-image CustomIcon supersedes the configured name, so only speak to
  // the name when the viewer is actually falling back to it. The other icon
  // surfaces flag an unknown name in amber; a coloured circle has nowhere to
  // put that, so the tooltip carries the signal instead.
  const iconName = CustomIcon ? '' : circleIcon;
  const title = !iconName
    ? 'Open frame'
    : isKnownIconName(iconName)
      ? `Open frame — icon: ${iconName}`
      : `Open frame — “${iconName}” is not a recognized icon name`;

  const dot =
    when && whenEnabled !== null && whenEnabled !== undefined ? (
      <Tooltip text={when}>
        <span
          className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${whenEnabled ? 'bg-green-500' : 'bg-amber-500'}`}
        />
      </Tooltip>
    ) : null;

  return createPortal(
    <button
      className="relative pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-black/10 shadow-lg"
      style={{ backgroundColor: color, zIndex }}
      onClick={onClick}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      title={title}
    >
      {CustomIcon ? (
        <CustomIcon className="h-6 w-6 rounded-full object-cover" />
      ) : (
        // A named icon is drawn by the Kizen app at runtime, so the viewer
        // shows a neutral initial rather than a stand-in glyph. The configured
        // name is in the button's tooltip.
        <span className="font-mono text-[11px] uppercase text-white">
          {firstGrapheme(iconName) ?? '▲'}
        </span>
      )}
      {dot}
    </button>,
    anchorEl,
  );
};

type FloatingFrameWithWhen = FloatingFrameConfig & { when?: string };

export const Frame = ({
  frame,
  framesEnabled,
  whenState,
}: {
  frame: FloatingFrameConfig;
  framesEnabled: boolean;
  whenState?: Record<string, UnknownJSON>;
}): ReactNode => {
  const id = `${frame.plugin_api_name}-${frame.api_name}`;
  const frameWhen = (frame as FloatingFrameWithWhen).when;
  const [whenEnabled, setWhenEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!frameWhen) {
      return;
    }

    void getEnabledState(frameWhen, whenState ?? {})
      .then(setWhenEnabled)
      .catch(() => {
        setWhenEnabled(null);
      });
  }, [frameWhen, whenState]);
  const sidebarWidth = useSidebarWidth();

  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      setViewportHeight(window.innerHeight);
    });

    ro.observe(document.body);

    return () => {
      ro.disconnect();
    };
  }, []);

  const {
    circleProps,
    parentProps,
    draggableProps,
    pending,
    indicator,
    outputUIRef,
    scopedCss,
    sanitizedHtml,
    interactableScriptRef,
    hideHeader,
    setMinimized,
    dragHandleClassName,
    isFixed,
    isCircle,
    minimized,
    height,
    dragging,
    frameOffset,
    scriptUIRef,
  } = useFloatingFrame({
    currentWindow: frame,
    pathname: '/sandbox',
    id,
    frameHeaderSize: FRAME_HEADER_SIZE,
    defaultPositionGap: DEFAULT_POSITION_GAP,
    viewportHeight,
    hiddenByModal: false,
  });

  const zIndex = BASE_Z + Math.max(0, frameOffset);

  const storageKey = floatingFramePositionKey(id);
  const savedPos = (() => {
    try {
      const saved = localStorage.getItem(storageKey);

      return saved ? (JSON.parse(saved) as { x: number; y: number }) : null;
    } catch {
      return null;
    }
  })();

  const nodeRef = useRef<HTMLDivElement>(null);
  const [localPos, setLocalPos] = useState(savedPos ?? draggableProps.position);
  const hasCustomPos = useRef(savedPos !== null);
  const draggablePos = draggableProps.position;

  useEffect(() => {
    if (!hasCustomPos.current) {
      setLocalPos({ x: draggablePos.x, y: draggablePos.y });
    }
  }, [draggablePos.x, draggablePos.y]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggableProps.disabled) {
        return;
      }

      const target = e.target as HTMLElement;

      if (!target.closest(`.${dragHandleClassName}`)) {
        return;
      }

      e.preventDefault();

      draggableProps.onStart();

      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const startX = localPos.x;
      const startY = localPos.y;

      const handleMove = (ev: PointerEvent): void => {
        setLocalPos({
          x: startX + ev.clientX - startClientX,
          y: startY + ev.clientY - startClientY,
        });
      };

      const handleUp = (ev: PointerEvent): void => {
        document.removeEventListener('pointermove', handleMove);

        document.removeEventListener('pointerup', handleUp);

        const finalPos = {
          x: startX + ev.clientX - startClientX,
          y: startY + ev.clientY - startClientY,
        };

        localStorage.setItem(storageKey, JSON.stringify(finalPos));

        hasCustomPos.current = true;

        draggableProps.onStop(ev, { node: nodeRef.current });
      };

      document.addEventListener('pointermove', handleMove);

      document.addEventListener('pointerup', handleUp);
    },
    [draggableProps, dragHandleClassName, localPos, storageKey],
  );

  return (
    <>
      {/* Circle trigger — portals into the anchor div managed by SandboxPage */}
      {isCircle && !circleProps.hidden && (
        <CircleTrigger
          frameId={id}
          side={circleProps.side}
          color={circleProps.circleColor}
          zIndex={zIndex}
          onClick={circleProps.onClick}
          CustomIcon={circleProps.CustomIcon}
          circleIcon={circleProps.circleIcon}
          {...(frameWhen ? { when: frameWhen, whenEnabled } : {})}
        />
      )}

      {/* Frame is always in the DOM — scriptUIRef.current must be non-null when the script
          first runs, because the engine writes to it synchronously via innerHTML. Hiding is
          done via CSS opacity/pointer-events, never by conditional rendering. */}
      <div
        ref={nodeRef}
        className={parentProps.className}
        style={{
          position: 'fixed',
          left: Math.min(localPos.x, window.innerWidth - sidebarWidth - (frame.width ?? 300)),
          top: localPos.y,
          width: frame.width ?? 300,
          zIndex,
          borderRadius: 6,
          overflow: 'hidden',
          border: '1px solid rgba(0,0,0,0.1)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
          backgroundColor: 'white',
          // CSS-based hiding so the DOM node (and scriptUIRef) stays mounted
          opacity: parentProps.hidden || !framesEnabled ? 0 : 1,
          pointerEvents: parentProps.hidden || !framesEnabled ? 'none' : 'auto',
        }}
        onPointerDown={handlePointerDown}
      >
        {/* Loading overlay */}
        {(pending || indicator === 'block') && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 font-mono text-[11px] text-neutral-400">
            loading…
          </div>
        )}

        {/* Header */}
        {!hideHeader && (
          <div
            className="flex select-none items-center border-b border-black/8"
            style={{
              height: FRAME_HEADER_SIZE,
              backgroundColor: frame.header_color ?? '#fafafa',
              color: frame.header_text_color ?? '#1a1a1a',
            }}
          >
            <div
              className={`${dragHandleClassName} flex h-full flex-1 items-center gap-2 overflow-hidden px-3 ${isFixed ? '' : 'cursor-grab active:cursor-grabbing'}`}
            >
              {!isFixed && <span className="shrink-0 font-mono text-[11px] opacity-30">⠿</span>}
              <span className="truncate font-mono text-[12px] font-medium">{frame.title}</span>
            </div>
            <button
              className="flex h-full shrink-0 items-center px-3 font-mono text-[11px] transition-colors hover:bg-black/5"
              onClick={() => {
                setMinimized(!minimized);
              }}
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              title={minimized ? 'Expand' : 'Collapse'}
            >
              {minimized ? '↑' : '↓'}
            </button>
          </div>
        )}

        {/* Content — scriptUIRef div always mounted regardless of minimized state */}
        <div
          style={{
            height: minimized ? 0 : height,
            overflow: 'hidden',
            transition: `height ${String(height * 0.0005)}s ease`,
          }}
        >
          {frame.type === 'script' && (
            <div
              className="h-full w-full"
              style={{
                pointerEvents: dragging || parentProps.hidden || !framesEnabled ? 'none' : 'auto',
              }}
            >
              <div className="h-full w-full" ref={scriptUIRef} />
              <style>{scopedCss}</style>
            </div>
          )}

          {frame.type === 'html' && sanitizedHtml && (
            <div
              ref={interactableScriptRef}
              className="overflow-auto bg-white"
              style={{
                height,
                pointerEvents: dragging || parentProps.hidden || !framesEnabled ? 'none' : 'auto',
              }}
            >
              <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
              <div ref={outputUIRef} />
              <style>{scopedCss}</style>
            </div>
          )}

          {frame.type === 'iframe' && (
            <div
              className="h-full w-full"
              style={{
                pointerEvents: dragging || parentProps.hidden || !framesEnabled ? 'none' : 'auto',
              }}
            >
              <div className="h-full w-full" ref={scriptUIRef} />
            </div>
          )}
        </div>
      </div>
    </>
  );
};
