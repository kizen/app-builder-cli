import kizenCustomBlockSkill from '../templates/claude/skills/kizen-custom-block/SKILL.md?raw';
import kizenCustomBlockDesign from '../templates/claude/skills/kizen-custom-block/design.md?raw';
import copilotInstructions from '../templates/github/copilot-instructions.md?raw';
import securityInstructions from '../templates/github/instructions/security.instructions.md?raw';
import versionDisciplineInstructions from '../templates/github/instructions/version-discipline.instructions.md?raw';
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
  ];
}

export const KIZEN_DATA_LIB_FILE = 'lib/kizenData.js';

export const kizenDataLibPath = (entryDir = 'src'): string =>
  entryDir === '' ? KIZEN_DATA_LIB_FILE : `${entryDir}/${KIZEN_DATA_LIB_FILE}`;

export function claudeFiles(entryDirs: readonly string[] = ['src']): ScaffoldedFile[] {
  return [
    { path: '.claude/skills/kizen-custom-block/SKILL.md', content: kizenCustomBlockSkill },
    { path: '.claude/skills/kizen-custom-block/design.md', content: kizenCustomBlockDesign },
    ...[...new Set(entryDirs)].map((entryDir) => ({
      path: kizenDataLibPath(entryDir),
      content: kizenDataLib,
    })),
  ];
}
