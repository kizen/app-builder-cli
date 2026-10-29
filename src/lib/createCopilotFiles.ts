import kizenBusinessAppsSkill from '../templates/claude/skills/kizen-business-apps/SKILL.md?raw';
import kizenCustomBlockSkill from '../templates/claude/skills/kizen-custom-block/SKILL.md?raw';
import kizenCustomBlockDesign from '../templates/claude/skills/kizen-custom-block/design.md?raw';
import copilotInstructions from '../templates/github/copilot-instructions.md?raw';
import securityInstructions from '../templates/github/instructions/security.instructions.md?raw';
import versionDisciplineInstructions from '../templates/github/instructions/version-discipline.instructions.md?raw';
import codeReviewWorkflow from '../templates/github/workflows/copilot-code-review.yml?raw';
import kizenDataLib from '../templates/plugin/lib/kizenData.js?raw';
import {
  AGENT_HARNESS_INFO,
  MANAGED_SKILL_NAMES,
  renderSkillTemplate,
  type AgentHarness,
  type ManagedSkillName,
} from './agentHarness.js';
import type { ScaffoldedFile } from './createArtifacts.js';

export function copilotFiles(): ScaffoldedFile[] {
  return [
    { path: '.github/copilot-instructions.md', content: copilotInstructions },
    { path: '.github/instructions/security.instructions.md', content: securityInstructions },
    {
      path: '.github/instructions/version-discipline.instructions.md',
      content: versionDisciplineInstructions,
    },
    { path: '.github/workflows/copilot-code-review.yml', content: codeReviewWorkflow },
  ];
}

export const KIZEN_DATA_LIB_FILE = 'lib/kizenData.js';

export const kizenDataLibPath = (entryDir = 'src'): string =>
  entryDir === '' ? KIZEN_DATA_LIB_FILE : `${entryDir}/${KIZEN_DATA_LIB_FILE}`;

const SKILL_TEMPLATES: Readonly<Record<ManagedSkillName, readonly [string, string][]>> = {
  'kizen-custom-block': [
    ['SKILL.md', kizenCustomBlockSkill],
    ['design.md', kizenCustomBlockDesign],
  ],
  'kizen-business-apps': [['SKILL.md', kizenBusinessAppsSkill]],
};

export { MANAGED_SKILL_NAMES };

export const managedSkillEntryPaths = (harness: AgentHarness): string[] =>
  MANAGED_SKILL_NAMES.map((name) => `${AGENT_HARNESS_INFO[harness].skillsDir}/${name}/SKILL.md`);

export function agentFiles(
  harness: AgentHarness,
  libEntryDirs: readonly string[] = [],
): ScaffoldedFile[] {
  const { skillsDir } = AGENT_HARNESS_INFO[harness];

  return [
    ...MANAGED_SKILL_NAMES.flatMap((name) =>
      SKILL_TEMPLATES[name].map(([file, template]) => ({
        path: `${skillsDir}/${name}/${file}`,
        content: renderSkillTemplate(template, harness),
      })),
    ),
    ...[...new Set(libEntryDirs)].map((entryDir) => ({
      path: kizenDataLibPath(entryDir),
      content: kizenDataLib,
    })),
  ];
}

export const claudeFiles = (libEntryDirs: readonly string[] = []): ScaffoldedFile[] =>
  agentFiles('claude', libEntryDirs);

export const codexFiles = (libEntryDirs: readonly string[] = []): ScaffoldedFile[] =>
  agentFiles('codex', libEntryDirs);
