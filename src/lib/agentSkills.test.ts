import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../program.js';
import { AGENT_HARNESSES, renderSkillTemplate, type AgentHarness } from './agentHarness.js';
import { agentFiles, MANAGED_SKILL_NAMES } from './createCopilotFiles.js';

/**
 * The skills appbuilder writes for coding agents, checked as an agent reads them: rendered for
 * each harness, with frontmatter the harnesses accept, and naming only commands and flags the CLI
 * really has.
 */

const skillFiles = (harness: AgentHarness): { path: string; content: string }[] =>
  agentFiles(harness).filter((file) => file.path.endsWith('.md'));

const skillFile = (harness: AgentHarness, name: string): string =>
  agentFiles(harness).find((file) => file.path.endsWith(`/${name}/SKILL.md`))?.content ?? '';

const HARNESS_CASES = AGENT_HARNESSES.map((harness) => ({ harness }));

describe('renderSkillTemplate', () => {
  it('fills the tokens for each harness', () => {
    const template = '{{SETUP_COMMAND}} in {{SKILLS_DIR}}: `{{STALE_WARNING}}`';

    expect(renderSkillTemplate(template, 'claude')).toBe(
      'appbuilder setup-claude in .claude/skills: `Claude files managed by appbuilder are out of date; run appbuilder setup-claude`',
    );
    expect(renderSkillTemplate(template, 'codex')).toBe(
      'appbuilder setup-codex in .agents/skills: `Codex files managed by appbuilder are out of date; run appbuilder setup-codex`',
    );
  });

  it("keeps only the harness's own blocks, dropping the marker lines", () => {
    const template =
      'a\n{{#claude}}\nclaude only\n{{/claude}}\n{{#codex}}\ncodex only\n{{/codex}}\nb';

    expect(renderSkillTemplate(template, 'claude')).toBe('a\nclaude only\nb');
    expect(renderSkillTemplate(template, 'codex')).toBe('a\ncodex only\nb');
  });

  it.each([
    ['an unknown token', '{{NOPE}}'],
    ['an inline block marker', 'text {{#claude}}x{{/claude}}'],
    ['an unclosed block', '{{#claude}}\nx'],
    ['a mismatched close', '{{#claude}}\nx\n{{/codex}}'],
    ['a nested block', '{{#claude}}\n{{#codex}}\nx\n{{/codex}}\n{{/claude}}'],
  ])('throws on %s', (_name, template) => {
    expect(() => renderSkillTemplate(template, 'claude')).toThrow(/skill template/);
  });
});

describe.each(HARNESS_CASES)('the $harness skills', ({ harness }) => {
  it('render every template without leftover braces', () => {
    for (const file of skillFiles(harness)) {
      expect(file.content, file.path).not.toMatch(/\{\{|\}\}/);
    }
  });

  it.each(MANAGED_SKILL_NAMES)(
    '%s has frontmatter every harness accepts, named after its folder',
    (name) => {
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillFile(harness, name))?.[1];

      expect(frontmatter).toBeDefined();

      const fields = new Map(
        (frontmatter ?? '').split('\n').map((line) => {
          const colon = line.indexOf(': ');

          return [line.slice(0, colon), line.slice(colon + 2)] as const;
        }),
      );
      const description = fields.get('description') ?? '';

      // The Agent Skills format: name is lowercase words and hyphens, at most 64 characters (Codex
      // enforces the 64), and matches the folder.
      expect(fields.get('name')).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      // Required by Codex; at most 1,024 characters in the Agent Skills format (Claude Code cuts
      // the listing at 1,536).
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(1024);
      // A plain YAML scalar: a ": " or a leading quote or indicator would change how it parses.
      expect(description).not.toContain(': ');
      expect(description).not.toMatch(/^[`'"&*!|>%@[{#-]/);
      expect([...fields.keys()]).toStrictEqual(['name', 'description']);
    },
  );

  it('the business-apps description leads with its use case', () => {
    expect(skillFile(harness, 'kizen-business-apps')).toContain(
      '\ndescription: Publish, preview, merge, roll back or pull this plugin as a Kizen Business App with `appbuilder app`',
    );
  });
});

/** The command a code span names (`appbuilder block push …`) and the flags it uses. */
function commandOf(
  program: Command,
  span: string,
): { command: Command; path: string; flags: string[] } {
  const tokens = span.split(/\s+/).slice(1);
  let command = program;
  const path = ['appbuilder'];

  for (const token of tokens) {
    const sub = command.commands.find((candidate) => candidate.name() === token);

    if (sub === undefined) {
      break;
    }

    command = sub;
    path.push(token);
  }

  const flags = tokens
    .map((token) => token.replace(/^[[(|]+|[\])|,.]+$/g, ''))
    .filter((token) => /^--?[a-z]/.test(token))
    .map((token) => token.split('=')[0] ?? token);

  return { command, path: path.join(' '), flags };
}

const flagsOf = (command: Command): Set<string> =>
  new Set(
    command.options.flatMap((option) => [option.long, option.short]).filter(Boolean),
  ) as Set<string>;

const allCommands = (command: Command): Command[] => [
  command,
  ...command.commands.flatMap(allCommands),
];

const codeSpans = (markdown: string): string[] =>
  [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => (match[1] ?? '').trim());

describe.each(HARNESS_CASES)(
  'the $harness skills name only real commands and flags',
  ({ harness }) => {
    const program = createProgram();
    const appSubcommands = program.commands.find((command) => command.name() === 'app')?.commands;
    const everyFlag = new Set(allCommands(program).flatMap((command) => [...flagsOf(command)]));
    // Every `appbuilder app …` command's, nested ones (`app actions link`) included.
    const appCommands = (appSubcommands ?? []).flatMap(allCommands);
    const appFlags = new Set(appCommands.flatMap((command) => [...flagsOf(command)]));
    /** A command's runnable path: itself, or each command a group (`app actions`) holds. */
    const leafPaths = (command: Command, path: string): string[] =>
      command.commands.length === 0
        ? [path]
        : command.commands.flatMap((sub) => leafPaths(sub, `${path} ${sub.name()}`));

    it.each(MANAGED_SKILL_NAMES)(
      '%s: every `appbuilder …` span is a command with its flags',
      (name) => {
        const commandSpans = codeSpans(skillFile(harness, name)).filter((span) =>
          span.startsWith('appbuilder '),
        );

        expect(commandSpans.length).toBeGreaterThan(0);

        for (const span of commandSpans) {
          const { command, path, flags } = commandOf(program, span);

          // A span names at least one real command, and its words all resolve: a group (`appbuilder
          // app`) only on its own, with nothing after it that isn't a subcommand.
          expect(path, span).not.toBe('appbuilder');

          if (command.commands.length > 0) {
            expect(path, span).toBe(span);
          }

          for (const flag of flags) {
            expect(flagsOf(command).has(flag), `${flag} in \`${span}\``).toBe(true);
          }
        }
      },
    );

    it('the business-apps skill covers every app subcommand, each of a group included', () => {
      const named = new Set(
        codeSpans(skillFile(harness, 'kizen-business-apps'))
          .filter((span) => span.startsWith('appbuilder app '))
          .map((span) => commandOf(program, span).path),
      );

      expect([...named].sort()).toStrictEqual(
        (appSubcommands ?? [])
          .flatMap((command) => leafPaths(command, `appbuilder app ${command.name()}`))
          .sort(),
      );
    });

    it.each(MANAGED_SKILL_NAMES)('%s: every flag span is a flag the CLI declares', (name) => {
      // The business-apps skill's flags belong to `appbuilder app`; the block skill's to any command.
      const known = name === 'kizen-business-apps' ? appFlags : everyFlag;
      const flagSpans = codeSpans(skillFile(harness, name))
        .filter((span) => /^--?[a-z][a-z-]*(\/--[a-z-]+)?( <[^>]+>)?$/.test(span))
        .flatMap((span) => (span.split(' ')[0] ?? '').split('/'));

      expect(flagSpans.length).toBeGreaterThan(0);

      for (const flag of flagSpans) {
        expect(known.has(flag), `${flag} in ${name}`).toBe(true);
      }
    });
  },
);
