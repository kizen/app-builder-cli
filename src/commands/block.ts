import { createElement } from 'react';
import { render } from 'ink';
import type { Command } from 'commander';
import { PluginValidationError } from '@kizenapps/packager';
import { copyToClipboard } from '../lib/clipboard.js';
import { exportBlock, toExportJson } from '../lib/exportBlock.js';
import { formatValidationIssues } from '../lib/formatValidationIssues.js';
import {
  createDefaultPushDeps,
  runPushHeadless,
  runTargetsHeadless,
  type PushCommandOptions,
  type TargetsCommandOptions,
} from '../lib/pushHeadless.js';
import { PushUI } from '../ui/PushUI.js';

const describeError = (error: unknown): string => {
  if (error instanceof PluginValidationError) {
    return formatValidationIssues(error.issues);
  }

  return `Error: ${error instanceof Error ? error.message : String(error)}`;
};

export function blockCommand(program: Command): void {
  const block = program.command('block').description('Work with plugin content blocks');

  block
    .command('export')
    .description('Print one packaged block as JSON for the Custom Block (AI Coded) paste editor')
    .argument('[api_name]', 'api_name of the block to export (optional when there is only one)')
    .option('--copy', 'also copy the JSON to the clipboard')
    .action(async (apiName: string | undefined, options: { copy?: boolean }) => {
      try {
        const result = await exportBlock(process.cwd(), apiName);
        const { block: exported, warnings } = result;

        if (warnings.length > 0) {
          console.error(formatValidationIssues(warnings));
        }

        const json = JSON.stringify(toExportJson(result), null, 2);

        console.log(json);

        if (options.copy) {
          console.error(
            (await copyToClipboard(json))
              ? `Copied block "${exported.api_name}" to the clipboard.`
              : "Couldn't copy to the clipboard; use the JSON printed to stdout instead.",
          );
        }
      } catch (error) {
        console.error(describeError(error));
        process.exitCode = 1;
      }
    });
  block
    .command('push')
    .description('Push a block to a Kizen dashboard, homepage or chart group dashlet')
    .argument('[api_name]', 'api_name of the block to push (optional when there is only one)')
    .option('-c, --credentials <path>', 'path to a credentials JSON file')
    .option('--profile <name>', 'stored credential profile to use')
    .option('--dashboard <id>', 'dashboard, homepage or chart group to push to')
    .option('--dashlet <id>', 'existing custom code dashlet to update (needs --dashboard)')
    .option('--create', 'create a new dashlet instead of updating one')
    .option('--dry-run', 'show the request without writing anything')
    .option('--yes', 'write without asking (headless runs are dry runs without it)')
    .option('--allow-production', 'allow headless writes to go/fmo')
    .option('--force', 'overwrite even if the block was edited in Kizen since the last push')
    .option('--forget', 'clear the remembered target for this block first')
    .option('--json', 'print a JSON result to stdout (always headless)')
    .action(async (apiName: string | undefined, options: PushCommandOptions) => {
      try {
        if (!process.stdin.isTTY || !process.stdout.isTTY || options.json === true) {
          await runPushHeadless(apiName, options, createDefaultPushDeps(process.cwd()));

          return;
        }

        const { waitUntilExit } = render(
          createElement(PushUI, {
            ...(apiName !== undefined && { apiName }),
            options,
            deps: createDefaultPushDeps(process.cwd()),
          }),
          { exitOnCtrlC: false },
        );

        await waitUntilExit();
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  block
    .command('targets')
    .description('List the dashboards, homepages and chart groups a block can be pushed to')
    .option('-c, --credentials <path>', 'path to a credentials JSON file')
    .option('--profile <name>', 'stored credential profile to use')
    .option('--object <id>', 'list the chart groups of this custom object')
    .option('--json', 'print a JSON result to stdout')
    .action(async (options: TargetsCommandOptions) => {
      try {
        await runTargetsHeadless(options, createDefaultPushDeps(process.cwd()));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
