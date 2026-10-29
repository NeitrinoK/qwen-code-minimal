/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { t } from '../../i18n/index.js';
import { getRawModelProviders } from '../../config/loadedSettingsAdapter.js';
import {
  findProviderByCredentials,
  findProviderById,
  ALL_PROVIDERS,
} from '@qwen-code/qwen-code-core/providers/all-providers.js';
import { HUB_UI_GROUP } from '@qwen-code/qwen-code-core/providers/presets/openai-hub.js';
import { customProvider } from '@qwen-code/qwen-code-core/providers/presets/custom-provider.js';
import {
  findExistingProviderModels,
  getDefaultModelIds,
} from '@qwen-code/qwen-code-core/providers/provider-config.js';
import type { ProviderConfig } from '@qwen-code/qwen-code-core/providers/types.js';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewLevel = 'main' | 'provider-setup';

type MainOption = string; // a hub provider id, or 'CUSTOM_PROVIDER'

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

function buildMainItems() {
  const hubItems = ALL_PROVIDERS.filter((p) => p.uiGroup === HUB_UI_GROUP).map(
    (p) => ({
      key: p.id,
      title: p.label,
      label: p.label,
      description: p.description,
      value: p.id as MainOption,
    }),
  );
  return [
    ...hubItems,
    {
      key: 'CUSTOM_PROVIDER',
      title: t('Custom Provider'),
      label: t('Custom Provider'),
      description: t(
        'Manually connect a local server, proxy, or unsupported provider',
      ),
      value: 'CUSTOM_PROVIDER' as MainOption,
    },
  ];
}

// Maps each main option to the provider its setup flow starts from.
const providerForOption = (v: MainOption): ProviderConfig =>
  v === 'CUSTOM_PROVIDER'
    ? customProvider
    : (findProviderById(v) ?? customProvider);

// ---------------------------------------------------------------------------
// Step label for provider-setup title bar
// ---------------------------------------------------------------------------

function getStepLabel(step: string | null, p: ProviderConfig): string {
  if (step === 'protocol') return t('Protocol');
  if (step === 'wireApi') return t('API');
  if (step === 'baseUrl') {
    if (p.uiLabels?.baseUrlStepTitle) return t(p.uiLabels.baseUrlStepTitle);
    return Array.isArray(p.baseUrl) ? t('Endpoint') : t('Base URL');
  }
  if (step === 'apiKey') return t('API Key');
  if (step === 'models') return t('Model IDs');
  if (step === 'advancedConfig') return t('Advanced Config');
  if (step === 'review') return t('Review');
  return '';
}

// ---------------------------------------------------------------------------
// View titles
// ---------------------------------------------------------------------------

const VIEW_TITLES: Record<string, string> = {
  main: t('Connect a Provider'),
};

// ---------------------------------------------------------------------------
// AuthDialog
// ---------------------------------------------------------------------------

export function AuthDialog(): React.JSX.Element {
  const {
    auth: { authError },
  } = useUIState();
  const {
    auth: { closeAuthDialog, handleProviderSubmit, onAuthError },
  } = useUIActions();
  const config = useConfig();
  const settings = useSettings();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  const [_viewStack, setViewStack] = useState<ViewLevel[]>([]);

  const [mainIndex, setMainIndex] = useState<number | null>(null);

  const setupFlow = useProviderSetupFlow(
    handleProviderSubmit,
    settings.merged.modelProviders,
    settings.merged.providerProtocol,
    {
      authType: settings.merged.security?.auth?.selectedType,
      id: settings.merged.model?.name,
      baseUrl: settings.merged.model?.baseUrl,
    },
    getRawModelProviders(settings),
  );

  // -- Navigation -----------------------------------------------------------

  const clearErrors = () => {
    setErrorMessage(null);
    onAuthError(null);
  };

  const pushView = (view: ViewLevel) => {
    setViewStack((prev) => [...prev, viewLevel]);
    setViewLevel(view);
  };

  const goBack = () => {
    clearErrors();

    if (viewLevel === 'provider-setup') {
      if (setupFlow.goBack()) return;
    }

    setViewStack((prev) => {
      const next = [...prev];
      const parent = next.pop() ?? 'main';
      setViewLevel(parent);
      return next;
    });
  };

  const existingEnv = (settings.merged.env ?? {}) as Record<string, string>;

  // The saved route and ids the wizard reopens with. Both must come from the
  // same lookup: seeding the ids of a Responses install while the API step
  // defaults to Chat Completions would restamp them onto the other wire.
  const findSavedModels = (providerConfig: ProviderConfig) =>
    findExistingProviderModels(
      providerConfig,
      settings.merged.modelProviders,
      settings.merged.providerProtocol,
      {
        authType: settings.merged.security?.auth?.selectedType,
        id: settings.merged.model?.name,
        baseUrl: settings.merged.model?.baseUrl,
      },
    );

  const getExistingModelIds = (providerConfig: ProviderConfig): string[] => {
    const saved = findSavedModels(providerConfig);
    if (!saved) return [];
    const builtinIds = new Set(getDefaultModelIds(providerConfig));
    return saved.models.map((m) => m.id).filter((id) => !builtinIds.has(id));
  };

  // -- Default main index from current auth state ---------------------------

  const contentGenConfig = config.getContentGeneratorConfig();
  const matchedProvider = findProviderByCredentials(
    contentGenConfig?.baseUrl,
    contentGenConfig?.apiKeyEnvKey,
  );

  // Land on the option that matches the active provider so re-opening the
  // dialog highlights the provider already in use.
  const mainItems = useMemo(buildMainItems, []);
  const defaultMainIndex = useMemo(() => {
    const index = mainItems.findIndex(
      (item) => providerForOption(item.value).id === matchedProvider?.id,
    );
    return index >= 0 ? index : 0;
  }, [matchedProvider, mainItems]);

  // -- Handlers -------------------------------------------------------------

  const handleMainSelect = (value: MainOption) => {
    clearErrors();
    const providerConfig = providerForOption(value);
    setupFlow.start(
      providerConfig,
      findSavedModels(providerConfig)?.protocol,
      existingEnv,
      getExistingModelIds(providerConfig),
    );
    pushView('provider-setup');
  };

  // -- Keyboard handling ----------------------------------------------------

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (viewLevel !== 'main') {
          goBack();
          return;
        }
        if (errorMessage) return;
        if (config.getAuthType() === undefined) {
          setErrorMessage(
            t(
              'You must connect a provider to proceed. Press Ctrl+C again to exit.',
            ),
          );
          return;
        }
        closeAuthDialog();
      }
    },
    { isActive: true },
  );

  // -- View title -----------------------------------------------------------

  const viewTitle = useMemo(() => {
    if (viewLevel !== 'provider-setup') {
      return VIEW_TITLES[viewLevel] ?? VIEW_TITLES['main'];
    }
    const p = setupFlow.state.provider;
    if (!p) return t('Provider Setup');
    const flowTitle = p.uiLabels?.flowTitle ?? p.label;
    const { stepIndex, totalSteps, step } = setupFlow.state;
    return t('{{flowTitle}} · Step {{step}}/{{total}} · {{stepLabel}}', {
      flowTitle,
      step: String(stepIndex),
      total: String(totalSteps),
      stepLabel: getStepLabel(step, p),
    });
  }, [viewLevel, setupFlow.state]);

  // -- Render ---------------------------------------------------------------

  return (
    <Box
      borderStyle="single"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{viewTitle}</Text>

      {viewLevel === 'main' && (
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={mainItems}
            initialIndex={mainIndex != null ? mainIndex : defaultMainIndex}
            onSelect={handleMainSelect}
            onHighlight={(value) => {
              setMainIndex(mainItems.findIndex((item) => item.value === value));
            }}
            itemGap={1}
          />
        </Box>
      )}

      {viewLevel === 'provider-setup' && (
        <ProviderSetupSteps flow={setupFlow} />
      )}

      {(authError || errorMessage) && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{authError || errorMessage}</Text>
        </Box>
      )}

      {viewLevel === 'main' && (
        <>
          <Box marginY={1}>
            <Text color={theme.border.default}>{'─'.repeat(80)}</Text>
          </Box>
          <Box>
            <Text color={theme.text.primary}>
              {t('Terms of Services and Privacy Notice')}:
            </Text>
          </Box>
          <Box>
            <Link
              url="https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/"
              fallback={false}
            >
              <Text color={theme.text.secondary} underline>
                https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/
              </Text>
            </Link>
          </Box>
        </>
      )}
    </Box>
  );
}
