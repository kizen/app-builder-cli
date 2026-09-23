import { useEffect, useState, type FC } from 'react';
import { Dialog, DialogHeader } from '../Dialog.js';
import {
  clearPlanEntitlements,
  isStoredPlanEntitlements,
  savePlanEntitlements,
  type StoredPlanEntitlements,
} from '../../lib/planEntitlementsStorage.js';

interface PlanEntitlementsDialogProps {
  open: boolean;
  onClose: () => void;
  value: StoredPlanEntitlements;
  onChange?: (value: StoredPlanEntitlements) => void;
}

const stringify = (value: StoredPlanEntitlements): string => JSON.stringify(value, null, 2);

export const PlanEntitlementsDialog: FC<PlanEntitlementsDialogProps> = ({
  open,
  onClose,
  value,
  onChange,
}) => {
  const [text, setText] = useState(() => stringify(value));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) {
      setText(stringify(value));
      setError(null);
      setSaved(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSave = (): void => {
    try {
      const parsed: unknown = JSON.parse(text);

      if (!isStoredPlanEntitlements(parsed)) {
        setError(
          'Expected { "plan": { [type]: { [key]: value } }, "entitlements": { [key]: value } }',
        );
        setSaved(false);

        return;
      }

      savePlanEntitlements(parsed);
      onChange?.(parsed);
      setError(null);
      setSaved(true);

      setTimeout(() => {
        setSaved(false);
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
      setSaved(false);
    }
  };

  const handleClear = (): void => {
    clearPlanEntitlements();
    onChange?.({ plan: {}, entitlements: {} });
    setText(stringify({ plan: {}, entitlements: {} }));
    setError(null);
    setSaved(false);
  };

  return (
    <Dialog
      open={open}
      size="lg"
      ariaModal
      onBackdropClick={onClose}
      header={<DialogHeader title="Plan & Entitlements (local simulation)" onClose={onClose} />}
      footer={
        <>
          <button
            onClick={handleClear}
            className="rounded border border-black/10 px-3 py-1 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50 active:bg-neutral-100"
          >
            Clear
          </button>
          <button
            onClick={handleSave}
            className="rounded bg-blue-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-blue-700 active:bg-blue-800"
          >
            Apply
          </button>
        </>
      }
    >
      <div className="px-5 py-4">
        <p className="m-0 mb-3 text-[12px] text-neutral-500">
          Fakes the values a plugin reads via{' '}
          <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
            {'{{plan.<type>.<key>}}'}
          </code>{' '}
          and{' '}
          <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
            {'{{entitlement.<key>}}'}
          </code>
          in <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">when</code> and
          radio-option{' '}
          <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">disabled</code>{' '}
          expressions. Applies to every plugin's assistant while this credential profile is active —
          there is no real plan/entitlements backend here, so an unset key always resolves to{' '}
          <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">null</code>, same as
          production.
        </p>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
            setSaved(false);
          }}
          spellCheck={false}
          rows={12}
          className={`w-full rounded border p-3 text-[13px] font-mono leading-relaxed focus:outline-none focus:ring-1 ${
            error ? 'border-red-300 focus:ring-red-400' : 'border-black/10 focus:ring-blue-400'
          }`}
        />
        {error && <p className="mt-2 text-[12px] text-red-500">Parse error: {error}</p>}
        {saved && <p className="mt-2 text-[12px] font-medium text-green-600">Applied</p>}
      </div>
    </Dialog>
  );
};
