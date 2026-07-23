import type { FC } from 'react';
import { Box, Text } from 'ink';
import type { ValidationIssue } from '@kizenapps/packager';

const groupIssuesByPath = (issues: ValidationIssue[]): Map<string, ValidationIssue[]> => {
  const groups = new Map<string, ValidationIssue[]>();

  for (const issue of issues) {
    const key = issue.path ?? issue.pluginApiName ?? 'general';
    const group = groups.get(key) ?? [];

    group.push(issue);
    groups.set(key, group);
  }

  return groups;
};

interface ValidationIssuesProps {
  issues: ValidationIssue[];
}

export const ValidationIssues: FC<ValidationIssuesProps> = ({ issues }) => {
  // The build only throws on error-severity issues, but `issues` also carries
  // any warnings; the header must count errors only, not the whole array.
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="red">
        ✗ {errorCount} validation {errorCount === 1 ? 'error' : 'errors'}
      </Text>

      {[...groupIssuesByPath(issues)].map(([path, group]) => (
        <Box key={path} flexDirection="column" marginTop={1}>
          <Text bold>{path}</Text>

          {group.map((issue, i) => (
            <Box key={`${issue.rule}-${String(i)}`} paddingLeft={2}>
              <Text color={issue.severity === 'error' ? 'red' : 'yellow'}>
                {issue.severity === 'error' ? '✗' : '⚠'} {issue.message}{' '}
                <Text dimColor>({issue.rule})</Text>
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
};
