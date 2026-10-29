/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';

import {
  ExtensionManager,
  parseInstallSource,
  type ExtensionScope,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  requestConsentOrFail,
  requestConsentNonInteractive,
} from './consent.js';
import { t, getCurrentLanguage } from '../../i18n/index.js';

interface InstallArgs {
  source: string;
  consent?: boolean;
  scope?: string;
}

// "workspace" is accepted as an alias of "project" to match enable/disable.
function normalizeScope(scope: string | undefined): ExtensionScope {
  return scope === 'project' || scope === 'workspace' ? 'project' : 'user';
}

export async function handleInstall(args: InstallArgs) {
  try {
    const installMetadata = await parseInstallSource(args.source);

    const requestConsent = args.consent
      ? () => Promise.resolve()
      : requestConsentOrFail.bind(null, requestConsentNonInteractive);
    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      locale: getCurrentLanguage(),
      isWorkspaceTrusted:
        isWorkspaceTrusted(loadSettings(workspaceDir).merged).isTrusted ?? true,
      requestConsent,
    });
    await extensionManager.refreshCache();

    const extension = await extensionManager.installExtension(
      installMetadata,
      requestConsent,
    );
    const scope = normalizeScope(args.scope);
    if (args.scope) {
      // installExtension auto-enables at the user (global) scope. For a
      // project-scoped install, re-scope enablement to this workspace only —
      // BEFORE recording the scope preference, so a failed Workspace enable
      // (which rolls back to User) can't leave the prefs claiming "project".
      if (scope === 'project') {
        await extensionManager.disableExtension(
          extension.name,
          SettingScope.User,
        );
        try {
          await extensionManager.enableExtension(
            extension.name,
            SettingScope.Workspace,
          );
        } catch (enableError) {
          // The User-scope disable already landed. If the Workspace enable
          // fails, the extension would be left disabled everywhere — roll the
          // User enable back so it isn't silently dead, then surface the error.
          try {
            await extensionManager.enableExtension(
              extension.name,
              SettingScope.User,
            );
          } catch (rollbackError) {
            // Rollback failed too: the extension is now disabled at every
            // scope. Surface this so the user knows recovery also failed,
            // before the original error is reported below.
            writeStderrLine(
              `Warning: failed to roll back the scope change for "${extension.name}"; it may be disabled at all scopes: ${getErrorMessage(rollbackError)}`,
            );
          }
          throw enableError;
        }
      }
      // Enablement succeeded (or scope is user/local with no enablement change):
      // now it's safe to persist the scope preference.
      extensionManager.setExtensionScope(extension.name, scope);
    }
    writeStdoutLine(
      scope === 'project'
        ? t(
            'Extension "{{name}}" installed successfully and enabled for the current workspace.',
            { name: extension.name },
          )
        : t('Extension "{{name}}" installed successfully and enabled.', {
            name: extension.name,
          }),
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export const installCommand: CommandModule = {
  command: 'install <source>',
  describe: t('Installs an extension from a local path.'),
  builder: (yargs) =>
    yargs
      .positional('source', {
        describe: t('The local path of the extension to install.'),
        type: 'string',
        demandOption: true,
      })
      .option('consent', {
        describe: t(
          'Acknowledge the security risks of installing an extension and skip the confirmation prompt.',
        ),
        type: 'boolean',
        default: false,
      })
      .option('scope', {
        describe: t(
          'The scope to install the extension in: "user" (global, default) or "project" (current workspace only).',
        ),
        type: 'string',
        choices: ['user', 'project', 'workspace'],
      })
      .check((argv) => {
        if (!argv.source) {
          throw new Error(t('The source argument must be provided.'));
        }
        return true;
      }),
  handler: async (argv) => {
    await handleInstall({
      source: argv['source'] as string,
      consent: argv['consent'] as boolean | undefined,
      scope: argv['scope'] as string | undefined,
    });
  },
};
