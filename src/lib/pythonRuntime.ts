export function parseRequirementsFile(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim().replace(/\s+#.*$/, ''))
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function resolvePythonBinary(runtime: string): string {
  const match = /^python-(\d+)[.-](\d+)$/.exec(runtime);
  const major = match?.[1];
  const minor = match?.[2];

  if (major !== undefined && minor !== undefined) {
    return `python${major}.${minor}`;
  }

  return 'python3';
}
