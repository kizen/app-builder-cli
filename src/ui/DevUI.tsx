import type { FC } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  createRequestHandler,
  fileExists,
  getViewerPath,
  type ProxyLogEntry,
  proxyLogEntryToString,
} from '../server/requestHandler.js';
import { launchChromeViewer, type ChromeViewerHandle } from '../chrome/launcher.js';
import { runBuild } from '../lib/runBuild.js';
import type { Credentials } from '../lib/credentials.js';
import { saveConfig } from '../lib/config.js';
import { LOG_LIMIT, LOG_DISPLAY, FILE_WATCH_DEBOUNCE_MS } from '../lib/constants.js';
import { formatBytes } from '../../shared/lib/formatBytes.js';
import { useLogHistory } from '../hooks/useLogHistory.js';
import { CredentialSetupUI } from './CredentialSetupUI.js';
import type { CredentialMode, CredentialSetupResult } from './CredentialSetupUI.js';
import { AppHeader } from './AppHeader.js';
import { Spinner } from './Spinner.js';

type ServerStatus = 'starting' | 'running' | 'error';
type BuildStatus = 'pending' | 'building' | 'done' | 'error';

const SKIP_WATCH_PREFIXES = ['.kizenapp', '.git'];

interface DevUIProps {
  port: number;
  pluginDir: string;
  outputDir: string;
  credentials: Credentials | null;
  credentialMode?: CredentialMode;
  activeCredentialProfile?: string;
  lastPath?: string;
  debug?: boolean;
  verbose?: boolean;
}

export const DevUI: FC<DevUIProps> = ({
  port,
  pluginDir,
  outputDir,
  credentials: initialCredentials,
  credentialMode: initialCredentialMode,
  activeCredentialProfile: initialActiveProfile,
  lastPath: initialLastPath,
  debug = false,
  verbose = false,
}) => {
  const credentialsRef = useRef<Credentials | null>(initialCredentials);
  const activeProfileRef = useRef<string | undefined>(initialActiveProfile);
  const lastPathRef = useRef<string | undefined>(initialLastPath);
  const [credMode, setCredMode] = useState<'main' | 'editing'>('main');
  const [credentialMode, setCredentialMode] = useState<CredentialMode | undefined>(
    initialCredentialMode,
  );

  const [status, setStatus] = useState<ServerStatus>('starting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverLogHistory, appendServerLog] = useLogHistory(LOG_LIMIT);
  const [buildLogHistory, appendBuildLog] = useLogHistory(LOG_LIMIT);
  const [cdpLogHistory, appendCdpLog] = useLogHistory(LOG_LIMIT);
  const [proxyLogHistory, setProxyLogHistory] = useState<string[]>([]);
  const [buildStatus, setBuildStatus] = useState<BuildStatus>('pending');
  const [buildError, setBuildError] = useState<string | null>(null);
  const [lastBuilt, setLastBuilt] = useState<Date | null>(null);
  const [lastBundleSize, setLastBundleSize] = useState<number | null>(null);
  const [wsClientCount, setWsClientCount] = useState(0);
  const [proxyCacheSize, setProxyCacheSize] = useState(0);
  const [proxyCacheHits, setProxyCacheHits] = useState(0);
  const [proxyCacheMisses, setProxyCacheMisses] = useState(0);

  const buildingRef = useRef(false);
  const viewerLaunchedRef = useRef(false);
  const chromeHandleRef = useRef<ChromeViewerHandle | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsClientsRef = useRef<Set<WebSocket>>(new Set());
  const pendingMessagesRef = useRef<string[]>([]);

  const broadcast = useCallback((msg: object): void => {
    const json = JSON.stringify(msg);

    if (wsClientsRef.current.size === 0) {
      pendingMessagesRef.current = [...pendingMessagesRef.current, json].slice(-LOG_LIMIT);

      return;
    }

    let pruned = false;

    for (const client of wsClientsRef.current) {
      if (client.readyState !== 1) {
        continue;
      }

      try {
        client.send(json);
      } catch {
        // Socket died between readyState check and send — drop it so one
        // dead client can't break the loop and silently disconnect the rest.
        wsClientsRef.current.delete(client);
        pruned = true;
      }
    }

    if (pruned) {
      setWsClientCount(wsClientsRef.current.size);
    }
  }, []);

  const createServerLog = appendServerLog;

  const launchChromeViewerCb = useCallback(() => {
    chromeHandleRef.current?.kill();

    chromeHandleRef.current = null;

    void launchChromeViewer({
      port,
      userDataDir: join(outputDir, '.chrome'),
      broadcast,
      onWarn: (msg) => {
        appendServerLog(`⚠ ${msg}`);
      },
      ...(lastPathRef.current !== undefined && { path: lastPathRef.current }),
      ...(debug && { debugLog: appendCdpLog }),
      ...(verbose && { verbose: true }),
    }).then((handle) => {
      chromeHandleRef.current = handle;
    });
  }, [port, outputDir, broadcast, debug, verbose, appendCdpLog, appendServerLog]);

  useEffect(() => {
    const onExit = (): void => {
      chromeHandleRef.current?.kill();
    };

    process.on('exit', onExit);

    return () => {
      process.off('exit', onExit);
    };
  }, []);

  useInput(
    (input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) {
        process.exit(0);
      }

      if (input === 'c') {
        setCredMode('editing');
      }

      if (input === 'v') {
        launchChromeViewerCb();
      }
    },
    { isActive: credMode === 'main' },
  );

  useEffect(() => {
    if (status !== 'running' || viewerLaunchedRef.current) {
      return;
    }

    viewerLaunchedRef.current = true;

    launchChromeViewerCb();
  }, [status, launchChromeViewerCb]);

  const handleCredentialsDone = useCallback(
    (result: CredentialSetupResult): void => {
      credentialsRef.current = result.credentials;

      activeProfileRef.current = result.profileName;

      setCredMode('main');

      setCredentialMode(result.mode);

      const profile = result.profileName;

      void saveConfig(outputDir, {
        credentialMode: result.mode,
        ...(profile !== undefined && { activeCredentialProfile: profile }),
      });

      broadcast({ type: 'credentials-updated', credentials: result.credentials });
    },
    [outputDir, broadcast],
  );

  const createProxyLog = useCallback(
    (entry: ProxyLogEntry): void => {
      setProxyLogHistory((h) =>
        [...h, `${new Date().toLocaleTimeString()}: ${proxyLogEntryToString(entry)}`].slice(
          -LOG_LIMIT,
        ),
      );

      if (entry.kind === 'request') {
        if (entry.fromCache) {
          setProxyCacheHits((n) => n + 1);
        } else {
          setProxyCacheMisses((n) => n + 1);
        }
      }

      broadcast({ type: 'proxy-log', entry });
    },
    [broadcast],
  );

  const createBuildLog = useCallback(
    (message: string): void => {
      appendBuildLog(message);

      broadcast({ type: 'log', message });
    },
    [appendBuildLog, broadcast],
  );

  const triggerBuild = useCallback(() => {
    if (buildingRef.current) {
      return;
    }

    buildingRef.current = true;
    setBuildStatus('building');
    setBuildError(null);
    createBuildLog('Build started');

    void runBuild(pluginDir, outputDir)
      .then(({ bundleSize }) => {
        createBuildLog(`Build finished — bundle: ${formatBytes(bundleSize)}`);
        setBuildStatus('done');
        setLastBuilt(new Date());
        setLastBundleSize(bundleSize);
        createBuildLog('Notifying viewers to reload');
        broadcast({ type: 'rebuild' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);

        setBuildError(message);
        setBuildStatus('error');
      })
      .finally(() => {
        buildingRef.current = false;
      });
  }, [pluginDir, outputDir, createBuildLog, broadcast]);

  useEffect(() => {
    triggerBuild();

    const watcher: FSWatcher = watch(pluginDir, { recursive: true }, (_, filename) => {
      if (!filename) {
        return;
      }

      const normalized = filename.replace(/\\/g, '/');

      if (SKIP_WATCH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        return;
      }

      createBuildLog(`File change detected: ${filename}`);

      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(triggerBuild, FILE_WATCH_DEBOUNCE_MS);
    });

    // fs.watch silently dies on e.g. macOS inode-limit pressure — surface it so
    // developers know rebuilds have stopped rather than wondering why their
    // edits aren't reflected in the viewer.
    watcher.on('error', (err: Error) => {
      createBuildLog(`File watcher error — rebuilds have stopped: ${err.message}`);
    });

    return () => {
      watcher.close();

      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [pluginDir, triggerBuild, createBuildLog]);

  useEffect(() => {
    const viewerPath = getViewerPath();

    void fileExists(join(viewerPath, 'index.html')).then((viewerBuilt) => {
      if (!viewerBuilt) {
        setErrorMessage("Viewer not built. Run 'pnpm build:viewer' first.");
        setStatus('error');

        return;
      }

      const handler = createRequestHandler(
        viewerPath,
        createServerLog,
        createProxyLog,
        credentialsRef,
        activeProfileRef,
        outputDir,
        broadcast,
        setProxyCacheSize,
        lastPathRef,
        pluginDir,
      );
      const server: Server = createServer(handler);
      const wss = new WebSocketServer({ server });

      wss.on('connection', (ws: WebSocket) => {
        for (const json of pendingMessagesRef.current) {
          if (ws.readyState === 1) {
            ws.send(json);
          }
        }

        pendingMessagesRef.current = [];
        createServerLog('Viewer connected for live reload');
        wsClientsRef.current.add(ws);
        setWsClientCount(wsClientsRef.current.size);

        ws.on('close', () => {
          wsClientsRef.current.delete(ws);
          setWsClientCount(wsClientsRef.current.size);
        });
      });

      server.listen(port, '127.0.0.1', () => {
        setStatus('running');
        createServerLog(`Server started on 127.0.0.1:${String(port)}`);
      });

      server.on('error', (err: Error) => {
        setErrorMessage(err.message);
        setStatus('error');
      });

      return () => {
        wss.close();
        server.close();
      };
    });
  }, [port, createServerLog, createProxyLog, broadcast, outputDir, pluginDir]);

  if (credMode === 'editing') {
    return (
      <CredentialSetupUI
        {...(credentialMode !== undefined && { initialMode: credentialMode })}
        showProfileManager={credentialMode === 'global'}
        onComplete={handleCredentialsDone}
        onCancel={() => {
          setCredMode('main');
        }}
      />
    );
  }

  const elapsedSeconds =
    lastBuilt !== null ? Math.round((Date.now() - lastBuilt.getTime()) / 1000) : null;

  const elapsedLabel =
    elapsedSeconds === null
      ? ''
      : elapsedSeconds < 5
        ? ' (just now)'
        : ` (${String(elapsedSeconds)}s ago)`;

  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <AppHeader marginBottom={1} />

      {/* Build panel */}
      <Box flexDirection="column">
        <Box gap={2} marginBottom={0}>
          <Text bold dimColor>
            App Build
          </Text>
          {buildStatus === 'pending' && <Text dimColor>waiting…</Text>}
          {buildStatus === 'building' && (
            <Box gap={1}>
              <Spinner />
              <Text>Building plugin package…</Text>
            </Box>
          )}
          {buildStatus === 'done' && (
            <Box gap={1}>
              <Text color="green">✓ Built</Text>
              {lastBuilt !== null && (
                <Text dimColor>
                  at {lastBuilt.toLocaleTimeString()}
                  {elapsedLabel}
                </Text>
              )}
              {lastBundleSize !== null && (
                <Text dimColor>· bundle: {formatBytes(lastBundleSize)}</Text>
              )}
            </Box>
          )}
          {buildStatus === 'error' && <Text color="red">✗ {buildError ?? 'unknown error'}</Text>}
        </Box>
        <Box
          flexDirection="column"
          height={LOG_DISPLAY + 2}
          borderStyle="single"
          borderColor="gray"
          overflow="hidden"
        >
          {buildLogHistory.slice(-LOG_DISPLAY).map((log, index) => (
            <Text key={index} dimColor wrap="truncate">
              {log}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Server panel */}
      <Box marginTop={1} flexDirection="column">
        <Box gap={2}>
          <Text bold dimColor>
            Web Server
          </Text>
          {status === 'starting' && <Text dimColor>starting…</Text>}
          {status === 'running' && (
            <Box gap={2}>
              <Text color="green">✓ Running</Text>
              <Text dimColor>
                ● {wsClientCount} viewer{wsClientCount !== 1 ? 's' : ''}
              </Text>
            </Box>
          )}
          {status === 'error' && <Text color="red">✗ {errorMessage ?? 'Server error'}</Text>}
        </Box>
        <Box
          flexDirection="column"
          height={LOG_DISPLAY + 2}
          borderStyle="single"
          borderColor="gray"
          overflow="hidden"
        >
          {serverLogHistory.slice(-LOG_DISPLAY).map((log, index) => (
            <Text key={index} dimColor wrap="truncate">
              {log}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Proxy panel */}
      <Box marginTop={1} flexDirection="column">
        <Box gap={2}>
          <Text bold dimColor>
            Network Proxy
          </Text>
          <Text color="green">✓ Active</Text>
          <Text dimColor>
            ● {proxyCacheSize} key{proxyCacheSize !== 1 ? 's' : ''} in the network cache ·{' '}
            {proxyCacheHits} hit · {proxyCacheMisses} miss
          </Text>
        </Box>
        <Box
          flexDirection="column"
          height={LOG_DISPLAY + 2}
          borderStyle="single"
          borderColor="gray"
          overflow="hidden"
        >
          {proxyLogHistory.length === 0 ? (
            <Text dimColor> No requests yet.</Text>
          ) : (
            proxyLogHistory.slice(-LOG_DISPLAY).map((log, i) => (
              <Text key={i} dimColor wrap="truncate">
                {log}
              </Text>
            ))
          )}
        </Box>
      </Box>

      {debug && (
        <Box marginTop={1} flexDirection="column">
          <Box gap={2}>
            <Text bold dimColor>
              CDP Debug
            </Text>
            <Text dimColor>● {cdpLogHistory.length} event(s)</Text>
          </Box>
          <Box
            flexDirection="column"
            height={LOG_DISPLAY + 2}
            borderStyle="single"
            borderColor="gray"
            overflow="hidden"
          >
            {cdpLogHistory.length === 0 ? (
              <Text dimColor> No CDP events yet.</Text>
            ) : (
              cdpLogHistory.slice(-LOG_DISPLAY).map((log, i) => (
                <Text key={i} dimColor wrap="truncate">
                  {log}
                </Text>
              ))
            )}
          </Box>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} gap={1}>
        <Text dimColor>[</Text>
        <Text>q</Text>
        <Text dimColor>] quit [</Text>
        <Text>c</Text>
        <Text dimColor>] credentials [</Text>
        <Text>v</Text>
        <Text dimColor>] {wsClientCount === 0 ? 'open viewer' : 'relaunch viewer'}</Text>
      </Box>
    </Box>
  );
};
