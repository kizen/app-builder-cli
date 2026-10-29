import type { FC } from 'react';
import { Box, Text } from 'ink';

export interface LinesProps {
  lines: readonly string[];
  color?: 'yellow' | 'red';
}

export const Lines: FC<LinesProps> = ({ lines, color }) => (
  <Box flexDirection="column">
    {lines.map((line, index) => (
      <Text key={`${String(index)}-${line}`} {...(color && { color })}>
        {line}
      </Text>
    ))}
  </Box>
);
