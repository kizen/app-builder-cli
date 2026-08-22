import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { PluginToast, type PluginToastPayload } from './components/PluginToast.js';

export interface ToastPayload {
  message: string;
  variant?: 'success' | 'failure' | 'alert';
  autohide?: boolean;
}

export type ShowToastFn = (payload: ToastPayload) => void;

export interface ToastController {
  showToast: ShowToastFn;
  clearToasts: () => void;
}

const AUTO_DISMISS_MS = 5000;

const noop = (): void => {
  // No-op function for default context values
};

const ToastContext = createContext<ToastController>({ showToast: noop, clearToasts: noop });

export const useToast = (): ShowToastFn => useContext(ToastContext).showToast;

export const useToastController = (): ToastController => useContext(ToastContext);

export const ToastProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [toast, setToast] = useState<PluginToastPayload | null>(null);

  const showToast = useCallback<ShowToastFn>(({ message, variant }) => {
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

  const controller = useMemo(() => ({ showToast, clearToasts }), [showToast, clearToasts]);

  return (
    <ToastContext.Provider value={controller}>
      <PluginToast toast={toast} />
      {children}
    </ToastContext.Provider>
  );
};
