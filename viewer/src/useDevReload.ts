import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Credentials } from './CredentialsContext.js';
import type { ConsoleEntry } from './components/DevSidebar.js';

export type { ProxyLogEntry } from '@shared/lib/proxy.js';
import { type ProxyLogEntry } from '@shared/lib/proxy.js';

export interface VenvInstallLogLine {
  line: string;
  stream: 'stdout' | 'stderr';
}

export type VenvInstallStatus = 'idle' | 'installing' | 'complete' | 'error';

export interface VenvInstallState {
  status: VenvInstallStatus;
  visible: boolean;
  logs: VenvInstallLogLine[];
  error: string | null;
}

type ServerMessage =
  | { type: 'rebuild' }
  | { type: 'log'; message: string }
  | { type: 'proxy-log'; entry?: ProxyLogEntry; message?: string }
  | { type: 'console-message'; level: string; args: unknown[] }
  | { type: 'credentials-updated'; credentials: Partial<Credentials> | null }
  | { type: 'venv-install-start' }
  | { type: 'venv-install-log'; line: string; stream: 'stdout' | 'stderr' }
  | { type: 'venv-install-complete' }
  | { type: 'venv-install-error'; message: string };

// Warm restarts (pip reports "Requirement already satisfied" for every package)
// typically finish in ~1–2 s. Delay the popup long enough to avoid flashing it
// in that case; real installs take 15 s+ so the extra 2 s is imperceptible.
const VENV_VISIBILITY_DELAY_MS = 2000;
const VENV_AUTO_DISMISS_MS = 1000;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;

// Cap each live log buffer so a noisy plugin (or a long-running session) can't
// grow state unboundedly — the sidebar only shows the most recent anyway.
const LOG_BUFFER_LIMIT = 500;

export function useDevReload(): {
  buildLogs: string[];
  proxyLogs: ProxyLogEntry[];
  consoleLogs: ConsoleEntry[];
  clearConsoleLogs: () => void;
  serverCredentials: Partial<Credentials> | null;
  venvInstall: VenvInstallState;
  dismissVenvInstall: () => void;
} {
  const queryClient = useQueryClient();
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const [proxyLogs, setProxyLogs] = useState<ProxyLogEntry[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);
  const [serverCredentials, setServerCredentials] = useState<Partial<Credentials> | null>(null);
  const [venvInstall, setVenvInstall] = useState<VenvInstallState>({
    status: 'idle',
    visible: false,
    logs: [],
    error: null,
  });
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearVenvTimers = useCallback((): void => {
    if (showTimerRef.current !== null) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }

    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const dismissVenvInstall = useCallback((): void => {
    clearVenvTimers();
    setVenvInstall({ status: 'idle', visible: false, logs: [], error: null });
  }, [clearVenvTimers]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let cancelled = false;

    const handleMessage = (event: MessageEvent): void => {
      let msg: ServerMessage;

      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === 'rebuild') {
        void queryClient.invalidateQueries({ queryKey: ['bundle'] });
        void queryClient.invalidateQueries({ queryKey: ['source-tree'] });
        void queryClient.invalidateQueries({ queryKey: ['source-file'] });
      } else if (msg.type === 'log') {
        setBuildLogs((prev) => [...prev, msg.message].slice(-LOG_BUFFER_LIMIT));
      } else if (msg.type === 'proxy-log') {
        const entry: ProxyLogEntry = msg.entry ?? {
          kind: 'info',
          message: msg.message ?? '',
        };

        setProxyLogs((prev) => [...prev, entry].slice(-LOG_BUFFER_LIMIT));
      } else if (msg.type === 'console-message') {
        const validLevels = ['log', 'warn', 'error', 'info'] as const;
        const level: ConsoleEntry['level'] = validLevels.includes(
          msg.level as ConsoleEntry['level'],
        )
          ? (msg.level as ConsoleEntry['level'])
          : 'log';

        setConsoleLogs((prev) => [...prev, { level, args: msg.args }].slice(-LOG_BUFFER_LIMIT));
      } else if (msg.type === 'venv-install-start') {
        clearVenvTimers();
        setVenvInstall({ status: 'installing', visible: false, logs: [], error: null });

        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          setVenvInstall((prev) =>
            prev.status === 'installing' ? { ...prev, visible: true } : prev,
          );
        }, VENV_VISIBILITY_DELAY_MS);
      } else if (msg.type === 'venv-install-log') {
        setVenvInstall((prev) => ({
          ...prev,
          logs: [...prev.logs, { line: msg.line, stream: msg.stream }].slice(-LOG_BUFFER_LIMIT),
        }));
      } else if (msg.type === 'venv-install-complete') {
        if (showTimerRef.current !== null) {
          clearTimeout(showTimerRef.current);
          showTimerRef.current = null;
        }

        setVenvInstall((prev) => {
          if (!prev.visible) {
            return { status: 'idle', visible: false, logs: [], error: null };
          }

          return { ...prev, status: 'complete' };
        });

        dismissTimerRef.current = setTimeout(() => {
          dismissTimerRef.current = null;
          setVenvInstall({ status: 'idle', visible: false, logs: [], error: null });
        }, VENV_AUTO_DISMISS_MS);
      } else if (msg.type === 'venv-install-error') {
        if (showTimerRef.current !== null) {
          clearTimeout(showTimerRef.current);
          showTimerRef.current = null;
        }

        setVenvInstall((prev) => ({
          status: 'error',
          visible: true,
          logs: prev.logs,
          error: msg.message,
        }));
      } else {
        setServerCredentials(msg.credentials);
      }
    };

    const scheduleReconnect = (): void => {
      if (cancelled || reconnectTimer !== null) {
        return;
      }

      const delay = backoff;

      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = (): void => {
      if (cancelled) {
        return;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}`);

      ws = socket;

      socket.addEventListener('open', () => {
        backoff = INITIAL_BACKOFF_MS;
      });
      socket.addEventListener('message', handleMessage);
      socket.addEventListener('close', () => {
        if (ws === socket) {
          ws = null;
        }

        scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        // Let 'close' handle reconnection — just force the socket shut.
        socket.close();
      });
    };

    const reconnectNow = (): void => {
      if (cancelled) {
        return;
      }

      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        return;
      }

      backoff = INITIAL_BACKOFF_MS;

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (ws !== null && ws.readyState === WebSocket.CONNECTING) {
        return;
      }

      connect();
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        reconnectNow();
      }
    };

    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisibilityChange);

    connect();

    return () => {
      cancelled = true;

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      clearVenvTimers();

      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);

      ws?.close();
      ws = null;
    };
  }, [queryClient, clearVenvTimers]);

  const clearConsoleLogs = (): void => {
    setConsoleLogs([]);
  };

  return {
    buildLogs,
    proxyLogs,
    consoleLogs,
    clearConsoleLogs,
    serverCredentials,
    venvInstall,
    dismissVenvInstall,
  };
}
