import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { copilotFiles } from './createCopilotFiles.js';

const WORKFLOW_PATH = '.github/workflows/copilot-code-review.yml';

describe('copilotFiles', () => {
  it('returns the scaffolded paths in order', () => {
    expect(copilotFiles().map((file) => file.path)).toEqual([
      '.github/copilot-instructions.md',
      '.github/instructions/security.instructions.md',
      '.github/instructions/version-discipline.instructions.md',
      WORKFLOW_PATH,
    ]);
  });

  it('keeps this repo on the same review workflow it scaffolds', () => {
    const template = copilotFiles().find((file) => file.path === WORKFLOW_PATH);

    expect(template).toBeDefined();

    const repoWorkflow = fs.readFileSync(
      fileURLToPath(new URL(`../../${WORKFLOW_PATH}`, import.meta.url)),
      'utf8',
    );

    expect(repoWorkflow).toBe(template?.content);
  });
});
