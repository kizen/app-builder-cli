import type { FC } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';

export const Working: FC<{ label: string }> = ({ label }) => (
  <Box gap={1}>
    <Spinner />
    <Text dimColor>{label}</Text>
  </Box>
);
