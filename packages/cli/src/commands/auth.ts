/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { t } from '../i18n/index.js';

const shouldUseColor = () =>
  Boolean(process.stdout.isTTY && !process.env['NO_COLOR']);

const color = (value: string, code: string) =>
  shouldUseColor() ? `\x1b[${code}m${value}\x1b[0m` : value;

const cyan = (value: string) => color(value, '36');
const yellow = (value: string) => color(value, '33');

export const buildRemovalNotice = (): string =>
  [
    '',
    yellow(t('⚠  qwen auth has been removed.')),
    '',
    `  ${cyan(t('Interactive'))}   →  ${t('run qwen and use /auth to configure providers')}`,
    `  ${cyan(t('CI / Headless'))} →  ${t('set provider environment variables, for example OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL')}`,
    `                     ${t('or pass --openai-api-key, --openai-base-url, --model')}`,
    `  ${cyan(t('Requesty'))}      →  ${t('set REQUESTY_API_KEY and OPENAI_BASE_URL=https://router.requesty.ai/v1')}`,
    `  ${cyan(t('Scripted'))}      →  ${t('edit ~/.qwen/settings.json, or run qwen interactively once')}`,
    '',
    `  ${t('Check auth status')} → ${cyan('/doctor')}`,
    '',
  ].join('\n');

export const printRemovalNotice = () => {
  process.stdout.write(buildRemovalNotice(), () => process.exit(0));
};

const legacySubcommands = ['status', 'requesty', 'api-key'];

export const authCommand: CommandModule = {
  command: 'auth',
  describe: t('Configure authentication (removed)'),
  builder: (yargs: Argv) => {
    let y = yargs.version(false).strict(false);
    for (const name of legacySubcommands) {
      y = y.command({
        command: `${name} [legacyArgs..]`,
        describe: false,
        builder: (subYargs: Argv) => subYargs.strict(false),
        handler: printRemovalNotice,
      });
    }
    return y;
  },
  handler: printRemovalNotice,
};
