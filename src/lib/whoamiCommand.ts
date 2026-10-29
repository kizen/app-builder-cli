/**
 * `appbuilder whoami`: the text output is `runWhoami`'s; `--json` prints the identity as one JSON
 * object with the headless commands' failure contract (`not_signed_in` with the login to run,
 * `needs_choice` among environments with exit 2, any other failure exit 1).
 */
import { accountRequest } from './authSelection.js';
import {
  accountArgs,
  apiFailure,
  commandArgv,
  connectSession,
  failure,
  writeFailure,
  writeResult,
  type ChoiceArgv,
  type CommandOutput,
} from './commandCore.js';
import {
  identityLines,
  runWhoami,
  type AuthCommand,
  type WhoamiCommandOptions,
} from './oauthCommands.js';

export interface WhoamiOptions extends WhoamiCommandOptions {
  json?: boolean;
}

const runWhoamiJson: AuthCommand<WhoamiOptions> = async (options, deps) => {
  const output: CommandOutput = { json: true, deps };
  // An environment choice re-runs whoami with its --env (replacing the run's) and the run's account.
  const choiceArgv: ChoiceArgv<'environment'> = (choice) =>
    commandArgv(
      'appbuilder whoami',
      [...choice.args, ...accountArgs(options, deps.processEnv)],
      output,
    );

  try {
    const request = accountRequest(options, deps.processEnv);

    if (!request.ok) {
      writeFailure(output, failure('usage_error', request.message), choiceArgv);

      return;
    }

    const session = await connectSession(options.env, request.request, {
      sessions: deps.store,
      connect: (environment, account) =>
        deps.identify(
          deps.tokenProvider(environment, account === undefined ? undefined : { account }),
        ),
      processEnv: deps.processEnv,
    });

    if (!session.ok) {
      writeFailure(output, session, choiceArgv);

      return;
    }

    const { environment, connected: identity } = session.value;

    writeResult(
      output,
      {
        ok: true,
        environment,
        businessId: identity.businessId,
        businessName: identity.businessName ?? null,
        userId: identity.userId,
        fullName: identity.fullName ?? null,
        email: identity.email ?? null,
      },
      identityLines(environment, identity),
    );
  } catch (error) {
    writeFailure(output, apiFailure(error), choiceArgv);
  }
};

export const runWhoamiCommand: AuthCommand<WhoamiOptions> = (options, deps) =>
  options.json === true ? runWhoamiJson(options, deps) : runWhoami(options, deps);
