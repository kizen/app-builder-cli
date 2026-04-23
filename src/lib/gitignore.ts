import * as fs from 'node:fs';
import * as path from 'node:path';

export function ensureGitignore(projectDir: string): void {
  const gitignorePath = path.join(projectDir, '.gitignore');
  const entry = '.kizenapp/';

  let contents = '';

  if (fs.existsSync(gitignorePath)) {
    contents = fs.readFileSync(gitignorePath, 'utf8');

    const lines = contents.split('\n').map((l) => l.trim());

    if (lines.includes(entry) || lines.includes('.kizenapp')) {
      return;
    }
  }

  const addition = contents.endsWith('\n') ? entry + '\n' : '\n' + entry + '\n';

  fs.writeFileSync(gitignorePath, contents + addition);
}
