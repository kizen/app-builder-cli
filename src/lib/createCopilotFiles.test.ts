import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeFiles, copilotFiles } from './createCopilotFiles.js';

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

describe('claudeFiles', () => {
  it('scaffolds the kizen-custom-block skill, its design guide and the data lib', () => {
    expect(claudeFiles().map((file) => file.path)).toEqual([
      '.claude/skills/kizen-custom-block/SKILL.md',
      '.claude/skills/kizen-custom-block/design.md',
      'src/lib/kizenData.js',
    ]);
  });

  it('bundles the design guide with the card, spacing and token rules', () => {
    const design = claudeFiles()[1]?.content ?? '';

    for (const text of [
      '# Designing a Kizen custom block',
      'The host paints the card.',
      'width: 100%; height: 100%; box-sizing: border-box;',
      '--color-viz-cat-N-primary',
      '`styles.css`:',
    ]) {
      expect(design).toContain(text);
    }
  });

  it('points the design guide at the data lib for formatNumber instead of a copied snippet', () => {
    const design = claudeFiles()[1]?.content ?? '';

    expect(design).toContain("import { formatNumber } from '../../lib/kizenData.js';");
    expect(design).not.toContain('const formatNumber = ');
    expect(design).not.toContain('loadRows');
    expect(design).not.toContain('const escape = ');
    expect(design).toContain('${escapeHtml(r.label)}');
  });

  it('bundles the data lib verbatim from the template', async () => {
    const lib = claudeFiles().find((file) => file.path === 'src/lib/kizenData.js')?.content;
    const template = await readFile(
      new URL('../templates/plugin/lib/kizenData.js', import.meta.url),
      'utf-8',
    );

    expect(lib).toBe(template);
  });

  it('places the data lib under each entry directory it is given', () => {
    expect(claudeFiles(['app', 'src/a', 'app', '']).map((file) => file.path)).toStrictEqual([
      '.claude/skills/kizen-custom-block/SKILL.md',
      '.claude/skills/kizen-custom-block/design.md',
      'app/lib/kizenData.js',
      'src/a/lib/kizenData.js',
      'lib/kizenData.js',
    ]);
  });

  it('documents the data lib in the skill', () => {
    const skill = claudeFiles()[0]?.content ?? '';

    for (const text of [
      '## Reading Kizen data',
      "from '../../lib/kizenData.js'",
      'blockFilters(this.args, fields)',
      'truncated',
      'goes through `escapeHtml(value)`',
      '${escapeHtml(row.label)}',
    ]) {
      expect(skill).toContain(text);
    }
  });

  it('drops the outdated paint-your-own-card rule from the skill', () => {
    const skill = claudeFiles()[0]?.content ?? '';

    expect(skill).not.toContain('must paint its own card');
    expect(skill).toContain('read `design.md` in this skill directory');
  });

  it('gives the skill Claude Code frontmatter', () => {
    const [skill] = claudeFiles();
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill?.content ?? '')?.[1] ?? '';

    expect(frontmatter).toMatch(/^name: kizen-custom-block$/m);
    expect(frontmatter).toMatch(/^description: Use this skill when .*custom block/m);
  });

  it('documents the block push loop and its guardrails', () => {
    const content = claudeFiles()[0]?.content ?? '';

    for (const text of [
      'appbuilder block export <api_name>',
      'appbuilder block targets --json',
      '--dry-run --json',
      'appbuilder block push <api_name> --yes --json',
      '--allow-production',
      'drift_detected',
      'this.outputUI(htmlString)',
    ]) {
      expect(content).toContain(text);
    }
  });
});
