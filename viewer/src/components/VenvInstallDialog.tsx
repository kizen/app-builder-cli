import { useEffect, useRef, type FC } from 'react';
import type { VenvInstallState } from '../useDevReload.js';
import { Dialog, DialogHeader, type DialogStatusDot } from './Dialog.js';

interface VenvInstallDialogProps {
  state: VenvInstallState;
  onDismiss: () => void;
}

export const VenvInstallDialog: FC<VenvInstallDialogProps> = ({ state, onDismiss }) => {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;

    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.logs]);

  const heading =
    state.status === 'complete'
      ? 'Environment ready'
      : state.status === 'error'
        ? 'Install failed'
        : 'Setting up Python environment';
  const subheading =
    state.status === 'complete'
      ? 'Done — running your step now.'
      : state.status === 'error'
        ? 'pip install did not complete successfully. See log for details.'
        : 'Installing pip packages for local execution. This only happens once per project.';
  const statusDot: DialogStatusDot =
    state.status === 'complete' ? 'green' : state.status === 'error' ? 'red' : 'blue-pulse';

  return (
    <Dialog
      open={state.visible}
      size="xl"
      ariaModal
      onBackdropClick={state.status === 'error' ? onDismiss : undefined}
      header={<DialogHeader title={heading} statusDot={statusDot} />}
      footer={
        state.status === 'error' ? (
          <button
            onClick={onDismiss}
            className="rounded bg-neutral-900 px-3 py-1.5 text-[12px] text-white transition-colors hover:bg-neutral-700"
          >
            Close
          </button>
        ) : undefined
      }
    >
      <div className="px-5 py-4">
        <p className="m-0 mb-3 text-[12px] text-neutral-600">{subheading}</p>

        <div
          ref={logRef}
          className="max-h-72 overflow-y-auto rounded border border-black/10 bg-neutral-950 px-3 py-2 text-[11px] leading-relaxed text-neutral-100"
        >
          {state.logs.length === 0 ? (
            <span className="text-neutral-500">Waiting for pip output…</span>
          ) : (
            state.logs.map((entry, i) => (
              <div
                key={i}
                className={entry.stream === 'stderr' ? 'text-amber-300' : 'text-neutral-100'}
              >
                {entry.line || '\u00a0'}
              </div>
            ))
          )}
        </div>

        {state.status === 'error' && state.error && (
          <p className="mt-3 whitespace-pre-wrap break-words text-[12px] text-red-600">
            {state.error}
          </p>
        )}
      </div>
    </Dialog>
  );
};
