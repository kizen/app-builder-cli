import { type FC, useEffect, useState } from 'react';
import { DevSidebar } from '../components/DevSidebar.js';
import { type ConsoleEntry } from '../consoleCapture.js';
import { type Credentials } from '../CredentialsContext.js';
import { STORAGE_KEYS } from '../lib/storageKeys.js';

const EMPTY_CREDENTIALS: Credentials = {
  apiKey: '',
  userId: '',
  businessId: '',
  environment: 'go',
};

import { useDevReload } from '../useDevReload.js';

export const DevToolsPage: FC = () => {
  const { buildLogs, proxyLogs, serverCredentials } = useDevReload();

  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);

  const [credentials, setCredentials] = useState<Credentials>(() => {
    try {
      return {
        ...EMPTY_CREDENTIALS,
        ...JSON.parse(localStorage.getItem(STORAGE_KEYS.credentials) ?? '{}'),
      } as Credentials;
    } catch {
      return EMPTY_CREDENTIALS;
    }
  });

  // Receive console log entries broadcast from the main window
  useEffect(() => {
    const channel = new BroadcastChannel('devtools-console');

    channel.onmessage = (e: MessageEvent<ConsoleEntry>) => {
      setConsoleLogs((prev) => [...prev, e.data]);
    };

    return () => {
      channel.close();
    };
  }, []);

  // Sync credentials pushed from the server via WebSocket
  useEffect(() => {
    if (!serverCredentials) {
      return;
    }

    const merged = { ...EMPTY_CREDENTIALS, ...serverCredentials } as Credentials;

    setCredentials(merged);

    localStorage.setItem(STORAGE_KEYS.credentials, JSON.stringify(merged));
  }, [serverCredentials]);

  // Sync credentials changed by the main window while this popout is open
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === STORAGE_KEYS.credentials && e.newValue) {
        try {
          setCredentials({
            ...EMPTY_CREDENTIALS,
            ...JSON.parse(e.newValue),
          } as Credentials);
        } catch {
          // ignore malformed value
        }
      }
    };

    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    document.title = 'Dev Tools';
  }, []);

  const handleCredentialsChange = (next: Credentials): void => {
    setCredentials(next);

    localStorage.setItem(STORAGE_KEYS.credentials, JSON.stringify(next));
  };

  return (
    <div className="h-screen">
      <DevSidebar
        onClose={() => {
          window.close();
        }}
        buildLogs={buildLogs}
        proxyLogs={proxyLogs}
        consoleLogs={consoleLogs}
        onClearConsole={() => {
          setConsoleLogs([]);
        }}
        credentials={credentials}
        onCredentialsChange={handleCredentialsChange}
      />
    </div>
  );
};
