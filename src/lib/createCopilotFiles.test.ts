import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeFiles, copilotFiles } from './createCopilotFiles.js';
import { STALE_CLAUDE_SKILL_WARNING } from './setupClaude.js';

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

const SKILL_PATH = '.claude/skills/kizen-custom-block/SKILL.md';
const DESIGN_PATH = '.claude/skills/kizen-custom-block/design.md';

const claudeContent = (path: string): string =>
  claudeFiles().find((file) => file.path === path)?.content ?? '';

describe('claudeFiles', () => {
  it('scaffolds only the kizen-custom-block skill and its design guide by default', () => {
    expect(claudeFiles().map((file) => file.path)).toStrictEqual([SKILL_PATH, DESIGN_PATH]);
  });

  it('adds the data lib, verbatim, when given an entry directory', () => {
    const files = claudeFiles(['src']);
    const template = fs.readFileSync(
      fileURLToPath(new URL('../templates/plugin/lib/kizenData.js', import.meta.url)),
      'utf8',
    );

    expect(files.map((file) => file.path)).toStrictEqual([
      SKILL_PATH,
      DESIGN_PATH,
      'src/lib/kizenData.js',
    ]);
    expect(files[2]?.content).toBe(template);
  });

  it('places the data lib under each entry directory it is given', () => {
    expect(claudeFiles(['app', 'src/a', 'app', '']).map((file) => file.path)).toStrictEqual([
      SKILL_PATH,
      DESIGN_PATH,
      'app/lib/kizenData.js',
      'src/a/lib/kizenData.js',
      'lib/kizenData.js',
    ]);
  });

  it.each([
    {
      file: SKILL_PATH,
      mustContain: [
        // The data lib.
        '## Reading Kizen data',
        "from '../../lib/kizenData.js'",
        'blockFilters(this.args, fields)',
        'truncated',
        'goes through `escapeHtml(value)`',
        '${escapeHtml(row.label)}',
        // The design guide.
        'read `design.md` in this skill directory',
        'Before writing any markup or styles, read `design.md` in this skill directory and follow it exactly.',
        // The exact stale warning the push emits.
        `\`${STALE_CLAUDE_SKILL_WARNING}\``,
        '## Keep this skill current',
        'appbuilder setup-claude',
        // The block push loop and its guardrails.
        'appbuilder block export <api_name>',
        'appbuilder block targets --json',
        '--dry-run --json',
        'appbuilder block push <api_name> --yes --json',
        '--allow-production',
        'drift_detected',
        'this.outputUI(htmlString)',
      ],
      // The outdated paint-your-own-card rule.
      mustNotContain: ['must paint its own card'],
    },
    {
      file: DESIGN_PATH,
      mustContain: [
        // The card, spacing and token rules.
        '# Designing a Kizen custom block',
        'The host paints the card.',
        'width: 100%; height: 100%; box-sizing: border-box;',
        '--color-viz-cat-N-primary',
        '`styles.css`:',
        // formatNumber and escapeHtml come from the data lib, not a copied snippet.
        "import { formatNumber } from '../../lib/kizenData.js';",
        '${escapeHtml(r.label)}',
      ],
      mustNotContain: ['const formatNumber = ', 'loadRows', 'const escape = '],
    },
  ])('pins the prose of $file', ({ file, mustContain, mustNotContain }) => {
    const content = claudeContent(file);

    for (const text of mustContain) {
      expect(content).toContain(text);
    }

    for (const text of mustNotContain) {
      expect(content).not.toContain(text);
    }
  });

  it('gives the skill Claude Code frontmatter', () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(claudeContent(SKILL_PATH))?.[1] ?? '';

    expect(frontmatter).toMatch(/^name: kizen-custom-block$/m);
    expect(frontmatter).toMatch(/^description: Use this skill when .*custom block/m);
  });
});
