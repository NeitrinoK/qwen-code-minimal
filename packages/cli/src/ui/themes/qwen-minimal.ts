/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from './theme.js';
import { darkSemanticColors } from './semantic-tokens.js';
import { qwenDarkColors, qwenDarkSyntaxStyles } from './qwen-dark.js';

/**
 * Signature gradient for the Qwen Minimal fork: violet → magenta → amber.
 * The startup banner is rendered from `semanticColors.ui.gradient`, so the
 * gradient is set on the semantic colors below (not just `GradientColors`,
 * which the banner does not read).
 */
const QWEN_MINIMAL_GRADIENT = ['#7C3AED', '#DB2777', '#F59E0B'];

const qwenMinimalColors: ColorsTheme = {
  ...qwenDarkColors,
  GradientColors: QWEN_MINIMAL_GRADIENT,
};

/**
 * Qwen Minimal — identical to Qwen Dark in every syntax and UI color, but
 * carrying the fork's brand gradient. This is the default theme, so the
 * banner shows the brand colors out of the box while remaining overridable
 * per user via the theme picker.
 */
export const QwenMinimal: Theme = new Theme(
  'Qwen Minimal',
  'dark',
  qwenDarkSyntaxStyles,
  qwenMinimalColors,
  {
    ...darkSemanticColors,
    ui: { ...darkSemanticColors.ui, gradient: QWEN_MINIMAL_GRADIENT },
  },
);
