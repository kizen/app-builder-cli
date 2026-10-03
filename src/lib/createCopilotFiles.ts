import kizenCustomBlockSkill from '../templates/claude/skills/kizen-custom-block/SKILL.md?raw';
import kizenCustomBlockDesign from '../templates/claude/skills/kizen-custom-block/design.md?raw';
import copilotInstructions from '../templates/github/copilot-instructions.md?raw';
import securityInstructions from '../templates/github/instructions/security.instructions.md?raw';
import versionDisciplineInstructions from '../templates/github/instructions/version-discipline.instructions.md?raw';
import codeReviewWorkflow from '../templates/github/workflows/copilot-code-review.yml?raw';
import kizenDataLib from '../templates/plugin/lib/kizenData.js?raw';
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

/**
 * The Claude Code skill files, plus the Kizen data lib under each of `libEntryDirs`.
 * The lib is opt-in, so an empty list (the default) scaffolds only the skill.
 */
export function claudeFiles(libEntryDirs: readonly string[] = []): ScaffoldedFile[] {
  return [
    { path: '.claude/skills/kizen-custom-block/SKILL.md', content: kizenCustomBlockSkill },
    { path: '.claude/skills/kizen-custom-block/design.md', content: kizenCustomBlockDesign },
    ...[...new Set(libEntryDirs)].map((entryDir) => ({
      path: kizenDataLibPath(entryDir),
      content: kizenDataLib,
    })),
  ];
}
