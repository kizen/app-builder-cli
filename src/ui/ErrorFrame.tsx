import type { FC } from 'react';
import { Box, Text } from 'ink';
import type { ValidationIssue } from '@kizenapps/packager';
import { formatValidationIssues } from '../lib/formatValidationIssues.js';
import { Lines } from './Lines.js';

/** What an error frame shows; a `CommandFailure` is one. */
export interface ErrorView {
  message: string;
  hint?: string;
  choices?: readonly { label: string }[];
  issues?: ValidationIssue[];
}

export const ErrorFrame: FC<{ view: ErrorView }> = ({ view }) => (
  <Box flexDirection="column" gap={1}>
    <Box gap={1}>
      <Text color="red">✗</Text>
      <Text color="red">
        {view.issues && view.issues.length > 0 ? formatValidationIssues(view.issues) : view.message}
      </Text>
    </Box>
    {view.hint !== undefined && <Text dimColor>Hint: {view.hint}</Text>}
    {view.choices && view.choices.length > 0 && (
      <Box flexDirection="column">
        <Text>Choices:</Text>
        <Lines lines={view.choices.map((choice) => `  ${choice.label}`)} />
      </Box>
    )}
  </Box>
);
