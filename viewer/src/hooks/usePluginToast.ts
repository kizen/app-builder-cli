import { useCallback, useEffect, useState } from 'react';
import type { ShowToastFn } from '../ToastContext.js';

export interface PluginToast {
  message: string;
  variant?: string;
}

interface UsePluginToastReturn {
  toast: PluginToast | null;
  showToast: ShowToastFn;
  clearToasts: () => void;
}

const AUTO_DISMISS_MS = 5000;

export const usePluginToast = (): UsePluginToastReturn => {
  const [toast, setToast] = useState<PluginToast | null>(null);

  const showToast: ShowToastFn = useCallback(({ message, variant }) => {
    setToast({ message, variant: variant ?? 'success' });
  }, []);

  const clearToasts = useCallback(() => {
    setToast(null);
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = setTimeout(() => {
      setToast(null);
    }, AUTO_DISMISS_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  return { toast, showToast, clearToasts };
};
