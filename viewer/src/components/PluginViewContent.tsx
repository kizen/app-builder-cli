import { forwardRef, useMemo, type CSSProperties } from 'react';
import type { RoutablePageConfig, UnknownJSON } from '@kizenapps/engine';
import {
  useAppPage,
  useRegisterFormDataCollection,
  type ModalCustomContentHandle,
} from '@kizenapps/engine/react';

export const usePluginView = (
  pages: RoutablePageConfig[] | undefined,
  viewApiName: string | undefined,
  args?: UnknownJSON,
): RoutablePageConfig | undefined =>
  useMemo(() => {
    if (!pages || !viewApiName) {
      return undefined;
    }

    const found = pages.find((p) => p.api_name === viewApiName);

    if (!found || !args) {
      return found;
    }

    return { ...found, args: { ...found.args, ...args } } as RoutablePageConfig;
  }, [pages, viewApiName, args]);

interface PluginViewContentProps {
  page: RoutablePageConfig | undefined;
  isLoading?: boolean | undefined;
  className?: string | undefined;
  contentClassName?: string | undefined;
  iframeAllow?: string | undefined;
  style?: CSSProperties | undefined;
}

export const PluginViewContent = forwardRef<ModalCustomContentHandle, PluginViewContentProps>(
  ({ page, isLoading = false, className = '', contentClassName = '', iframeAllow, style }, ref) => {
    const {
      scriptUIRef,
      outputUIRef,
      scopedCss,
      sanitizedHtml,
      interactableScriptRef,
      iframeURL,
      pending,
      collectFormData,
    } = useAppPage(page, undefined, isLoading);

    useRegisterFormDataCollection(ref, collectFormData);

    return (
      <div className={`relative ${className}`} style={style}>
        {(isLoading || pending) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 font-mono text-[11px] text-neutral-400">
            loading…
          </div>
        )}

        {page?.type === 'script' && (
          <>
            <div ref={scriptUIRef} className={`h-full w-full overflow-auto ${contentClassName}`} />
            <style>{scopedCss}</style>
          </>
        )}

        {page?.type === 'html' && (
          <div ref={interactableScriptRef} className={`h-full overflow-auto ${contentClassName}`}>
            {sanitizedHtml && (
              <div className="h-full" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
            )}
            <div ref={outputUIRef} />
            <style>{scopedCss}</style>
          </div>
        )}

        {page?.type === 'iframe' && iframeURL && (
          <iframe
            src={iframeURL}
            className="h-full w-full border-0"
            title={page.name}
            allow={iframeAllow}
          />
        )}
      </div>
    );
  },
);

PluginViewContent.displayName = 'PluginViewContent';
