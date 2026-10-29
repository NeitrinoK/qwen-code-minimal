/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

/**
 * Round a token count to thousands for display: 42000 -> "42k".
 */
function formatTokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : `${count}`;
}

/**
 * Shows what a request costs before the conversation contributes anything:
 * how many skills this session has actually invoked, out of the catalog that
 * is injected into every request regardless, plus the fixed prompt overhead
 * (system prompt + skill catalog + MCP tool catalog + tool schemas).
 *
 * `basePromptTokenCount` is the provider-reported prompt count of the
 * session's first request, so it is 0 until that response lands — the
 * overhead segment is omitted rather than shown as zero.
 */
export const PromptOverheadDisplay = ({
  invokedSkillCount,
  catalogSkillCount,
  basePromptTokenCount,
  terminalWidth,
}: {
  invokedSkillCount: number;
  catalogSkillCount: number;
  basePromptTokenCount: number;
  terminalWidth: number;
}) => {
  if (catalogSkillCount === 0) {
    return null;
  }

  const isNarrow = terminalWidth < 100;
  const skillsLabel = isNarrow ? t('sk') : t('skills');
  const counts = `${invokedSkillCount}/${catalogSkillCount} ${skillsLabel}`;

  const overhead =
    basePromptTokenCount > 0
      ? ` · ${formatTokens(basePromptTokenCount)}${isNarrow ? '' : ` ${t('base')}`}`
      : '';

  return (
    <Text color={theme.text.secondary}>
      {counts}
      {overhead}
    </Text>
  );
};
