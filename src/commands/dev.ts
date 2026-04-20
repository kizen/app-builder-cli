import { createElement } from 'react';
import { render } from 'ink';
import type { Command } from 'commander';
import { DevUI } from '../ui/DevUI.js';
import { CredentialSetupUI } from '../ui/CredentialSetupUI.js';
import type { CredentialMode, CredentialSetupResult } from '../ui/CredentialSetupUI.js';
import {
  loadCredentialProfile,
  loadCredentialsFromFile,
  loadGlobalCredentials,
} from '../lib/credentials.js';
import type { Credentials } from '../lib/credentials.js';
import { loadConfig, saveConfig } from '../lib/config.js';
import { ensureGitignore } from '../lib/gitignore.js';

async function runSetupUI(initialMode?: CredentialMode): Promise<CredentialSetupResult> {
  return new Promise((resolve) => {
    let unmountFn: (() => void) | null = null;
    const handleComplete = (result: CredentialSetupResult): void => {
      unmountFn?.();

      resolve(result);
    };

    const { unmount } = render(
      createElement(CredentialSetupUI, {
        ...(initialMode !== undefined && { initialMode }),
        onComplete: handleComplete,
      }),
      { exitOnCtrlC: false },
    );

    unmountFn = unmount;
  });
}

export function devCommand(program: Command): void {
  program
    .command('dev')
    .description('Start the plugin viewer dev server')
    .option('-p, --port <port>', 'port to listen on', '3121')
    .option('-c, --credentials <path>', 'path to a credentials JSON file')
    .option('-d, --debug', 'Enable CDP lifecycle logs in the TUI')
    .option('-v, --verbose', 'Log every CDP event and handled error (implies --debug)')
    .action(
      async (options: {
        port: string;
        credentials?: string;
        debug?: boolean;
        verbose?: boolean;
      }) => {
        const port = parseInt(options.port, 10);
        const pluginDir = process.cwd();
        const outputDir = `${pluginDir}/.kizenapp`;

        ensureGitignore(pluginDir);

        let credentials: Credentials | null = null;
        let credentialMode: CredentialMode | undefined;
        let activeCredentialProfile: string | undefined;
        const { lastPath } = await loadConfig(outputDir);

        if (options.credentials) {
          credentials = await loadCredentialsFromFile(options.credentials);
        } else {
          const config = await loadConfig(outputDir);

          if (config.credentialMode === 'local') {
            credentialMode = 'local';
          } else if (config.credentialMode === 'global') {
            credentialMode = 'global';

            activeCredentialProfile = config.activeCredentialProfile;

            // Load silently — only show TUI if the file was deleted since last run
            if (activeCredentialProfile) {
              credentials = await loadCredentialProfile(activeCredentialProfile);

              if (!credentials) {
                // Named profile file missing, fall back to default
                credentials = await loadGlobalCredentials();

                activeCredentialProfile = undefined;
              }
            } else {
              credentials = await loadGlobalCredentials();
            }

            if (!credentials) {
              const result = await runSetupUI('global');

              credentials = result.credentials;

              activeCredentialProfile = result.profileName;
            }
          } else {
            // First run — show full mode selection TUI
            const result = await runSetupUI();

            credentials = result.credentials;

            credentialMode = result.mode;

            activeCredentialProfile = result.profileName;

            const profile = result.profileName;

            await saveConfig(outputDir, {
              credentialMode: result.mode,
              ...(profile !== undefined && { activeCredentialProfile: profile }),
            });
          }
        }

        const verbose = options.verbose === true;
        const debug = verbose || options.debug === true;

        const { waitUntilExit } = render(
          createElement(DevUI, {
            port,
            pluginDir,
            outputDir,
            credentials,
            ...(credentialMode !== undefined && { credentialMode }),
            ...(activeCredentialProfile !== undefined && { activeCredentialProfile }),
            ...(lastPath !== undefined && { lastPath }),
            debug,
            verbose,
          }),
          { exitOnCtrlC: false },
        );

        await waitUntilExit();
      },
    );
}
