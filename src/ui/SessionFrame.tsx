import { useEffect, type FC, type ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { formatValidationIssues } from '../lib/formatValidationIssues.js';
import { AppHeader } from './AppHeader.js';
import { interrupt, type Session } from './commandSession.js';
import { Lines } from './Lines.js';

export const SessionFrame: FC<{ session: Session; children: ReactNode }> = ({
  session,
  children,
}) => (
  <Box flexDirection="column" paddingY={1} paddingX={2} gap={1}>
    <AppHeader />
    {session.credentials && (
      <Text dimColor>
        Environment: {session.credentials.environment} · Business: {session.credentials.businessId}
      </Text>
    )}
    {session.credentialNotices.length > 0 && (
      <Lines lines={session.credentialNotices} color="yellow" />
    )}
    {session.warnings.length > 0 && (
      <Text dimColor>{formatValidationIssues(session.warnings)}</Text>
    )}
    {session.notices.length > 0 && <Lines lines={session.notices} />}
    {children}
  </Box>
);

export function useCommandExit(
  finished: boolean,
  setExitCode: (code: number) => void,
  abort: () => void,
): void {
  const app = useApp();

  useEffect(() => {
    if (finished) {
      app.exit();
    }
  }, [finished, app]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c' && !finished) {
      interrupt(abort, setExitCode);
      app.exit();
    }
  });
}
