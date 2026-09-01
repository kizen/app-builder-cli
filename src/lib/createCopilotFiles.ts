/**
 * GitHub Copilot instruction files `create` scaffolds into every new Kizen
 * plugin repo (KZN-17589 Phase 1, KZN-17594 AC 2.5).
 *
 * Copilot code review is advisory only: it posts PR comments and cannot fail
 * a check run. These files exist to get Copilot repeating the same review
 * rules the packager and webapp already enforce mechanically, plus the rules
 * neither enforces (version-bump discipline, secret hygiene), so a human
 * reviewer sees them called out before merge instead of discovering them at
 * publish time.
 *
 * The markdown lives under `src/templates/github/`, mirroring the `.github/`
 * layout it is scaffolded into. `copilot-instructions.md` applies repo-wide;
 * the two files under `instructions/` are path-scoped via GitHub's documented
 * `applyTo` frontmatter glob, so Copilot only loads them when reviewing
 * matching files.
 */
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
