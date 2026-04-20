import { type FC } from 'react';
import { Dialog, DialogHeader } from './Dialog.js';

export interface CriticalExceptionContext {
  workerName?: string;
  pluginApiName?: string;
}

export interface CriticalExceptionState {
  visible: boolean;
  error?: Error;
  context?: CriticalExceptionContext;
}

interface CriticalExceptionDialogProps {
  state: CriticalExceptionState;
  onDismiss: () => void;
}

export const CriticalExceptionDialog: FC<CriticalExceptionDialogProps> = ({ state, onDismiss }) => {
  const message = state.error?.message ?? 'Unknown error';
  const workerName = state.context?.workerName;
  const pluginApiName = state.context?.pluginApiName;

  return (
    <Dialog
      open={state.visible}
      size="xl"
      ariaModal
      fontMono={false}
      onBackdropClick={onDismiss}
      header={<DialogHeader title="Critical Exception" statusDot="red" />}
      footer={
        <button
          onClick={onDismiss}
          className="rounded bg-neutral-900 px-3 py-1.5 text-[12px] text-white transition-colors hover:bg-neutral-700"
        >
          Dismiss
        </button>
      }
    >
      <div className="px-5 py-4">
        <p className="m-0 mb-3 text-[12px] leading-relaxed text-neutral-700">
          This error will be logged in Kizen&apos;s monitoring stack. Did you mean to throw it, or
          would you prefer to handle the error in your application code with a toast or other
          messaging?
        </p>

        {(workerName ?? pluginApiName) && (
          <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-neutral-600">
            {workerName && (
              <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono">
                worker: {workerName}
              </span>
            )}
            {pluginApiName && (
              <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono">
                plugin: {pluginApiName}
              </span>
            )}
          </div>
        )}

        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Error
        </div>

        <div className="whitespace-pre-wrap break-words rounded border border-black/10 bg-neutral-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-amber-300">
          {message}
        </div>
      </div>
    </Dialog>
  );
};
