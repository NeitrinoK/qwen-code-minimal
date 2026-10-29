/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import {
  formatApprovalModeDescription,
  formatApprovalModeName,
} from './approvalModeDisplay.js';
import { setLanguageAsync } from '../../i18n/index.js';

describe('approval mode display', () => {
  describe('formatApprovalModeName', () => {
    it('formats all modes as friendly names', () => {
      expect(formatApprovalModeName(ApprovalMode.PLAN)).toBe('plan mode');
      expect(formatApprovalModeName(ApprovalMode.DEFAULT)).toBe(
        'Ask permissions',
      );
      expect(formatApprovalModeName(ApprovalMode.AUTO_EDIT)).toBe(
        'auto-accept edits',
      );
      expect(formatApprovalModeName(ApprovalMode.AUTO)).toBe('Auto mode');
      expect(formatApprovalModeName(ApprovalMode.YOLO)).toBe('YOLO mode');
    });

    it('formats mode names with the active locale', async () => {
      await setLanguageAsync('ru');
      try {
        expect(formatApprovalModeName(ApprovalMode.PLAN)).toBe(
          'Режим планирования',
        );
        expect(formatApprovalModeName(ApprovalMode.DEFAULT)).toBe(
          'Запрашивать разрешения',
        );
        expect(formatApprovalModeName(ApprovalMode.AUTO_EDIT)).toBe(
          'Режим принятия правок',
        );
        expect(formatApprovalModeName(ApprovalMode.AUTO)).toBe(
          'Автоматический режим',
        );
        expect(formatApprovalModeName(ApprovalMode.YOLO)).toBe('Режим YOLO');
      } finally {
        await setLanguageAsync('en');
      }
    });
  });

  describe('formatApprovalModeDescription', () => {
    it('uses a specific classifier description for auto mode', () => {
      expect(formatApprovalModeDescription(ApprovalMode.AUTO)).toBe(
        'Use classifier to automatically approve safe tool calls',
      );
    });

    it('describes the remaining modes', () => {
      expect(formatApprovalModeDescription(ApprovalMode.PLAN)).toBe(
        'Analyze only, do not modify files or execute commands',
      );
      expect(formatApprovalModeDescription(ApprovalMode.DEFAULT)).toBe(
        'Require approval for file edits or shell commands',
      );
      expect(formatApprovalModeDescription(ApprovalMode.AUTO_EDIT)).toBe(
        'Automatically approve file edits',
      );
      expect(formatApprovalModeDescription(ApprovalMode.YOLO)).toBe(
        'Automatically approve all tools',
      );
    });

    it('formats descriptions with the active locale', async () => {
      await setLanguageAsync('ru');
      try {
        expect(formatApprovalModeDescription(ApprovalMode.PLAN)).toBe(
          'Только анализ, без изменения файлов или выполнения команд',
        );
        expect(formatApprovalModeDescription(ApprovalMode.DEFAULT)).toBe(
          'Требуется подтверждение для редактирования файлов или команд терминала',
        );
        expect(formatApprovalModeDescription(ApprovalMode.AUTO_EDIT)).toBe(
          'Автоматически подтверждать изменения файлов',
        );
        expect(formatApprovalModeDescription(ApprovalMode.AUTO)).toBe(
          'Использовать классификатор для автоматического подтверждения безопасных вызовов инструментов',
        );
        expect(formatApprovalModeDescription(ApprovalMode.YOLO)).toBe(
          'Автоматически подтверждать все инструменты',
        );
      } finally {
        await setLanguageAsync('en');
      }
    });
  });
});
