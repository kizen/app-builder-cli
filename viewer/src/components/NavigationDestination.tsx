import { useCallback, useState, type FC } from 'react';
import {
  clearNavigationContext,
  consumeNavigationContext,
  readNavigationContext,
} from '@kizenapps/engine';
import { byteSizeOf, markNavigationEvent } from '../lib/navigationContext.js';

// Rendered in place of the browser's "Page not found" panel when an unmatched
// url carries a valid navigation-context key: a stand-in for the real Kizen page
// the plugin navigated to, letting the developer inspect and consume the payload
// exactly as the engine reader helpers would on the destination.
export const NavigationDestination: FC<{ url: string; sessionDataKey: string }> = ({
  url,
  sessionDataKey,
}) => {
  const [context, setContext] = useState<Record<string, unknown> | undefined>(() =>
    readNavigationContext(url),
  );
  const [touched, setTouched] = useState(false);

  const reread = useCallback(() => {
    setContext(readNavigationContext(url));
  }, [url]);

  const consume = useCallback(() => {
    consumeNavigationContext(url);
    markNavigationEvent(sessionDataKey, 'consumed');
    setContext(undefined);
    setTouched(true);
  }, [url, sessionDataKey]);

  const clear = useCallback(() => {
    clearNavigationContext(url);
    markNavigationEvent(sessionDataKey, 'cleared');
    setContext(undefined);
    setTouched(true);
  }, [url, sessionDataKey]);

  return (
    <div className="flex flex-col gap-3 p-6 font-mono text-[11px]">
      <div className="text-neutral-400">{url}</div>
      <div className="text-[13px] font-medium text-neutral-700">
        Simulated Kizen destination page
      </div>
      <div className="text-neutral-400">
        Not a routable page in this plugin — this stands in for the Kizen page the plugin navigated
        to, so you can inspect the navigation context it received.
      </div>

      {context ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-neutral-500">
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 uppercase tracking-widest text-[9px] text-neutral-500">
              context
            </span>
            <span>{byteSizeOf(context)} bytes</span>
          </div>
          <pre className="overflow-auto rounded border border-black/10 bg-neutral-50 p-2 text-[11px] leading-5 text-neutral-700">
            {JSON.stringify(context, null, 2)}
          </pre>
        </div>
      ) : (
        <div className="rounded border border-black/8 bg-neutral-50 px-2 py-1.5 text-neutral-500">
          {touched
            ? 'context cleared — a re-visit or back-nav would see no context'
            : 'no context found for this key'}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={consume}
          disabled={!context}
          className="rounded border border-black/10 bg-white px-2 py-1 text-neutral-700 transition-colors hover:bg-black/5 disabled:opacity-40"
        >
          Consume
        </button>
        <button
          onClick={clear}
          disabled={!context}
          className="rounded border border-black/10 bg-white px-2 py-1 text-neutral-700 transition-colors hover:bg-black/5 disabled:opacity-40"
        >
          Clear
        </button>
        <button
          onClick={reread}
          className="rounded border border-black/10 bg-white px-2 py-1 text-neutral-700 transition-colors hover:bg-black/5"
        >
          Re-read
        </button>
      </div>
    </div>
  );
};
