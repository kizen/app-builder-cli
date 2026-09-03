import copilotInstructions from '../templates/github/copilot-instructions.md?raw';
import securityInstructions from '../templates/github/instructions/security.instructions.md?raw';
import versionDisciplineInstructions from '../templates/github/instructions/version-discipline.instructions.md?raw';
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
