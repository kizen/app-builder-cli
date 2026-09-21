import type { Command } from 'commander';
import { precheckTargetDir } from '../lib/createPlugin.js';
import { setupCopilot } from '../lib/setupCopilot.js';

export function setupCopilotCommand(program: Command): void {
  program
    .command('setup-copilot')
    .description('Add or refresh the Copilot code-review setup in an existing plugin repo')
    .option('--dry-run', 'report what would change without writing anything')
    .action(async (options: { dryRun?: boolean }) => {
      const pluginDir = process.cwd();

      if ((await precheckTargetDir(pluginDir)) !== 'has-manifest') {
        console.error(
          `No kizen.json found in ${pluginDir} — run "appbuilder setup-copilot" from the root of a plugin repo.`,
        );

        process.exitCode = 1;

        return;
      }

      const dryRun = options.dryRun === true;

      try {
        const result = await setupCopilot(pluginDir, { dryRun });

        for (const file of result.files) {
          console.log(`${file.status.padEnd(9)} ${file.path}`);
        }

        if (dryRun) {
          console.log('\nDry run — no files and no .gitignore entries were written.');

          return;
        }

        console.log('\nEnsured .gitignore ignores .kizenapp/ and .copilot-docs/.');

        console.log(
          'The code review workflow only takes effect once it is on the repository default branch — merge it before expecting reviews to cite .copilot-docs/.',
        );
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);

        process.exitCode = 1;
      }
    });
}
