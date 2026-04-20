import type { FC } from 'react';
import { Box, Text } from 'ink';
import { Logo } from './Logo.js';

interface AppHeaderProps {
  marginBottom?: number;
}

export const AppHeader: FC<AppHeaderProps> = ({ marginBottom = 0 }) => (
  <>
    <Logo />
    <Box flexDirection="column" marginTop={1} marginBottom={marginBottom}>
      <Text bold color="cyan">
        Kizen App Development Toolkit
      </Text>
    </Box>
  </>
);
