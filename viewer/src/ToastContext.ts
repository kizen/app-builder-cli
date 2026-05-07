import { createContext, useContext } from 'react';

export interface ToastPayload {
  message: string;
  variant?: 'success' | 'failure' | 'alert';
  autohide?: boolean;
}

export type ShowToastFn = (payload: ToastPayload) => void;

const noop: ShowToastFn = () => {
  /* default: pages without toast UI swallow */
};

export const ToastContext = createContext<ShowToastFn>(noop);

export const useToast = (): ShowToastFn => useContext(ToastContext);
