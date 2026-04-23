import { useCallback, useState, type ReactNode } from 'react';
import {
  CriticalExceptionDialog,
  type CriticalExceptionState,
} from '../components/CriticalExceptionDialog.js';

interface MonitoringExtra {
  workerName?: string;
  pluginApiName?: string;
}

interface UseCriticalExceptionDialogResult {
  onMonitoringException: (error: Error, extra: { extra: MonitoringExtra }) => void;
  dialog: ReactNode;
}

export function useCriticalExceptionDialog(): UseCriticalExceptionDialogResult {
  const [state, setState] = useState<CriticalExceptionState>({ visible: false });

  const onMonitoringException = useCallback((error: Error, extra: { extra: MonitoringExtra }) => {
    const context: CriticalExceptionState['context'] = {};

    if (extra.extra.workerName !== undefined) {
      context.workerName = extra.extra.workerName;
    }

    if (extra.extra.pluginApiName !== undefined) {
      context.pluginApiName = extra.extra.pluginApiName;
    }

    setState({ visible: true, error, context });
  }, []);

  const onDismiss = useCallback(() => {
    setState((prev) => ({ ...prev, visible: false }));
  }, []);

  const dialog = <CriticalExceptionDialog state={state} onDismiss={onDismiss} />;

  return { onMonitoringException, dialog };
}
