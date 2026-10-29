/**
 * The coding agents appbuilder writes skills for. One template per skill file serves every
 * harness: `renderSkillTemplate` fills in what differs (where the harness looks for skills, the
 * command that refreshes them, the out-of-date warning) and keeps only the harness's own blocks.
 */
export type AgentHarness = 'claude' | 'codex';

export const AGENT_HARNESSES: readonly AgentHarness[] = ['claude', 'codex'];

export interface AgentHarnessInfo {
  /** How the setup command's summary names the files ("Claude files: …"). */
  filesLabel: string;
  /** Where the harness discovers project skills, relative to the plugin root. */
  skillsDir: string;
  /** The command that installs or refreshes this harness's managed files. */
  setupCommand: string;
  /** The warning a command adds when this harness's managed files are out of date. */
  staleWarning: string;
}

export const AGENT_HARNESS_INFO: Readonly<Record<AgentHarness, AgentHarnessInfo>> = {
  claude: {
    filesLabel: 'Claude',
    skillsDir: '.claude/skills',
    setupCommand: 'appbuilder setup-claude',
    staleWarning: 'Claude files managed by appbuilder are out of date; run appbuilder setup-claude',
  },
  codex: {
    filesLabel: 'Codex',
    skillsDir: '.agents/skills',
    setupCommand: 'appbuilder setup-codex',
    staleWarning: 'Codex files managed by appbuilder are out of date; run appbuilder setup-codex',
  },
};

/** The skills appbuilder writes and manages for every harness (createCopilotFiles holds their templates). */
export const MANAGED_SKILL_NAMES = ['kizen-custom-block', 'kizen-business-apps'] as const;

export type ManagedSkillName = (typeof MANAGED_SKILL_NAMES)[number];

/**
 * Every managed skill folder, for every harness, relative to the plugin root (`.claude/skills/
 * kizen-custom-block`, …). The CLI rewrites these, so they're never part of an app's source.
 */
export const MANAGED_SKILL_DIRS: readonly string[] = AGENT_HARNESSES.flatMap((harness) =>
  MANAGED_SKILL_NAMES.map((name) => `${AGENT_HARNESS_INFO[harness].skillsDir}/${name}`),
);

const TOKENS: Readonly<Record<string, (info: AgentHarnessInfo) => string>> = {
  SKILLS_DIR: (info) => info.skillsDir,
  SETUP_COMMAND: (info) => info.setupCommand,
  STALE_WARNING: (info) => info.staleWarning,
};

const BLOCK_LINE = /^\{\{([#/])(claude|codex)\}\}$/;

/**
 * A skill template for one harness. `{{SKILLS_DIR}}`, `{{SETUP_COMMAND}}` and `{{STALE_WARNING}}`
 * are replaced; lines between `{{#claude}}` and `{{/claude}}` (or the codex pair), each marker on a
 * line of its own, are kept only for that harness. Throws on an unknown token or an unbalanced
 * block, so a template mistake fails the tests instead of shipping braces to an agent.
 */
export function renderSkillTemplate(template: string, harness: AgentHarness): string {
  const info = AGENT_HARNESS_INFO[harness];
  const kept: string[] = [];
  let open: string | undefined;

  for (const line of template.split('\n')) {
    const marker = BLOCK_LINE.exec(line);

    if (marker !== null) {
      const [, kind, name] = marker;

      if (kind === '#' && open === undefined) {
        open = name;
      } else if (kind === '/' && open === name) {
        open = undefined;
      } else {
        throw new Error(`Unbalanced skill template block: ${line}`);
      }

      continue;
    }

    if (open === undefined || open === harness) {
      kept.push(line);
    }
  }

  if (open !== undefined) {
    throw new Error(`Unclosed skill template block: {{#${open}}}`);
  }

  return kept.join('\n').replace(/\{\{([^}]*)\}\}/g, (token, name: string) => {
    const value = TOKENS[name];

    if (value === undefined) {
      throw new Error(`Unknown skill template token: ${token}`);
    }

    return value(info);
  });
}
