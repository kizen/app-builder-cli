import { createElement } from 'react';
import { render } from 'ink';
import type { Command } from 'commander';
import { createDefaultAppDeps, type AppDeps } from '../lib/appFlow.js';
import {
  runAppActionsLinkHeadless,
  runAppActionsListHeadless,
  runAppActionsUnlinkHeadless,
  runAppMergeHeadless,
  runAppPreviewDeleteHeadless,
  runAppPublishHeadless,
  runAppPullHeadless,
  runAppPushHeadless,
  runAppRollbackHeadless,
  runAppVersionsHeadless,
  type AppActionsLinkOptions,
  type AppCommandOptions,
  type AppMergeCommandOptions,
  type AppPreviewDeleteOptions,
  type AppPublishOptions,
  type AppPushOptions,
  type AppPullOptions,
  type AppWriteOptions,
} from '../lib/appHeadless.js';
import {
  isProcessInteractive,
  NO_INTERACTIVE_HELP,
  takeInteractiveFlag,
  type Interactive,
} from '../lib/interactive.js';
import { AppUI } from '../ui/AppUI.js';
import type { AppRequest } from '../ui/appUiFlow.js';

const fail = (error: unknown): void => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
};

const withCredentialFlags = (command: Command): Command =>
  command
    .option(
      '-c, --credentials <path>',
      'path to an API-key credentials JSON file (deprecated; replaces the sign-in session)',
    )
    .option(
      '--profile <name>',
      'stored API-key credential profile to use (deprecated; replaces the sign-in session)',
    );

const withSessionFlags = (command: Command): Command =>
  command
    .option('--json', 'print a JSON result to stdout (always headless)')
    .option('--no-interactive', NO_INTERACTIVE_HELP)
    .option('--env <env>', 'environment of the `appbuilder login` session to use')
    .option(
      '--business <id-or-name>',
      'use this saved account, by business id or name (ignoring case), instead of the current one (default: $APPBUILDER_BUSINESS)',
    )
    .option(
      '--user <userId>',
      'with --business, use the saved account of this user id (default: $APPBUILDER_USER)',
    );

const withWriteFlags = (command: Command, production = true): Command => {
  command
    .option('--dry-run', 'show what would change without writing anything')
    .option('--yes', 'write without asking (without it, the command is a dry run)');

  return production ? command.option('--allow-production', 'allow writes to go/fmo') : command;
};

/**
 * Runs `request` in the interactive UI when `isInteractive` says a person is at the terminal,
 * else with `headless` (where write commands are dry runs without --yes).
 */
async function runApp(
  request: AppRequest,
  noInteractive: boolean,
  headless: (deps: AppDeps) => Promise<void>,
): Promise<void> {
  try {
    const deps = createDefaultAppDeps(process.cwd());

    if (!isProcessInteractive({ json: request.options.json === true, noInteractive })) {
      await headless(deps);

      return;
    }

    const { waitUntilExit } = render(createElement(AppUI, { request, deps }), {
      exitOnCtrlC: false,
    });

    await waitUntilExit();
  } catch (error) {
    fail(error);
  }
}

/** `appbuilder app actions …`: which objects the app's JS actions are linked to. */
function actionsCommand(app: Command): void {
  const actions = app
    .command('actions')
    .description("Link the app's JS actions to objects: list, link and unlink");
  const list = withCredentialFlags(
    actions
      .command('list')
      .description("Show the app's JS actions and the objects they're linked to"),
  );

  withSessionFlags(list).action(async (parsed: AppCommandOptions & Interactive) => {
    const { noInteractive, options } = takeInteractiveFlag(parsed);

    await runApp({ command: 'actions list', options }, noInteractive, (deps) =>
      runAppActionsListHeadless(options, deps),
    );
  });

  // Optional only so a terminal can pick them: a headless run without both is a usage_error.
  const link = withCredentialFlags(
    actions
      .command('link')
      .description('Link a JS action to an object, or change whether it shows in its menus')
      .argument('[action]', "the JS action's api_name (at a terminal, leave it out to pick it)")
      .argument('[object]', "the object's api name (like client_client) or id"),
  )
    .option('--menu', "show the action in the object's Perform Action menus")
    .option('--no-menu', "don't show it there (the default for a new link)");

  withSessionFlags(withWriteFlags(link)).action(
    async (
      action: string | undefined,
      object: string | undefined,
      parsed: AppActionsLinkOptions & Interactive,
    ) => {
      const { noInteractive, options } = takeInteractiveFlag(parsed);

      await runApp(
        {
          command: 'actions link',
          ...(action !== undefined && { action }),
          ...(object !== undefined && { object }),
          options,
        },
        noInteractive,
        (deps) => runAppActionsLinkHeadless(action, object, options, deps),
      );
    },
  );

  const unlink = withCredentialFlags(
    actions
      .command('unlink')
      .description("Remove a JS action's link to an object")
      .argument('[action]', "the JS action's api_name (at a terminal, leave it out to pick a link)")
      .argument('[object]', "the object's api name (like client_client) or id"),
  );

  withSessionFlags(withWriteFlags(unlink)).action(
    async (
      action: string | undefined,
      object: string | undefined,
      parsed: AppWriteOptions & Interactive,
    ) => {
      const { noInteractive, options } = takeInteractiveFlag(parsed);

      await runApp(
        {
          command: 'actions unlink',
          ...(action !== undefined && { action }),
          ...(object !== undefined && { object }),
          options,
        },
        noInteractive,
        (deps) => runAppActionsUnlinkHeadless(action, object, options, deps),
      );
    },
  );
}

/** `appbuilder app preview …`: the app's previews, yours or another developer's. */
function previewCommand(app: Command): void {
  const preview = app.command('preview').description("Manage the app's previews: delete");
  const remove = withCredentialFlags(
    preview
      .command('delete')
      .description("Delete your preview of the app, or with --owner, another developer's"),
  )
    .option('--owner <userId>', "delete this user's preview instead of yours")
    .option(
      '--expect-updated <ts>',
      "delete only if the preview's last update is still <ts> (a dry run prints it)",
    )
    .option(
      '--delete-app',
      'allow deleting the whole app when this preview is its only version (a dry run that says so prints it)',
    );

  withSessionFlags(withWriteFlags(remove)).action(
    async (parsed: AppPreviewDeleteOptions & Interactive) => {
      const { noInteractive, options } = takeInteractiveFlag(parsed);

      await runApp({ command: 'preview delete', options }, noInteractive, (deps) =>
        runAppPreviewDeleteHeadless(options, deps),
      );
    },
  );
}

/**
 * `appbuilder app …`: the Business App of the plugin in the current folder. At a terminal each
 * subcommand runs interactively and asks before writing; otherwise it runs headless, where write
 * commands are dry runs without --yes. Flags go in the order block push uses: credentials, the
 * command's own, write flags, then the session flags.
 */
export function appCommand(program: Command): void {
  const app = program
    .command('app')
    .description('Publish the plugin as a Business App: previews, releases, merges and rollbacks');
  const versions = withCredentialFlags(
    app.command('versions').description("Show the app's Live, released and preview versions"),
  );

  withSessionFlags(versions).action(async (parsed: AppCommandOptions & Interactive) => {
    const { noInteractive, options } = takeInteractiveFlag(parsed);

    await runApp({ command: 'versions', options }, noInteractive, (deps) =>
      runAppVersionsHeadless(options, deps),
    );
  });

  const push = withCredentialFlags(
    app.command('push').description('Save this folder as your preview of the app'),
  );

  withSessionFlags(
    withWriteFlags(push)
      .option('--force', 'push even if files still have merge conflict markers')
      // Placeholder copy.
      .option(
        '--base-from-preview <id>',
        "take this folder's base from your preview, while it's still source package <id> (a base_required choice prints it)",
      ),
  ).action(async (parsed: AppPushOptions & Interactive) => {
    const { noInteractive, options } = takeInteractiveFlag(parsed);

    await runApp({ command: 'push', options }, noInteractive, (deps) =>
      runAppPushHeadless(options, deps),
    );
  });

  const publish = withCredentialFlags(
    app.command('publish').description('Publish your preview as the next Live version'),
  );

  withSessionFlags(
    withWriteFlags(publish)
      // Placeholder copy.
      .option(
        '--force',
        'publish even if Live changed since your preview was based on it, or its base is unknown',
      )
      // Placeholder copy.
      .option(
        '--expect-preview <id>',
        "publish only if your preview's source package is still <id> (a dry run prints it)",
      ),
  ).action(async (parsed: AppPublishOptions & Interactive) => {
    const { noInteractive, options } = takeInteractiveFlag(parsed);

    await runApp({ command: 'publish', options }, noInteractive, (deps) =>
      runAppPublishHeadless(options, deps),
    );
  });

  const merge = withCredentialFlags(
    app.command('merge').description('Merge the Live version (or --release) into this folder'),
  )
    .option('--release <n>', 'merge release <n> instead of the Live version')
    .option(
      '--base <n>',
      'the release this folder was copied from, when no base is recorded (a wrong one drops the changes made since)',
    )
    .option(
      '--accept-live-base',
      "record Live (or --release) as this folder's base without merging, after merging by hand",
    );

  withSessionFlags(withWriteFlags(merge, false)).action(
    async (parsed: AppMergeCommandOptions & Interactive) => {
      const { noInteractive, options } = takeInteractiveFlag(parsed);

      await runApp({ command: 'merge', options }, noInteractive, (deps) =>
        runAppMergeHeadless(options, deps),
      );
    },
  );

  const rollback = withCredentialFlags(
    app
      .command('rollback')
      .description('Restore a released version as your preview')
      .argument('<version>', 'the released version to restore'),
  );

  withSessionFlags(withWriteFlags(rollback)).action(
    async (version: string, parsed: AppWriteOptions & Interactive) => {
      const { noInteractive, options } = takeInteractiveFlag(parsed);

      await runApp({ command: 'rollback', version, options }, noInteractive, (deps) =>
        runAppRollbackHeadless(version, options, deps),
      );
    },
  );

  const pull = withCredentialFlags(
    app
      .command('pull')
      .description("Download a released version's source into a new folder")
      .argument('<version>', 'the released version to download'),
  ).option('--out <dir>', 'folder to create (default: ../<api_name>-v<version>)');

  withSessionFlags(pull).action(async (version: string, parsed: AppPullOptions & Interactive) => {
    const { noInteractive, options } = takeInteractiveFlag(parsed);

    await runApp({ command: 'pull', version, options }, noInteractive, (deps) =>
      runAppPullHeadless(version, options, deps),
    );
  });

  actionsCommand(app);
  previewCommand(app);
}
