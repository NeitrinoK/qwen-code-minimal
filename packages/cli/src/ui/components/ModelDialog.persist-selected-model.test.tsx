/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

// Covers the fix for: selecting a model discovered via hub autodiscovery
// (injected into the session's model registry ephemerally, never written to
// settings.modelProviders) did not stick as the default on next launch,
// because only model.name/model.baseUrl were persisted — never the model's
// *definition*. These tests exercise the additive-upsert persistence of the
// selected model's definition into settings.modelProviders via ModelDialog's
// selection flow (handleSelect -> persistSelectedModelDefinition).

import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelDialog } from './ModelDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import type { Config, ModelProvidersConfig } from '@qwen-code/qwen-code-core';
import { AuthType, tokenLimit } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

vi.mock('./shared/DescriptiveRadioButtonSelect.js', () => ({
  DescriptiveRadioButtonSelect: vi.fn(function () {
    return null;
  }),
}));

const mockedSelect = vi.mocked(DescriptiveRadioButtonSelect);

void vi.mocked(useKeypress);

const PRESET_MODEL = {
  id: 'Qwen/Qwen3.6-27B',
  baseUrl: 'https://hub.example.com/openai/v1',
};

const DISCOVERED_MODEL_ID = 'deepseek-ai/DeepSeek-V4-Flash';
const DISCOVERED_BASE_URL = 'https://hub.example.com/openai/v1';

interface RenderOpts {
  modelProviders?: ModelProvidersConfig;
  getResolvedModelImpl?: (
    authType: AuthType,
    modelId: string,
    baseUrl?: string,
  ) => unknown;
  setValueImpl?: (...args: unknown[]) => void;
}

const renderComponent = (opts: RenderOpts = {}) => {
  const setValue = opts.setValueImpl ? vi.fn(opts.setValueImpl) : vi.fn();

  const mockSettings = {
    isTrusted: true,
    user: { settings: {} },
    workspace: { settings: {} },
    merged: {
      modelProviders: opts.modelProviders ?? {
        [AuthType.USE_OPENAI]: [PRESET_MODEL],
      },
    },
    setValue,
  } as unknown as LoadedSettings;

  const getResolvedModel = vi.fn(
    opts.getResolvedModelImpl ??
      ((_authType: AuthType, modelId: string, baseUrl?: string) =>
        modelId === DISCOVERED_MODEL_ID
          ? {
              id: DISCOVERED_MODEL_ID,
              name: 'DeepSeek V4 Flash',
              authType: AuthType.USE_OPENAI,
              baseUrl: baseUrl ?? DISCOVERED_BASE_URL,
              envKey: 'HUB_API_KEY',
              capabilities: {},
              generationConfig: {},
            }
          : undefined),
  );

  const mockConfig = {
    getModel: vi.fn(() => DISCOVERED_MODEL_ID),
    switchModel: vi.fn().mockResolvedValue(undefined),
    getAuthType: vi.fn(() => AuthType.USE_OPENAI),
    getAllConfiguredModels: vi.fn(() => [
      {
        id: PRESET_MODEL.id,
        label: PRESET_MODEL.id,
        description: '',
        authType: AuthType.USE_OPENAI,
        baseUrl: PRESET_MODEL.baseUrl,
      },
      {
        id: DISCOVERED_MODEL_ID,
        label: DISCOVERED_MODEL_ID,
        description: '',
        authType: AuthType.USE_OPENAI,
        baseUrl: DISCOVERED_BASE_URL,
      },
    ]),
    getModelsConfig: vi.fn(() => ({
      getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
      getResolvedModel,
    })),
    getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
    getSessionId: vi.fn(() => 'mock-session-id'),
    getDebugMode: vi.fn(() => false),
    getContentGeneratorConfig: vi.fn(() => ({
      authType: AuthType.USE_OPENAI,
      model: DISCOVERED_MODEL_ID,
      baseUrl: DISCOVERED_BASE_URL,
    })),
    getUseModelRouter: vi.fn(() => false),
    getProxy: vi.fn(() => undefined),
  } as unknown as Config;

  const mockHistoryManager = {
    addItem: vi.fn(),
  } as unknown as UIState['historyManager'];

  render(
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

  return { mockSettings, mockConfig, setValue, getResolvedModel };
};

describe('ModelDialog persists a selected discovered model definition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('additively upserts a newly selected, not-yet-persisted model into modelProviders, preserving the existing preset', async () => {
    const { setValue } = renderComponent();

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    expect(childOnSelect).toBeDefined();

    await childOnSelect(
      `${AuthType.USE_OPENAI}::${DISCOVERED_MODEL_ID}\0${DISCOVERED_BASE_URL}`,
    );

    const modelProvidersCall = setValue.mock.calls.find(
      (call) => call[1] === 'modelProviders',
    );
    expect(modelProvidersCall).toBeDefined();
    const [scope, , persisted] = modelProvidersCall as [
      SettingScope,
      string,
      ModelProvidersConfig,
    ];
    expect(scope).toBe(SettingScope.User);
    expect(persisted[AuthType.USE_OPENAI]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: PRESET_MODEL.id }),
        expect.objectContaining({
          id: DISCOVERED_MODEL_ID,
          baseUrl: DISCOVERED_BASE_URL,
          envKey: 'HUB_API_KEY',
        }),
      ]),
    );
    expect(persisted[AuthType.USE_OPENAI]).toHaveLength(2);
  });

  it('does not persist modelProviders again when the selected model is already present', async () => {
    const { setValue } = renderComponent({
      modelProviders: {
        [AuthType.USE_OPENAI]: [
          PRESET_MODEL,
          { id: DISCOVERED_MODEL_ID, baseUrl: DISCOVERED_BASE_URL },
        ],
      },
    });

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(
      `${AuthType.USE_OPENAI}::${DISCOVERED_MODEL_ID}\0${DISCOVERED_BASE_URL}`,
    );

    const modelProvidersCall = setValue.mock.calls.find(
      (call) => call[1] === 'modelProviders',
    );
    expect(modelProvidersCall).toBeUndefined();
  });

  it('pins an explicit contextWindowSize even on the minimal fallback definition', async () => {
    const { setValue } = renderComponent({
      getResolvedModelImpl: () => undefined,
    });

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(
      `${AuthType.USE_OPENAI}::${DISCOVERED_MODEL_ID}\0${DISCOVERED_BASE_URL}`,
    );

    const modelProvidersCall = setValue.mock.calls.find(
      (call) => call[1] === 'modelProviders',
    );
    expect(modelProvidersCall).toBeDefined();
    const persisted = modelProvidersCall![2] as ModelProvidersConfig;
    // The window must be RECORDED, not left to be re-guessed from the model id
    // on every read: a discovered model carries no generationConfig, and an
    // unpinned entry silently inherits whatever tokenLimit()'s regex table
    // returns — which then drives auto-compaction and the output clamp.
    expect(persisted[AuthType.USE_OPENAI]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: PRESET_MODEL.id }),
        {
          id: DISCOVERED_MODEL_ID,
          baseUrl: DISCOVERED_BASE_URL,
          generationConfig: {
            contextWindowSize: tokenLimit(DISCOVERED_MODEL_ID, 'input'),
          },
        },
      ]),
    );
  });

  it('swallows a persistence error without blocking the model switch or the dialog close', async () => {
    const onClose = vi.fn();
    const setValue = vi.fn((_scope: unknown, key: string) => {
      if (key === 'modelProviders') {
        throw new Error('disk full');
      }
    });

    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      merged: { modelProviders: { [AuthType.USE_OPENAI]: [PRESET_MODEL] } },
      setValue,
    } as unknown as LoadedSettings;

    const mockConfig = {
      getModel: vi.fn(() => DISCOVERED_MODEL_ID),
      switchModel: vi.fn().mockResolvedValue(undefined),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: DISCOVERED_MODEL_ID,
          label: DISCOVERED_MODEL_ID,
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: DISCOVERED_BASE_URL,
        },
      ]),
      getModelsConfig: vi.fn(() => ({
        getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
        getResolvedModel: vi.fn(() => ({
          id: DISCOVERED_MODEL_ID,
          name: 'DeepSeek V4 Flash',
          authType: AuthType.USE_OPENAI,
          baseUrl: DISCOVERED_BASE_URL,
          envKey: 'HUB_API_KEY',
          capabilities: {},
          generationConfig: {},
        })),
      })),
      getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
      getSessionId: vi.fn(() => 'mock-session-id'),
      getDebugMode: vi.fn(() => false),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: DISCOVERED_MODEL_ID,
        baseUrl: DISCOVERED_BASE_URL,
      })),
      getUseModelRouter: vi.fn(() => false),
      getProxy: vi.fn(() => undefined),
    } as unknown as Config;

    const mockHistoryManager = {
      addItem: vi.fn(),
    } as unknown as UIState['historyManager'];

    render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider value={mockConfig}>
          <UIStateContext.Provider
            value={{ historyManager: mockHistoryManager } as unknown as UIState}
          >
            <ModelDialog onClose={onClose} />
          </UIStateContext.Provider>
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    // Selecting a model switches to it directly.
    await expect(
      childOnSelect(`${AuthType.USE_OPENAI}::${DISCOVERED_MODEL_ID}`),
    ).resolves.toBeUndefined();

    // The model switch itself (model.name persistence) still went through.
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      DISCOVERED_MODEL_ID,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
