import type { Block } from '@kizenapps/packager';
import type { BlockConfig, UnknownJSON } from '@kizenapps/engine';
import { useCustomBlock } from '@kizenapps/engine/react';
import { getEnabledState } from '@kizenapps/engine/util';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage.js';
import { blockPreviewSizeKey } from '../lib/storageKeys.js';

// The dashboard grid is GRID_COLUMNS wide with SQUARE cells: row height equals
// column width. Both derive from the live stage width divided into GRID_COLUMNS,
// so a max_w of 12 fills the container and an N×N block renders as a square,
// exactly as on a real dashboard.
const GRID_COLUMNS = 12;

// Fallback grid constraints mirror PLUGIN_BLOCK_DEFAULT_DIMENSIONS in react-app,
// guarding against bundles that predate the dimension fields.
const FALLBACK_DIMENSIONS = { minW: 2, maxW: 12, minH: 2, maxH: 24 } as const;

// The packager's Block type only declares script + styles, but the engine (and
// react-app's PluginBlockDashlet) render blocks as script | html | iframe. Mirror
// that contract so html/iframe blocks preview correctly if a bundle includes them.
type RenderableBlock = Block & {
  type?: BlockConfig['type'];
  html?: string;
  iframe_url?: string;
};

interface PreviewSize {
  w: number;
  h: number;
}

interface PreviewBounds {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  cellSize: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const labelClass = 'text-[11px] font-semibold uppercase tracking-widest text-neutral-600';

// Translate a block's grid-unit constraints into pixel bounds for the preview.
// Both axes scale with the square cell size; height is capped at the viewport so
// a tall max_h can't run off the screen.
const computeBounds = (
  block: RenderableBlock,
  cellSize: number,
  maxHeightCap: number,
): PreviewBounds => {
  const minCols = block.min_w || FALLBACK_DIMENSIONS.minW;
  const maxCols = Math.min(block.max_w || FALLBACK_DIMENSIONS.maxW, GRID_COLUMNS);
  const minRows = block.min_h || FALLBACK_DIMENSIONS.minH;
  const maxRows = block.max_h || FALLBACK_DIMENSIONS.maxH;
  const minWidth = Math.round(minCols * cellSize);
  const maxWidth = Math.max(minWidth, Math.round(maxCols * cellSize));
  const minHeight = Math.round(minRows * cellSize);
  const maxHeight = clamp(
    Math.round(maxRows * cellSize),
    minHeight,
    Math.max(maxHeightCap, minHeight),
  );

  return { minWidth, maxWidth, minHeight, maxHeight, cellSize };
};

// Imperative surface exposed to PluginBlockView so the event-scripts controls row
// (which lives outside the resizable box, above this frame) can trigger the
// block's event scripts through the hook that owns the running block instance.
interface BlockFrameHandle {
  runEventScript: (scriptName: string) => void;
}

// Renders the block exactly as react-app's PluginBlockDashlet does, via
// useCustomBlock: styles map to css and, unlike useAppPage, the hook listens for
// the engine's runBlockScript communication event and exposes runEventScript so a
// block's named event_scripts can be invoked — the same path a sibling plugin
// hits with this.communicate.runBlockScript. Lives in its own component so the
// parent can remount it (via key) to re-run the block script.
const PluginBlockFrame = forwardRef<
  BlockFrameHandle,
  { block: BlockConfig; args: UnknownJSON; instanceId: string }
>(({ block, args, instanceId }, ref) => {
  const {
    scriptUIRef,
    outputUIRef,
    scopedCss,
    sanitizedHtml,
    interactableScriptRef,
    iframeURL,
    pending,
    runEventScript,
  } = useCustomBlock({ block, args, instanceId });

  useImperativeHandle(ref, () => ({ runEventScript }), [runEventScript]);

  const type = block.type ?? 'script';

  return (
    <div className="relative h-full w-full">
      {pending && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 font-mono text-[11px] text-neutral-400">
          loading…
        </div>
      )}

      {type === 'script' && (
        <>
          <div ref={scriptUIRef} className="h-full w-full overflow-auto" />
          <style>{scopedCss}</style>
        </>
      )}

      {type === 'html' && (
        <div ref={interactableScriptRef} className="h-full overflow-auto">
          {sanitizedHtml && <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />}
          <div ref={outputUIRef} />
          <style>{scopedCss}</style>
        </div>
      )}

      {type === 'iframe' && iframeURL && (
        <iframe src={iframeURL} className="h-full w-full border-0" title={block.name} />
      )}
    </div>
  );
});

PluginBlockFrame.displayName = 'PluginBlockFrame';

const SizePresetButton: FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    onClick={onClick}
    className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
      active
        ? 'bg-neutral-700 text-neutral-100'
        : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
    }`}
  >
    {label}
  </button>
);

const PluginBlockView: FC<{
  block: RenderableBlock;
  pluginApiName: string;
  configArgs: Record<string, unknown>;
  whenState: Record<string, UnknownJSON>;
}> = ({ block, pluginApiName, configArgs, whenState }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<BlockFrameHandle>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  const [reloadKey, setReloadKey] = useState(0);
  const [whenEnabled, setWhenEnabled] = useState<boolean | null>(null);

  // Responsive square cell size: the grid splits the stage into GRID_COLUMNS
  // columns, and rows are the same size, so cells are square.
  const cellSize = stageWidth > 0 ? stageWidth / GRID_COLUMNS : 0;

  const bounds = useMemo(
    () => computeBounds(block, cellSize, viewportHeight),
    [block, cellSize, viewportHeight],
  );

  // Persisted preview size in px (null = never resized → open at the block's
  // minimum). Stored absolute and re-clamped to the current bounds on read,
  // since the responsive column width can differ between sessions.
  const [storedSize, setStoredSize] = useLocalStorage<PreviewSize | null>(
    blockPreviewSizeKey(pluginApiName, block.api_name),
    null,
  );

  const appliedSize = useMemo(
    (): PreviewSize => ({
      w: storedSize ? clamp(storedSize.w, bounds.minWidth, bounds.maxWidth) : bounds.minWidth,
      h: storedSize ? clamp(storedSize.h, bounds.minHeight, bounds.maxHeight) : bounds.minHeight,
    }),
    [storedSize, bounds],
  );

  const [displaySize, setDisplaySize] = useState<PreviewSize>(appliedSize);

  // Measure the stage width before paint so the preview never flashes at the
  // wrong size, and keep it in sync as the surrounding layout changes.
  useLayoutEffect(() => {
    const el = stageRef.current;

    if (!el) {
      return;
    }

    const update = (): void => {
      setStageWidth(el.clientWidth);
    };

    update();

    const observer = new ResizeObserver(update);

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const onResize = (): void => {
      setViewportHeight(window.innerHeight);
    };

    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // Apply the size imperatively (as a layout effect, so the box is sized before
  // the block script runs) rather than via React-controlled width/height, which
  // the browser's native resize handle would fight and snap back on each render.
  useLayoutEffect(() => {
    const el = boxRef.current;

    if (!el) {
      return;
    }

    el.style.width = `${String(appliedSize.w)}px`;
    el.style.height = `${String(appliedSize.h)}px`;
    setDisplaySize(appliedSize);
  }, [appliedSize]);

  // Observe manual resizes: update the readout live; persistence is on pointer-up.
  useEffect(() => {
    const el = boxRef.current;

    if (!el) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) {
        return;
      }

      // Read the border-box size so it matches the border-box width/height the
      // effect above writes (Tailwind Preflight sets box-sizing: border-box
      // globally). contentRect reports the content box — smaller by the 2px
      // border — which would shrink the preview on every pointer-up.
      const boxSize = entry.borderBoxSize[0];
      const w = Math.round(boxSize?.inlineSize ?? entry.contentRect.width);
      const h = Math.round(boxSize?.blockSize ?? entry.contentRect.height);

      setDisplaySize({ w, h });
    });

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, []);

  const blockWhen = block.when;

  useEffect(() => {
    if (!blockWhen) {
      setWhenEnabled(null);

      return;
    }

    let cancelled = false;

    void getEnabledState(blockWhen, whenState)
      .then((enabled) => {
        if (!cancelled) {
          setWhenEnabled(enabled);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWhenEnabled(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [blockWhen, whenState]);

  const blockArgs = useMemo(() => configArgs as Record<string, UnknownJSON>, [configArgs]);

  // Build the engine's BlockConfig from the packager Block. plugin_api_name must
  // be present so useCustomBlock's runBlockScript listener can match this block as
  // the recipient of a sibling plugin's this.communicate.runBlockScript call.
  const blockConfig = useMemo(
    (): BlockConfig => ({
      plugin_api_name: pluginApiName,
      api_name: block.api_name,
      name: block.name,
      type: block.type ?? 'script',
      script: block.script,
      styles: block.styles,
      event_scripts: block.event_scripts,
      args: blockArgs,
      // Spread conditionally: exactOptionalPropertyTypes forbids passing an
      // explicit `undefined` to these optional fields.
      ...(block.html !== undefined ? { html: block.html } : {}),
      ...(block.iframe_url !== undefined ? { iframe_url: block.iframe_url } : {}),
    }),
    [block, pluginApiName, blockArgs],
  );

  // Worker key for the running block instance. Folding reloadKey in gives each
  // reload a fresh worker so the block script re-runs from a clean slate.
  const instanceId = `${pluginApiName}::${block.api_name}::${String(reloadKey)}`;

  const eventScriptNames = useMemo(() => Object.keys(block.event_scripts), [block.event_scripts]);

  // The frame (and therefore frameRef) only mounts once the stage is measured;
  // event-script triggers are dead until then, so disable them rather than let
  // clicks silently no-op.
  const frameReady = cellSize > 0;

  // Pointer-up fires on any click inside the preview, not only after a resize
  // drag. Only persist when the size actually changed to avoid redundant writes.
  const persistOnResizeEnd = (): void => {
    if (displaySize.w !== appliedSize.w || displaySize.h !== appliedSize.h) {
      setStoredSize(displaySize);
    }
  };

  const applyPreset = (size: PreviewSize): void => {
    setStoredSize({
      w: clamp(size.w, bounds.minWidth, bounds.maxWidth),
      h: clamp(size.h, bounds.minHeight, bounds.maxHeight),
    });
  };

  const surfaces = block.types ?? [];
  const approxCols = cellSize > 0 ? Math.max(1, Math.round(displaySize.w / cellSize)) : 0;
  const approxRows = cellSize > 0 ? Math.max(1, Math.round(displaySize.h / cellSize)) : 0;

  return (
    <div className="rounded border border-black/10 bg-white">
      {/* Metadata header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-black/8 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-neutral-900">{block.name}</div>
          <div className="truncate font-mono text-[11px] text-neutral-400">{block.api_name}</div>
        </div>
        {surfaces.map((surface) => (
          <span
            key={surface}
            className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600"
          >
            {surface}
          </span>
        ))}
        {blockWhen && (
          <span
            title={blockWhen}
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              whenEnabled === null
                ? 'bg-neutral-100 text-neutral-500'
                : whenEnabled
                  ? 'bg-green-100 text-green-700'
                  : 'bg-amber-100 text-amber-700'
            }`}
          >
            when {whenEnabled === null ? '?' : whenEnabled ? 'enabled' : 'disabled'}
          </span>
        )}
      </div>

      {/* Size controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-black/8 bg-neutral-50 px-3 py-2">
        <span className={labelClass}>Size</span>
        <div className="flex flex-wrap gap-1">
          <SizePresetButton
            label="Min"
            active={appliedSize.w === bounds.minWidth && appliedSize.h === bounds.minHeight}
            onClick={() => {
              applyPreset({ w: bounds.minWidth, h: bounds.minHeight });
            }}
          />
          <SizePresetButton
            label="Max"
            active={appliedSize.w === bounds.maxWidth && appliedSize.h === bounds.maxHeight}
            onClick={() => {
              applyPreset({ w: bounds.maxWidth, h: bounds.maxHeight });
            }}
          />
        </div>
        <span className="ml-auto font-mono text-[11px] text-neutral-400">
          {displaySize.w}×{displaySize.h}px ≈ {approxCols}×{approxRows} grid
        </span>
        <button
          onClick={() => {
            setReloadKey((k) => k + 1);
          }}
          className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600 transition-colors hover:bg-neutral-200"
          title="Re-run the block script"
        >
          reload
        </button>
      </div>

      {/* Event-script triggers. Each button fires the block's named event_script
          through the same runBlockScript path a sibling plugin uses, so a block's
          cross-plugin handlers can be exercised without a second plugin. */}
      {eventScriptNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-black/8 bg-neutral-50 px-3 py-2">
          <span className={labelClass}>Event scripts</span>
          <div className="flex flex-wrap gap-1">
            {eventScriptNames.map((name) => (
              <button
                key={name}
                disabled={!frameReady}
                onClick={() => frameRef.current?.runEventScript(name)}
                className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-[11px] font-medium text-neutral-600 transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-neutral-100"
                title={`Run the ${name} event script (via runBlockScript)`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Resizable preview surface. The checkerboard backdrop makes the block's
          bounds (and any transparency) visible; drag the bottom-right handle to
          resize within the declared grid constraints. */}
      <div
        className="p-3"
        style={{
          backgroundColor: '#fafafa',
          backgroundImage:
            'linear-gradient(45deg,#f0f0f0 25%,transparent 25%,transparent 75%,#f0f0f0 75%),linear-gradient(45deg,#f0f0f0 25%,transparent 25%,transparent 75%,#f0f0f0 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0,8px 8px',
        }}
      >
        <div ref={stageRef} className="flex justify-center">
          <div
            ref={boxRef}
            onPointerUp={persistOnResizeEnd}
            style={{
              minWidth: bounds.minWidth,
              maxWidth: bounds.maxWidth,
              minHeight: bounds.minHeight,
              maxHeight: bounds.maxHeight,
              resize: 'both',
            }}
            className="overflow-hidden rounded border border-black/10 bg-white shadow-sm"
          >
            {cellSize > 0 && (
              <PluginBlockFrame
                key={reloadKey}
                ref={frameRef}
                block={blockConfig}
                args={blockArgs}
                instanceId={instanceId}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const PluginBlockSection: FC<{
  blocks: Block[];
  pluginApiName: string;
  configArgs: Record<string, unknown>;
  whenState: Record<string, UnknownJSON>;
}> = ({ blocks, pluginApiName, configArgs, whenState }) => {
  if (blocks.length === 0) {
    return (
      <p className="text-[12px] text-neutral-400">No content blocks are defined in this plugin.</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block) => (
        <PluginBlockView
          key={block.api_name}
          block={block}
          pluginApiName={pluginApiName}
          configArgs={configArgs}
          whenState={whenState}
        />
      ))}
    </div>
  );
};
