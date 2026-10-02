import type { ValidationIssue } from '@kizenapps/packager';

const plural = (count: number, singular: string, pluralForm: string): string =>
  `${String(count)} ${count === 1 ? singular : pluralForm}`;

export const groupIssuesByPath = (issues: ValidationIssue[]): Map<string, ValidationIssue[]> => {
  const groups = new Map<string, ValidationIssue[]>();

  for (const issue of issues) {
    const key = issue.path ?? issue.pluginApiName ?? 'general';
    const group = groups.get(key) ?? [];

    group.push(issue);
    groups.set(key, group);
  }

  return groups;
};

const formatHeader = (issues: ValidationIssue[]): string => {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;

  if (errorCount === 0) {
    return `⚠ ${plural(warningCount, 'validation warning', 'validation warnings')}`;
  }

  const errors = `✗ ${plural(errorCount, 'validation error', 'validation errors')}`;

  return warningCount === 0 ? errors : `${errors}, ${plural(warningCount, 'warning', 'warnings')}`;
};

export function formatValidationIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return '';
  }

  const sections = [...groupIssuesByPath(issues)].map(([path, group]) =>
    [
      path,
      ...group.map(
        (issue) => `  ${issue.severity === 'error' ? '✗' : '⚠'} ${issue.message} (${issue.rule})`,
      ),
    ].join('\n'),
  );

  return [formatHeader(issues), ...sections].join('\n\n');
}
