import { useEffect, useMemo, useState, type FC } from 'react';
import { Dialog, DialogHeader } from '../Dialog.js';
import { CodeViewer } from '../CodeViewer.js';
import type { StoredConfig } from '../../lib/configStorage.js';

interface ConfigJsonDialogProps {
  open: boolean;
  onClose: () => void;
  apiName: string;
  loadFn: (apiName: string) => StoredConfig | null;
  label: 'this.config' | 'this.userConfig';
}

export const ConfigJsonDialog: FC<ConfigJsonDialogProps> = ({
  open,
  onClose,
  apiName,
  loadFn,
  label,
}) => {
  const cleanConfig = useMemo(() => {
    if (!open) {
      return null;
    }

    const stored = loadFn(apiName);

    return stored?.__kizen_clean_config ?? null;
  }, [open, apiName, loadFn]);

  const json = useMemo(
    () => (cleanConfig ? JSON.stringify(cleanConfig, null, 2) : ''),
    [cleanConfig],
  );

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setCopied(false);
    }
  }, [open]);

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 1200);
    });
  };

  return (
    <Dialog
      open={open}
      size="xl"
      ariaModal
      onBackdropClick={onClose}
      header={<DialogHeader title={`Stored JSON — ${label}`} onClose={onClose} />}
      footer={
        cleanConfig ? (
          <button
            onClick={handleCopy}
            className="rounded border border-black/10 px-3 py-1 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50 active:bg-neutral-100"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : undefined
      }
    >
      <div className="px-5 py-4">
        <p className="m-0 mb-3 text-[12px] text-neutral-500">
          This is the saved JSON the plugin runtime will see as{' '}
          <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">{label}</code>. Save
          the form to refresh.
        </p>

        {cleanConfig ? (
          <CodeViewer code={json} language="json" />
        ) : (
          <div className="rounded border border-dashed border-black/10 px-4 py-6 text-center text-[12px] text-neutral-400">
            No saved configuration yet. Save the form to populate this view.
          </div>
        )}
      </div>
    </Dialog>
  );
};
