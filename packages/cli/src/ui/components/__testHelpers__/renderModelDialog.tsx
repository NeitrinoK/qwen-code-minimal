/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { DEFAULT_QWEN_MODEL } from '@qwen-code/qwen-code-core/utils/default-qwen-model.js';
import { ModelDialog } from '../ModelDialog.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { SettingsContext } from '../../contexts/SettingsContext.js';
import { UIStateContext, type UIState } from '../../contexts/UIStateContext.js';
import type { LoadedSettings } from '../../../config/settings.js';

/**
 * Minimal provider scaffolding for rendering <ModelDialog /> in tests, mirroring
 * the `renderComponent` helper in ModelDialog.test.tsx. Kept intentionally small
 * (single default model, USE_OPENAI auth) — tests that need finer control over
 * the mocked Config/settings should extend ModelDialog.test.tsx directly rather
 * than growing this helper's surface.
 */
export function renderModelDialogForTest(
  configOverrides: Partial<Config> = {},
): ReturnType<typeof render> {
  const mockSettings = {
    isTrusted: true,
    user: { settings: {} },
    workspace: { settings: {} },
    setValue: vi.fn(),
  } as unknown as LoadedSettings;

  const mockConfig = {
    getModel: vi.fn(() => DEFAULT_QWEN_MODEL),
    switchModel: vi.fn().mockResolvedValue(undefined),
    getAuthType: vi.fn(() => AuthType.USE_OPENAI),
    getAllConfiguredModels: vi.fn(() => [
      {
        id: DEFAULT_QWEN_MODEL,
        label: 'Coder Model',
        description: 'Coder model',
        authType: AuthType.USE_OPENAI,
      },
    ]),
    getModelsConfig: vi.fn(() => ({
      getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
    })),
    getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
    getSessionId: vi.fn(() => 'mock-session-id'),
    getDebugMode: vi.fn(() => false),
    getContentGeneratorConfig: vi.fn(() => ({
      authType: AuthType.USE_OPENAI,
      model: DEFAULT_QWEN_MODEL,
    })),
    getUseModelRouter: vi.fn(() => false),
    getProxy: vi.fn(() => undefined),
    ...configOverrides,
  } as unknown as Config;

  const mockHistoryManager = {
    addItem: vi.fn(),
  } as unknown as UIState['historyManager'];

  return render(
    <SettingsContext.Provider value={mockSettings}>
      <ConfigContext.Provider value={mockConfig}>
        <UIStateContext.Provider
          value={{ historyManager: mockHistoryManager } as unknown as UIState}
        >
          <ModelDialog onClose={() => {}} />
        </UIStateContext.Provider>
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );
}
