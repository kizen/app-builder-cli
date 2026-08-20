import type { FC } from 'react';
import type { PluginToast as PluginToastPayload } from '../hooks/usePluginToast.js';

const VARIANT_CLASSES: Record<string, string> = {
  success: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  failure: 'bg-red-100 text-red-700',
  alert: 'bg-amber-100 text-amber-700',
};

const DEFAULT_VARIANT_CLASSES = VARIANT_CLASSES.success ?? '';

export const PluginToast: FC<{ toast: PluginToastPayload | null }> = ({ toast }) => {
  if (!toast) {
    return null;
  }

  return (
    <div
      className={`fixed top-4 left-1/2 -translate-x-1/2 z-20 rounded px-4 py-2 text-sm font-medium ${
        VARIANT_CLASSES[toast.variant ?? 'success'] ?? DEFAULT_VARIANT_CLASSES
      }`}
    >
      {toast.message}
    </div>
  );
};
