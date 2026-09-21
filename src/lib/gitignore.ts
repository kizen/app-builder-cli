import * as fs from 'node:fs';
import * as path from 'node:path';

// `.copilot-docs/` is cloned into the workspace by
// .github/workflows/copilot-code-review.yml at review time. It is never committed.
const ENTRIES = ['.kizenapp/', '.copilot-docs/'];

export function ensureGitignore(projectDir: string): void {
  const gitignorePath = path.join(projectDir, '.gitignore');

  let contents = '';

  if (fs.existsSync(gitignorePath)) {
    contents = fs.readFileSync(gitignorePath, 'utf8');
  }

  const existing = new Set(contents.split('\n').map((line) => line.trim()));
  const missing = ENTRIES.filter(
    (entry) => !existing.has(entry) && !existing.has(entry.replace(/\/$/, '')),
  );

  if (missing.length === 0) {
    return;
  }

  const block = missing.join('\n') + '\n';
  const addition = contents === '' || contents.endsWith('\n') ? block : '\n' + block;

  fs.writeFileSync(gitignorePath, contents + addition);
}
