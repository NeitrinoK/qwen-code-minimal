/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import process from 'node:process';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Text } from 'ink';
import {
  AuthType,
  AUTH_TOKEN_ERROR_HELP,
  buildModelIdContext,
  ModelSlashCommandEvent,
  logModelSlashCommand,
  MAINLINE_CODER_MODEL,
  isImageCapable,
  isImageGenerationCapable,
  parseVisionModelSetting,
  probeReasoningSupport,
  reasoningCandidates,
  resolveModelId,
  tokenLimit,
  type AvailableModel as CoreAvailableModel,
  type Config,
  type ContentGeneratorConfig,
  type InputModalities,
  type ModelGenerationConfig,
  type ModelProvidersConfig,
  type ProbeResult,
  type ProviderModelConfig,
  type ResolvedModelConfig,
} from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useHubModelDiscovery } from '../hooks/use-hub-model-discovery.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ReasoningConfigDialog, buildTrials } from './ReasoningConfigDialog.js';
import {
  mergeReasoningExtraBody,
  type ReasoningChoice,
} from './reasoning-config-merge.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { t } from '../../i18n/index.js';
import { publicProviderBaseUrl } from '../../utils/acpModelUtils.js';
import type { HistoryItemWithoutId } from '../types.js';
import {
  allowsFastOnlyAdvisorModel,
  checkAdvisorModelAvailability,
  isAdvisorModelEligible,
} from '../../config/advisor-model.js';

function formatModalities(modalities?: InputModalities): string {
  if (!modalities) return t('text-only');
  const parts: string[] = [];
  if (modalities.image) parts.push(t('image'));
  if (modalities.pdf) parts.push(t('pdf'));
  if (modalities.audio) parts.push(t('audio'));
  if (modalities.video) parts.push(t('video'));
  if (parts.length === 0) return t('text-only');
  return `${t('text')} · ${parts.join(' · ')}`;
}

/**
 * Build a unique selection key for a model entry in the model dialog.
 * When baseUrl is present, it's appended after a \0 separator to ensure
 * entries with the same model id but different baseUrls get distinct keys.
 */
function buildModelSelectionKey(
  authType: string,
  modelId: string,
  baseUrl?: string,
): string {
  const base = `${authType}::${modelId}`;
  return baseUrl ? `${base}\0${baseUrl}` : base;
}

/**
 * Parse a model selection key back into its components.
 */
function parseModelSelectionKey(key: string): {
  authType: string;
  modelId: string;
  baseUrl?: string;
} {
  const sep = '::';
  const idx = key.indexOf(sep);
  if (idx < 0) return { authType: '', modelId: key };

  const authType = key.slice(0, idx);
  const rest = key.slice(idx + sep.length);
  const nullIdx = rest.indexOf('\0');
  if (nullIdx >= 0) {
    return {
      authType,
      modelId: rest.slice(0, nullIdx),
      baseUrl: rest.slice(nullIdx + 1),
    };
  }
  return { authType, modelId: rest };
}

/**
 * Which model-list row the selector should mount on. Prefers the currently
 * highlighted row (so returning from a sub-screen — e.g. the reasoning config —
 * restores focus to the model the user was on) and falls back to the active/
 * preferred model on first open. Returns 0 when neither key is found.
 */
export function computeModelListInitialIndex(
  options: ReadonlyArray<{ value: string }>,
  highlightedValue: string | null,
  preferredKey: string,
): number {
  const key = highlightedValue ?? preferredKey;
  const index = options.findIndex((option) => option.value === key);
  return index === -1 ? 0 : index;
}

/**
 * Encode a dialog selection key into the `authType:modelId[\0baseUrl]` form
 * persisted for the fast/vision auxiliary models. The baseUrl is kept when
 * the row carries one so same-id endpoints under a single authType stay
 * unambiguous — the registry keys entries by id+baseUrl and otherwise falls
 * back to a first-match scan that can bind another provider's key (#12760).
 * Handles the three selection-key shapes:
 * `authType::modelId[\0baseUrl]`, `$runtime|authType|modelId`, and a bare id.
 */
export function encodeAuxModelSelector(selected: string): string {
  if (selected.includes('::')) {
    const parsed = parseModelSelectionKey(selected);
    const selector = `${parsed.authType}:${parsed.modelId}`;
    // The suffix is persisted registry-exact: it is the routing key every
    // consumer compares with `===`. Egress surfaces scrub it on the way out
    // through `aux-model-selector.ts`.
    return parsed.baseUrl ? `${selector}\0${parsed.baseUrl}` : selector;
  }
  if (selected.startsWith('$runtime|')) {
    const parts = selected.split('|');
    return parts[1] && parts[2] ? `${parts[1]}:${parts[2]}` : selected;
  }
  return selected;
}

interface ModelDialogProps {
  onClose: () => void;
  isFastModelMode?: boolean;
  isAdvisorModelMode?: boolean;
  isVisionModelMode?: boolean;
  isCompactionModelMode?: boolean;
  isImageModelMode?: boolean;
  /** Override which settings scope to persist the selection to. */
  persistScope?: 'workspace' | 'user';
  availableTerminalHeight?: number;
}

const MAX_MODEL_ITEMS_TO_SHOW = 10;
// Non-list dialog chrome to reserve when capping visible model rows: outer
// round border (2) + outer padding (2) + title (1) + gap before the list (1)
// + highlighted-entry detail panel (divider + up to 4 detail rows, ~6) +
// footer gap and hint text (2). The list intentionally omits the ▲/▼ scroll
// indicators other list dialogs enable: they are two always-rendered chrome
// rows, and in a height-capped dialog those rows are better spent on two
// more entries — the entry numbering already shows where the visible window
// sits in the list. Adjust this whenever the surrounding layout changes, and
// re-verify with an E2E height sweep rather than guessing.
const MODEL_DIALOG_FIXED_ROWS = 14;
const MODEL_OPTION_ROW_HEIGHT = 1;
const MODEL_OPTION_ROW_HEIGHT_WITH_DESCRIPTION = 2;
const ADVISOR_OFF_OPTION = '$advisor-off';

function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return `(${t('not set')})`;
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return `(${t('not set')})`;
  if (trimmed.length <= 6) return '***';
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

function resolvePersistScope(
  settings: ReturnType<typeof useSettings>,
  persistScope: 'workspace' | 'user' | undefined,
): SettingScope {
  // Workspace settings are ignored when untrusted, so fall back to user scope.
  if (persistScope === 'workspace' && !settings.isTrusted) {
    return SettingScope.User;
  }
  if (persistScope === 'workspace') return SettingScope.Workspace;
  if (persistScope === 'user') return SettingScope.User;
  return getPersistScopeForModelSelection(settings);
}

/**
 * Workspace settings are shareable (`<project>/.qwen/settings.json` gets
 * committed), so only a provably public endpoint may be persisted there;
 * otherwise drop just the `\0baseUrl` disambiguator, matching the policy in
 * serve/routes/workspace-models.ts. `publicProviderBaseUrl` is the fail-closed
 * of the two URL predicates — it also rejects query/hash secrets — and a kept
 * URL stays byte-identical, which `Config.pinnedAuxEndpoint` requires. User
 * scope is never rewritten. Parity: ui/opentui/dialog-data.ts.
 */
function shareableAuxSelector(selector: string, scope: SettingScope): string {
  if (scope !== SettingScope.Workspace) return selector;
  const sep = selector.indexOf('\0');
  if (sep === -1) return selector;
  const endpoint = selector.slice(sep + 1);
  return publicProviderBaseUrl(endpoint) === endpoint
    ? selector
    : selector.slice(0, sep);
}

/** Disclose that the disambiguator stayed out of the shared settings file. */
function endpointNotSavedNote(selector: string, persisted: string): string {
  return selector === persisted
    ? ''
    : t(' (endpoint not saved: project settings are shared)');
}

function persistModelSelection(
  settings: ReturnType<typeof useSettings>,
  modelId: string,
  baseUrl?: string,
  persistScope?: 'workspace' | 'user',
): void {
  const scope = resolvePersistScope(settings, persistScope);
  settings.setValue(scope, 'model.name', modelId);
  // Persist the paired baseUrl so the correct provider is restored on next
  // launch when multiple providers share the same model id. When the selection
  // has no baseUrl, write an empty-string tombstone (not undefined): undefined
  // is dropped from JSON, so it would not override a stale model.baseUrl left
  // in a lower-priority scope, whereas '' is a present value that does.
  settings.setValue(scope, 'model.baseUrl', baseUrl ?? '');
}

/**
 * Persist the definition of a selected model into `settings.modelProviders`
 * when it isn't already there.
 *
 * Hub autodiscovery injects fetched models into the session's in-memory model
 * registry ephemerally (via `reloadModelProvidersConfig`) — it never writes
 * them to `settings.modelProviders`. `persistModelSelection` only saves
 * `model.name`/`model.baseUrl`, so a discovered model's *definition* never
 * lands in the persisted registry. On next launch the resolver can't find it
 * and silently falls back to the preset default. This upserts just the one
 * selected model's definition, additively — every other persisted entry
 * (including same-provider presets) is preserved.
 *
 * Deliberately does NOT use `applyProviderInstallPlan`/`buildInstallPlan`:
 * a hub provider's default merge strategy is replace-owned, which would
 * delete sibling presets owned by the same provider.
 *
 * Best-effort: any failure is swallowed so it never blocks the model switch
 * or throws into the dialog.
 */
/**
 * Build a `ProviderModelConfig` entry from a fully resolved model definition,
 * carrying over only the fields that are actually set. Shared by
 * `persistSelectedModelDefinition` (upsert on switch/tier-assign) and
 * `handleReasoningSelect` (upsert when saving reasoning for a model that
 * isn't in `settings.modelProviders` yet), so both persistence paths build
 * the identical entry shape for a not-yet-persisted model.
 */
/**
 * Guarantee that a persisted entry states its context window explicitly.
 *
 * Without this, an entry written from the dialog carries whatever
 * `generationConfig` the registry happened to hold — and for a model that
 * arrived through provider discovery (which returns bare IDs, see
 * `discover-models.ts`) that means no `contextWindowSize` at all. The value
 * then falls through to `tokenLimit()`'s regex table on every read
 * (`modelRegistry.ts`), so the window is re-guessed rather than recorded, and
 * a wrong guess is invisible in settings.json.
 *
 * That guess is load-bearing: it sets the auto-compaction threshold
 * (`chatCompressionService.ts`) and the output clamp. Pinning it at write time
 * makes the number the dialog displayed the number that is actually used, and
 * leaves it somewhere the user can correct.
 */
function withPinnedContextWindow(
  modelId: string,
  generationConfig: ModelGenerationConfig | undefined,
): ModelGenerationConfig {
  if (generationConfig?.contextWindowSize !== undefined) {
    return generationConfig;
  }
  return {
    ...(generationConfig ?? {}),
    contextWindowSize: tokenLimit(modelId, 'input'),
  };
}

function buildModelConfigFromResolved(
  resolved: ResolvedModelConfig,
): ProviderModelConfig {
  return {
    id: resolved.id,
    ...(resolved.name !== undefined ? { name: resolved.name } : {}),
    ...(resolved.description !== undefined
      ? { description: resolved.description }
      : {}),
    ...(resolved.envKey !== undefined ? { envKey: resolved.envKey } : {}),
    ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
    ...(resolved.capabilities !== undefined
      ? { capabilities: resolved.capabilities }
      : {}),
    generationConfig: withPinnedContextWindow(
      resolved.id,
      resolved.generationConfig,
    ),
    ...(resolved.fastOnly !== undefined ? { fastOnly: resolved.fastOnly } : {}),
    ...(resolved.voiceOnly !== undefined
      ? { voiceOnly: resolved.voiceOnly }
      : {}),
  };
}

function persistSelectedModelDefinition(
  settings: ReturnType<typeof useSettings>,
  config: Config | undefined,
  authType: AuthType,
  modelId: string,
  baseUrl: string | undefined,
  persistScope?: 'workspace' | 'user',
): void {
  try {
    if (!settings || !config) return;

    const merged =
      (settings.merged?.['modelProviders'] as
        | ModelProvidersConfig
        | undefined) ?? {};
    const existingForAuthType = merged[authType] ?? [];

    const alreadyPersisted = existingForAuthType.some((m) => {
      if (m.id !== modelId) return false;
      if (baseUrl === undefined) return true;
      return m.baseUrl === baseUrl;
    });
    if (alreadyPersisted) return;

    const resolved = config
      .getModelsConfig()
      .getResolvedModel(authType, modelId, baseUrl);

    let newModelConfig: ProviderModelConfig;
    if (resolved) {
      newModelConfig = buildModelConfigFromResolved(resolved);
    } else {
      // No registry entry for it (shouldn't normally happen for a selectable
      // model) — fall back to a minimal definition so the selection is never
      // lost. Reuse an envKey already configured for this provider, if any,
      // since sibling models under the same provider typically share one.
      const fallbackEnvKey = existingForAuthType.find((m) => m.envKey)?.envKey;
      newModelConfig = {
        id: modelId,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(fallbackEnvKey !== undefined ? { envKey: fallbackEnvKey } : {}),
        generationConfig: withPinnedContextWindow(modelId, undefined),
      };
    }

    const next: ModelProvidersConfig = {
      ...merged,
      [authType]: [...existingForAuthType, newModelConfig],
    };

    const scope = resolvePersistScope(settings, persistScope);
    settings.setValue(scope, 'modelProviders', next);
  } catch {
    // Best-effort: never let a persistence failure block the model switch.
  }
}

function persistAuthTypeSelection(
  settings: ReturnType<typeof useSettings>,
  authType: AuthType,
  persistScope?: 'workspace' | 'user',
): void {
  const scope = resolvePersistScope(settings, persistScope);
  settings.setValue(scope, 'security.auth.selectedType', authType);
}

function hydrateApiKeyEnvFromSettings(
  settings: ReturnType<typeof useSettings>,
  envKey: string | undefined,
): void {
  if (!envKey || process.env[envKey]) {
    return;
  }
  const settingsEnvValue = (
    settings?.merged?.env as Record<string, unknown> | undefined
  )?.[envKey];
  if (
    typeof settingsEnvValue === 'string' &&
    settingsEnvValue.trim().length > 0
  ) {
    process.env[envKey] = settingsEnvValue;
  }
}

interface HandleModelSwitchSuccessParams {
  config: Config;
  settings: ReturnType<typeof useSettings>;
  uiState: UIState | null;
  after: ContentGeneratorConfig | undefined;
  effectiveAuthType: AuthType | undefined;
  effectiveModelId: string;
  effectiveBaseUrl: string | undefined;
  isRuntime: boolean;
  persistScope?: 'workspace' | 'user';
}

function handleModelSwitchSuccess({
  config,
  settings,
  uiState,
  after,
  effectiveAuthType,
  effectiveModelId,
  effectiveBaseUrl,
  isRuntime,
  persistScope,
}: HandleModelSwitchSuccessParams): void {
  persistModelSelection(
    settings,
    effectiveModelId,
    effectiveBaseUrl,
    persistScope,
  );
  if (effectiveAuthType) {
    persistAuthTypeSelection(settings, effectiveAuthType, persistScope);
  }

  const baseUrl = after?.baseUrl ?? t('(default)');
  const maskedKey = maskApiKey(after?.apiKey);
  const scopeSuffix =
    persistScope === 'workspace'
      ? t(' (this project)')
      : persistScope === 'user'
        ? t(' (global)')
        : '';
  const feedbackItem = {
    type: 'info' as const,
    text:
      `authType: ${effectiveAuthType ?? `(${t('none')})`}` +
      `\n` +
      `Using ${isRuntime ? 'runtime ' : ''}model: ${effectiveModelId}${scopeSuffix}` +
      `\n` +
      `Base URL: ${baseUrl}` +
      `\n` +
      `API key: ${maskedKey}`,
  };
  uiState?.historyManager.addItem(feedbackItem, Date.now());
  config.getChatRecordingService?.()?.recordSlashCommand({
    phase: 'result',
    rawCommand: '/model',
    outputHistoryItems: [feedbackItem],
  });
}

function formatContextWindow(size?: number): string {
  if (!size) return `(${t('unknown')})`;
  return `${size.toLocaleString('en-US')} tokens`;
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box>
      <Box minWidth={16} flexShrink={0}>
        <Text color={theme.text.secondary}>{label}:</Text>
      </Box>
      <Box flexGrow={1} flexDirection="row" flexWrap="wrap">
        <Text>{value}</Text>
      </Box>
    </Box>
  );
}

export function ModelDialog({
  onClose,
  isFastModelMode,
  isAdvisorModelMode,
  isVisionModelMode,
  isCompactionModelMode,
  isImageModelMode,
  persistScope,
  availableTerminalHeight,
}: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const uiState = useContext(UIStateContext);
  const settings = useSettings();

  // Local error state for displaying errors within the dialog
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  // When set, the main list is replaced by the reasoning-configuration
  // sub-screen for the chosen model.
  const [reasoningFor, setReasoningFor] = useState<
    { authType: AuthType; modelId: string; baseUrl?: string } | undefined
  >(undefined);
  const [reasoningBadges, setReasoningBadges] = useState<Map<
    string,
    ProbeResult
  > | null>(null);
  const [reasoningVerifying, setReasoningVerifying] = useState(false);
  // In-flight probe request, if any — aborted when the reasoning sub-screen
  // is dismissed/model changes/an effort is selected, or the dialog unmounts,
  // so a stale probe can never resolve into a reopened screen's state.
  const reasoningAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      reasoningAbortControllerRef.current?.abort();
    },
    [],
  );

  const authType = config?.getAuthType();

  // Source of truth for the currently configured providers, read the same
  // way useProviderUpdates.ts does — there is no getter for this on
  // ModelsConfig, only the merged settings value.
  const currentModelProviders = ((
    settings?.merged as Record<string, unknown> | undefined
  )?.['modelProviders'] ?? {}) as ModelProvidersConfig;
  const {
    state: discoveryState,
    refreshToken,
    hubLabel,
  } = useHubModelDiscovery(config, currentModelProviders);

  const availableModelEntries = useMemo(() => {
    const allModels = config ? config.getAllConfiguredModels() : [];
    const advisorModel = config?.getAdvisorModel?.();
    const advisorContext = config ? buildModelIdContext(config) : {};
    let advisorSelector: ReturnType<typeof resolveModelId> | undefined;
    if (isAdvisorModelMode && advisorModel) {
      try {
        advisorSelector = resolveModelId(
          advisorModel.split('\0')[0],
          advisorContext,
        );
      } catch {
        advisorSelector = undefined;
      }
    }
    const allowAdvisorFastOnly = allowsFastOnlyAdvisorModel(
      advisorModel,
      advisorSelector,
      advisorContext,
    );

    // Separate runtime models from registry models
    const runtimeModels = isImageModelMode
      ? []
      : allModels.filter(
          (m) =>
            m.isRuntimeModel &&
            (!isAdvisorModelMode ||
              isAdvisorModelEligible(m, allowAdvisorFastOnly)),
        );
    const registryModels = allModels.filter((m) => {
      const imageModelSelector = encodeAuxModelSelector(
        buildModelSelectionKey(m.authType, m.id, m.baseUrl),
      );
      const advisorModelSelector = `${m.authType}:${m.id}\0${m.registryBaseUrl ?? ''}`;
      const isAvailableAdvisorModel =
        !isAdvisorModelMode ||
        (config !== undefined &&
          checkAdvisorModelAvailability(config, advisorModelSelector)
            .available);
      const isSelectableImageModel = isImageModelMode
        ? isImageGenerationCapable(m) &&
          config?.resolveImageGenerationModel(imageModelSelector) !== undefined
        : m.imageOnly !== true;
      return (
        !m.isRuntimeModel &&
        isSelectableImageModel &&
        (isFastModelMode ||
          (isAdvisorModelMode && isAvailableAdvisorModel) ||
          !m.fastOnly) &&
        !m.voiceOnly &&
        (isVisionModelMode || isImageModelMode || !m.visionOnly) &&
        (!isAdvisorModelMode ||
          (isAvailableAdvisorModel &&
            isAdvisorModelEligible(m, allowAdvisorFastOnly)))
      );
    });

    // Group registry models by authType
    const modelsByAuthTypeMap = new Map<AuthType, CoreAvailableModel[]>();
    for (const model of registryModels) {
      const authType = model.authType;
      if (!modelsByAuthTypeMap.has(authType)) {
        modelsByAuthTypeMap.set(authType, []);
      }
      modelsByAuthTypeMap.get(authType)!.push(model);
    }

    // Fixed, stable order
    const authTypeOrder: AuthType[] = [
      AuthType.USE_OPENAI,
      AuthType.USE_OPENAI_RESPONSES,
    ];

    // Filter to only include authTypes that have registry models and maintain order
    const availableAuthTypes = new Set(modelsByAuthTypeMap.keys());
    const orderedAuthTypes = authTypeOrder.filter((t) =>
      availableAuthTypes.has(t),
    );

    // Build ordered list: runtime models first, then registry models grouped by authType
    const result: Array<{
      authType: AuthType;
      model: CoreAvailableModel;
      isRuntime?: boolean;
      snapshotId?: string;
    }> = [];

    // Add all runtime models first
    for (const runtimeModel of runtimeModels) {
      result.push({
        authType: runtimeModel.authType,
        model: runtimeModel,
        isRuntime: true,
        snapshotId: runtimeModel.runtimeSnapshotId,
      });
    }

    // Add registry models grouped by authType
    for (const t of orderedAuthTypes) {
      for (const model of modelsByAuthTypeMap.get(t) ?? []) {
        result.push({ authType: t, model, isRuntime: false });
      }
    }

    return result;
    // refreshToken isn't read in the body, but it bumps after AI Hub model
    // discovery hot-reloads config's model registry in place — this
    // dependency forces a recompute so the list picks up the reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config,
    isFastModelMode,
    isAdvisorModelMode,
    isImageModelMode,
    isVisionModelMode,
    refreshToken,
  ]);

  const MODEL_OPTIONS = useMemo(() => {
    const options = availableModelEntries.map(
      ({ authType: t2, model, isRuntime, snapshotId }) => {
        const value =
          isRuntime && snapshotId
            ? snapshotId
            : buildModelSelectionKey(
                t2,
                model.id,
                isAdvisorModelMode ? model.registryBaseUrl : model.baseUrl,
              );

        const title = (
          <Text>
            <Text
              bold
              color={isRuntime ? theme.status.warning : theme.text.accent}
            >
              [{t2}]
            </Text>
            <Text>{` ${model.label}`}</Text>
            {model.id !== model.label && (
              <Text color={theme.text.secondary} italic>
                {' '}
                ({model.id})
              </Text>
            )}
            {isRuntime && <Text color={theme.status.warning}> (Runtime)</Text>}
          </Text>
        );

        // Include runtime indicator in description
        let description = model.description || '';
        if (isRuntime) {
          description = description
            ? `${description} (Runtime)`
            : 'Runtime model';
        }

        return {
          value,
          title,
          description,
          key: value,
        };
      },
    );
    return isAdvisorModelMode
      ? [
          {
            value: ADVISOR_OFF_OPTION,
            title: <Text bold>{t('Off')}</Text>,
            description: t('Disable Advisor'),
            key: ADVISOR_OFF_OPTION,
          },
          ...options,
        ]
      : options;
  }, [availableModelEntries, isAdvisorModelMode]);
  const modelOptionRowHeight = MODEL_OPTIONS.some(
    ({ description }) =>
      typeof description !== 'string' || description.trim().length > 0,
  )
    ? MODEL_OPTION_ROW_HEIGHT_WITH_DESCRIPTION
    : MODEL_OPTION_ROW_HEIGHT;
  // The error box adds its own marginTop plus one row per line (errorPrefix +
  // blank line from the "\n\n" join + the underlying error's own lines), plus
  // a buffer since the error Text wraps and long lines can span extra rows on
  // narrow terminals.
  const errorMessageRows = errorMessage
    ? 2 + errorMessage.split('\n').length
    : 0;
  const maxModelItemsToShow =
    availableTerminalHeight === undefined
      ? MAX_MODEL_ITEMS_TO_SHOW
      : Math.max(
          1,
          Math.min(
            MAX_MODEL_ITEMS_TO_SHOW,
            Math.floor(
              (availableTerminalHeight -
                MODEL_DIALOG_FIXED_ROWS -
                errorMessageRows) /
                modelOptionRowHeight,
            ),
          ),
        );

  // In fast model mode, default to the currently configured fast model
  const fastModelSetting = settings?.merged?.fastModel as string | undefined;
  const advisorModelSetting =
    typeof config?.getAdvisorModel === 'function'
      ? config.getAdvisorModel()
      : undefined;
  const visionModelSetting = settings?.merged?.visionModel as
    | string
    | undefined;
  const imageModelSetting = settings?.merged?.imageModel as string | undefined;
  const parsedVisionModelValue = parseVisionModelSetting(visionModelSetting);
  const parsedImageModelValue = parseVisionModelSetting(imageModelSetting);
  const parsedFastModelSetting = useMemo(() => {
    if (!isFastModelMode) return undefined;
    try {
      return resolveModelId(fastModelSetting);
    } catch {
      return undefined;
    }
  }, [fastModelSetting, isFastModelMode]);
  const parsedAdvisorModelSetting = useMemo(() => {
    if (!isAdvisorModelMode || !config || !advisorModelSetting)
      return undefined;
    try {
      return resolveModelId(
        advisorModelSetting.split('\0')[0],
        buildModelIdContext(config),
      );
    } catch {
      return undefined;
    }
  }, [advisorModelSetting, config, isAdvisorModelMode]);
  const parsedVisionModelSetting = useMemo(() => {
    if (!isVisionModelMode) return undefined;
    try {
      return resolveModelId(parsedVisionModelValue?.selector);
    } catch {
      return undefined;
    }
  }, [parsedVisionModelValue?.selector, isVisionModelMode]);
  const parsedImageModelSetting = useMemo(() => {
    if (!isImageModelMode) return undefined;
    try {
      return resolveModelId(parsedImageModelValue?.selector);
    } catch {
      return undefined;
    }
  }, [parsedImageModelValue?.selector, isImageModelMode]);
  const preferredModelId =
    isFastModelMode && parsedFastModelSetting
      ? parsedFastModelSetting.modelId
      : isAdvisorModelMode && parsedAdvisorModelSetting
        ? parsedAdvisorModelSetting.modelId
        : isVisionModelMode && parsedVisionModelSetting
          ? parsedVisionModelSetting.modelId
          : isImageModelMode && parsedImageModelSetting
            ? parsedImageModelSetting.modelId
            : config?.getModel() || MAINLINE_CODER_MODEL;
  const isAuxiliaryModelMode =
    isFastModelMode ||
    isAdvisorModelMode ||
    isVisionModelMode ||
    isCompactionModelMode ||
    isImageModelMode;
  // Check if current model is a runtime model
  // Runtime snapshot ID is already in $runtime|${authType}|${modelId} format
  const activeRuntimeSnapshot = isAuxiliaryModelMode
    ? undefined
    : config?.getActiveRuntimeModelSnapshot?.();
  const currentBaseUrl = config
    ?.getModelsConfig()
    .getGenerationConfig()?.baseUrl;
  // When `/model --fast <bare-id>` validated the model across all providers,
  // the setting persists as a bare model ID (no authType prefix) so that
  // runtime cross-auth lookups still work. Highlight the row that owns it
  // regardless of which provider that turns out to be — otherwise the
  // dialog would default to the current auth's first row and Enter would
  // silently overwrite the user's fast-model setting.
  // The picker can persist `authType:id\0<baseUrl>` (#12760); honour that
  // endpoint when re-highlighting, otherwise reopening the dialog and pressing
  // Enter re-pins the first same-id provider. Read it off the raw setting —
  // `resolveModelId` strips the suffix by design. When no row carries the
  // pinned endpoint (a project declaring its own `modelProviders` replaces the
  // user's), keep the same-id highlight documented above rather than falling
  // through to the current auth's first row, which Enter would overwrite.
  const findPreferredAuxEntry = (
    setting: { authType?: AuthType; modelId: string } | undefined,
    persisted: string | undefined,
  ) => {
    if (!setting) return undefined;
    const ownsId = ({
      authType: entryAuthType,
      model,
    }: (typeof availableModelEntries)[number]) =>
      (!setting.authType || entryAuthType === setting.authType) &&
      model.id === setting.modelId;
    // Trim before slicing: Config.pinnedAuxEndpoint and the sibling parse
    // paths trim first, so a whitespace-padded setting must highlight the
    // same row the runtime routes to.
    const endpoint = persisted?.trim().split('\0')[1];
    return (
      (endpoint
        ? availableModelEntries.find(
            (entry) => ownsId(entry) && entry.model.baseUrl === endpoint,
          )
        : undefined) ?? availableModelEntries.find(ownsId)
    );
  };
  const preferredFastModelEntry = isFastModelMode
    ? findPreferredAuxEntry(parsedFastModelSetting, fastModelSetting)
    : undefined;
  const advisorEndpointIndex = advisorModelSetting?.indexOf('\0') ?? -1;
  const advisorRegistryBaseUrl =
    advisorEndpointIndex < 0
      ? undefined
      : advisorModelSetting!.slice(advisorEndpointIndex + 1) || null;
  const preferredAdvisorModelEntry =
    isAdvisorModelMode && parsedAdvisorModelSetting
      ? availableModelEntries.find(
          ({ authType: t2, model, isRuntime }) =>
            (!parsedAdvisorModelSetting.authType ||
              t2 === parsedAdvisorModelSetting.authType) &&
            model.id === parsedAdvisorModelSetting.modelId &&
            (advisorRegistryBaseUrl === undefined ||
              (!isRuntime &&
                (model.registryBaseUrl ?? null) === advisorRegistryBaseUrl)),
        )
      : undefined;
  // Like fast mode, the vision/image settings may persist as a bare id
  // (cross-provider) or an `authType:modelId\0baseUrl` selector — highlight
  // whichever row owns it, keeping the same-id fallback when the pinned
  // endpoint matches no configured row (otherwise Enter silently re-pins an
  // unrelated row).
  const preferredVisionModelEntry = isVisionModelMode
    ? findPreferredAuxEntry(parsedVisionModelSetting, visionModelSetting)
    : undefined;
  const preferredImageModelEntry = isImageModelMode
    ? findPreferredAuxEntry(parsedImageModelSetting, imageModelSetting)
    : undefined;
  const parsedCompactionSetting = useMemo(() => {
    if (!isCompactionModelMode) return undefined;
    const raw = settings?.merged?.compactionModel?.trim();
    if (!raw) return undefined;
    try {
      return resolveModelId(raw);
    } catch {
      return undefined;
    }
  }, [settings?.merged?.compactionModel, isCompactionModelMode]);
  const preferredCompactionModelEntry = isCompactionModelMode
    ? findPreferredAuxEntry(
        parsedCompactionSetting,
        settings?.merged?.compactionModel as string | undefined,
      )
    : undefined;
  const preferredKey = activeRuntimeSnapshot
    ? activeRuntimeSnapshot.id
    : isAdvisorModelMode && !advisorModelSetting
      ? ADVISOR_OFF_OPTION
      : preferredVisionModelEntry
        ? buildModelSelectionKey(
            preferredVisionModelEntry.authType,
            preferredVisionModelEntry.model.id,
            preferredVisionModelEntry.model.baseUrl,
          )
        : preferredCompactionModelEntry
          ? buildModelSelectionKey(
              preferredCompactionModelEntry.authType,
              preferredCompactionModelEntry.model.id,
              preferredCompactionModelEntry.model.baseUrl,
            )
          : preferredImageModelEntry
            ? buildModelSelectionKey(
                preferredImageModelEntry.authType,
                preferredImageModelEntry.model.id,
                preferredImageModelEntry.model.baseUrl,
              )
            : preferredAdvisorModelEntry
              ? buildModelSelectionKey(
                  preferredAdvisorModelEntry.authType,
                  preferredAdvisorModelEntry.model.id,
                  preferredAdvisorModelEntry.model.registryBaseUrl,
                )
              : preferredFastModelEntry
                ? buildModelSelectionKey(
                    preferredFastModelEntry.authType,
                    preferredFastModelEntry.model.id,
                    preferredFastModelEntry.model.baseUrl,
                  )
                : authType
                  ? buildModelSelectionKey(
                      authType,
                      preferredModelId,
                      currentBaseUrl,
                    )
                  : '';

  // Escape can arrive twice in one stdin chunk before the parent unmounts
  // the dialog; latch so the close feedback and onClose fire only once.
  const closeLatchRef = useRef(false);
  const selectionInFlightRef = useRef(false);
  const selectionCommittedRef = useRef(false);
  const reportAuxiliaryModelSelection = useCallback(
    (feedbackItem: HistoryItemWithoutId & Record<string, unknown>) => {
      uiState?.historyManager.addItem(feedbackItem, Date.now());
      config?.getChatRecordingService?.()?.recordSlashCommand({
        phase: 'result',
        rawCommand: isAdvisorModelMode ? '/advisor' : '/model',
        outputHistoryItems: [feedbackItem],
      });
    },
    [config, isAdvisorModelMode, uiState],
  );
  const closeWithoutSelection = useCallback(() => {
    if (closeLatchRef.current || selectionInFlightRef.current) return;
    closeLatchRef.current = true;
    if (!isAuxiliaryModelMode && !selectionCommittedRef.current) {
      const feedbackItem = {
        type: 'info' as const,
        text: t('Kept model as {{model}}', {
          model: activeRuntimeSnapshot?.modelId ?? preferredModelId,
        }),
      };
      uiState?.historyManager.addItem(feedbackItem, Date.now());
      config?.getChatRecordingService?.()?.recordSlashCommand({
        phase: 'result',
        rawCommand: '/model',
        outputHistoryItems: [feedbackItem],
      });
    }
    onClose();
  }, [
    activeRuntimeSnapshot,
    config,
    isAuxiliaryModelMode,
    onClose,
    preferredModelId,
    uiState,
  ]);

  const highlightedEntry = useMemo(() => {
    const key = highlightedValue ?? preferredKey;
    return availableModelEntries.find(
      ({ authType: t2, model, isRuntime, snapshotId }) => {
        const v =
          isRuntime && snapshotId
            ? snapshotId
            : buildModelSelectionKey(
                t2,
                model.id,
                isAdvisorModelMode ? model.registryBaseUrl : model.baseUrl,
              );
        return v === key;
      },
    );
  }, [
    highlightedValue,
    preferredKey,
    availableModelEntries,
    isAdvisorModelMode,
  ]);

  useKeypress(
    (key) => {
      // In the reasoning sub-screen, Escape/Left steps back to the model list
      // rather than closing the whole dialog.
      if (reasoningFor) {
        if (key.name === 'escape' || key.name === 'left') {
          reasoningAbortControllerRef.current?.abort();
          reasoningAbortControllerRef.current = null;
          setReasoningFor(undefined);
          setReasoningBadges(null);
          setReasoningVerifying(false);
        }
        return;
      }
      if (key.name === 'r' && highlightedEntry) {
        setReasoningFor({
          authType: highlightedEntry.authType as AuthType,
          modelId: highlightedEntry.model.id,
          baseUrl: highlightedEntry.model.baseUrl,
        });
        setReasoningBadges(null);
        setReasoningVerifying(false);
        return;
      }
      if (
        key.name === 'escape' ||
        (key.name === 'left' && isAuxiliaryModelMode)
      ) {
        closeWithoutSelection();
      }
    },
    { isActive: true },
  );

  const initialIndex = useMemo(() => {
    // Returning from the reasoning sub-screen restores the highlighted row;
    // otherwise mount on the active/preferred model.
    const found = MODEL_OPTIONS.some(
      (option) => option.value === (highlightedValue ?? preferredKey),
    );
    if (
      !found &&
      isAdvisorModelMode &&
      advisorModelSetting &&
      MODEL_OPTIONS.length > 1
    ) {
      return 1;
    }
    return computeModelListInitialIndex(
      MODEL_OPTIONS,
      highlightedValue,
      preferredKey,
    );
  }, [
    MODEL_OPTIONS,
    highlightedValue,
    preferredKey,
    isAdvisorModelMode,
    advisorModelSetting,
  ]);

  const handleHighlight = useCallback((value: string) => {
    setHighlightedValue(value);
  }, []);

  // Switches the session to the model identified by `selected` (a selection
  // key or a `$runtime|…` snapshot id), persisting the choice.
  const performModelSwitch = useCallback(
    async (selected: string): Promise<boolean> => {
      const selectedEntry = availableModelEntries.find(
        ({ authType: t2, model, isRuntime: r, snapshotId }) => {
          const value =
            r && snapshotId
              ? snapshotId
              : buildModelSelectionKey(t2, model.id, model.baseUrl);
          return value === selected;
        },
      );

      let after: ContentGeneratorConfig | undefined;
      let effectiveAuthType: AuthType | undefined;
      let effectiveModelId = selected;
      let isRuntime = false;

      if (!config) {
        onClose();
        return false;
      }

      try {
        // Determine if this is a runtime model selection
        // Runtime model format: $runtime|${authType}|${modelId}
        isRuntime = selected.startsWith('$runtime|');

        let selectedAuthType: AuthType;
        let modelId: string;

        let selectedBaseUrl: string | undefined;
        if (isRuntime) {
          // For runtime models, extract authType from the snapshot ID
          // Format: $runtime|${authType}|${modelId}
          const parts = selected.split('|');
          if (parts.length >= 2 && parts[0] === '$runtime') {
            selectedAuthType = parts[1] as AuthType;
          } else {
            selectedAuthType = authType as AuthType;
          }
          modelId = selected; // Pass the full snapshot ID to switchModel
        } else {
          const parsed = parseModelSelectionKey(selected);
          selectedAuthType = (parsed.authType || authType) as AuthType;
          modelId = parsed.modelId;
          selectedBaseUrl = parsed.baseUrl;
        }

        selectionInFlightRef.current = true;
        try {
          await config.switchModel(selectedAuthType, modelId, {
            baseUrl: selectedBaseUrl,
          });
          selectionCommittedRef.current = true;
        } finally {
          selectionInFlightRef.current = false;
        }

        if (!isRuntime) {
          const event = new ModelSlashCommandEvent(modelId);
          logModelSlashCommand(config, event);
        }

        after = config.getContentGeneratorConfig?.() as
          | ContentGeneratorConfig
          | undefined;
        effectiveAuthType = after?.authType ?? selectedAuthType ?? authType;
        effectiveModelId = after?.model ?? modelId;

        // Discovered (non-registry-persisted) models are only injected into
        // the session's model registry ephemerally — persist this one
        // selected model's definition so it survives to the next launch.
        // Runtime model selections are keyed by snapshot id, not a
        // persistable model definition, so they're skipped.
        if (!isRuntime) {
          persistSelectedModelDefinition(
            settings,
            config,
            selectedAuthType,
            effectiveModelId,
            after?.baseUrl ?? selectedBaseUrl,
            persistScope,
          );
        }
      } catch (e) {
        const baseErrorMessage = e instanceof Error ? e.message : String(e);
        // Use parsed modelId for display to avoid showing raw selection key
        // (which contains invisible \0 separator between modelId and baseUrl)
        const displayModelId = isRuntime
          ? effectiveModelId
          : parseModelSelectionKey(selected).modelId;
        const errorPrefix = isRuntime
          ? 'Failed to switch to runtime model.'
          : `Failed to switch model to '${displayModelId}'.`;
        setErrorMessage(`${errorPrefix}\n\n${baseErrorMessage}`);
        return false;
      }

      try {
        handleModelSwitchSuccess({
          config,
          settings,
          uiState,
          after,
          effectiveAuthType,
          effectiveModelId,
          // Persist the selected provider's baseUrl so the right provider is
          // restored next launch when several share the same id. Pair it with the
          // same resolved config that effectiveModelId comes from (`after`) so the
          // persisted (model.name, model.baseUrl) stays consistent even if
          // switchModel transforms the id; fall back to the picker entry's
          // baseUrl. Runtime models are keyed by snapshot id, so no disambiguator.
          effectiveBaseUrl: isRuntime
            ? undefined
            : (after?.baseUrl ?? selectedEntry?.model.baseUrl),
          isRuntime,
          persistScope,
        });
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        setErrorMessage(
          `${t('Model switched, but the selection could not be saved.')}\n\n${errorMessage}`,
        );
        return false;
      }
      closeLatchRef.current = true;
      onClose();
      return true;
    },
    [
      authType,
      config,
      onClose,
      settings,
      uiState,
      setErrorMessage,
      availableModelEntries,
      persistScope,
    ],
  );

  // Whether the reasoning sub-screen can offer "Verify against provider" for
  // the model it was opened for: needs a resolvable baseUrl and an API key
  // present in the environment (mirrors handleReasoningVerify's own check).
  const canVerifyReasoning = useMemo(() => {
    if (!reasoningFor || !config) return false;
    const resolved = config
      .getModelsConfig()
      .getResolvedModel(
        reasoningFor.authType,
        reasoningFor.modelId,
        reasoningFor.baseUrl,
      );
    return Boolean(
      resolved?.baseUrl && resolved.envKey && process.env[resolved.envKey],
    );
  }, [reasoningFor, config]);

  // Live-probes the provider for which reasoning trials it actually accepts,
  // storing per-trial badges. Fires only from the explicit Verify action —
  // never on open/highlight/render.
  const handleReasoningVerify = useCallback(async () => {
    if (!reasoningFor || !config) return;
    // Captured so a stale result — the user switched models (or closed the
    // sub-screen and reopened it for another one) while the probe was still
    // in flight — is detected and discarded below instead of being applied
    // to the wrong model's badges.
    const targetModelId = reasoningFor.modelId;
    const resolved = config
      .getModelsConfig()
      .getResolvedModel(
        reasoningFor.authType,
        reasoningFor.modelId,
        reasoningFor.baseUrl,
      );
    const baseUrl = resolved?.baseUrl;
    const apiKey = resolved?.envKey ? process.env[resolved.envKey] : undefined;
    if (!baseUrl || !apiKey) return; // canVerifyReasoning guards the UI too
    reasoningAbortControllerRef.current?.abort();
    const controller = new AbortController();
    reasoningAbortControllerRef.current = controller;
    setReasoningVerifying(true);
    const badges = await probeReasoningSupport({
      baseUrl,
      apiKey,
      model: reasoningFor.modelId,
      trials: buildTrials(reasoningCandidates(reasoningFor.modelId)),
      proxy: config.getProxy(),
      noProxy: config.getNoProxy(),
      caCertificates: config.getCaCertificates(),
      signal: controller.signal,
    });
    if (reasoningAbortControllerRef.current === controller) {
      reasoningAbortControllerRef.current = null;
    }
    if (reasoningFor?.modelId !== targetModelId) return;
    setReasoningVerifying(false);
    setReasoningBadges(badges);
  }, [reasoningFor, config]);

  // Persists the chosen reasoning knobs into the matched provider model's
  // generationConfig.extra_body, then closes the sub-screen back to the list.
  //
  // Hub-discovered and runtime models are injected into the in-memory model
  // registry (via reloadModelProvidersConfig) but are never written to
  // settings.modelProviders until a switch/tier-assign upserts them (see
  // persistSelectedModelDefinition above) — so an entry may not exist yet.
  // When that happens, upsert a minimal definition here too (mirroring
  // persistSelectedModelDefinition's resolved branch) so the reasoning
  // choice is actually saved instead of silently discarded.
  const handleReasoningSelect = useCallback(
    (choice: ReasoningChoice) => {
      if (!reasoningFor) return;
      const scope = resolvePersistScope(settings, persistScope);
      const merged =
        (settings.merged?.['modelProviders'] as
          | ModelProvidersConfig
          | undefined) ?? {};
      const providers: ModelProvidersConfig = { ...merged };
      const list = [...(providers[reasoningFor.authType] ?? [])];
      // Mirrors persistSelectedModelDefinition's disambiguation: duplicate
      // ids across providers are told apart by baseUrl (buildModelSelectionKey
      // appends it), so match on both. When reasoningFor has no baseUrl
      // there's nothing to disambiguate, so id alone is enough.
      const idx = list.findIndex((m) => {
        if (m.id !== reasoningFor.modelId) return false;
        if (reasoningFor.baseUrl === undefined) return true;
        return m.baseUrl === reasoningFor.baseUrl;
      });

      let wrote = false;
      if (idx >= 0) {
        const model = { ...list[idx] };
        model.generationConfig = {
          ...(model.generationConfig ?? {}),
          extra_body: mergeReasoningExtraBody(
            model.generationConfig?.extra_body,
            choice,
          ),
        };
        list[idx] = model;
        wrote = true;
      } else {
        const resolved = config
          ?.getModelsConfig()
          .getResolvedModel(
            reasoningFor.authType,
            reasoningFor.modelId,
            reasoningFor.baseUrl,
          );
        if (resolved) {
          const newModelConfig = buildModelConfigFromResolved(resolved);
          newModelConfig.generationConfig = {
            ...(newModelConfig.generationConfig ?? {}),
            extra_body: mergeReasoningExtraBody(
              resolved.generationConfig?.extra_body,
              choice,
            ),
          };
          list.push(newModelConfig);
          wrote = true;
        }
      }

      // A pending probe is now moot regardless of outcome below — the user
      // has committed a choice, so any in-flight verify would only produce
      // stale badges for a screen that's about to close.
      reasoningAbortControllerRef.current?.abort();
      reasoningAbortControllerRef.current = null;
      setReasoningVerifying(false);

      if (wrote) {
        providers[reasoningFor.authType] = list;
        settings.setValue(scope, 'modelProviders', providers);
        // settings.setValue only persists to disk/merged settings — it does
        // not touch the session's in-memory model registry that the live
        // ContentGenerator is built from, so without this the new extra_body
        // would silently not apply until the next CLI restart even though
        // the toast below claims success.
        config?.reloadModelProvidersConfig(providers);

        uiState?.historyManager.addItem(
          {
            type: 'success',
            text: `Reasoning updated for ${reasoningFor.modelId}`,
          },
          Date.now(),
        );

        // Reloading the registry is enough for the *next* model switch to
        // pick up the new extra_body, but the model already active this
        // turn was built from the old registry snapshot — if that's the one
        // just edited, re-run the same switch path used to activate a model
        // so it takes effect immediately instead of only after a restart.
        const activeAuthType = config?.getAuthType();
        const activeModelId = config?.getModel();
        const activeBaseUrl = config
          ?.getModelsConfig()
          .getGenerationConfig()?.baseUrl;
        const isActiveModel =
          activeAuthType === reasoningFor.authType &&
          activeModelId === reasoningFor.modelId &&
          (activeBaseUrl || undefined) === (reasoningFor.baseUrl || undefined);

        if (isActiveModel) {
          const selectionKey = buildModelSelectionKey(
            reasoningFor.authType,
            reasoningFor.modelId,
            reasoningFor.baseUrl,
          );
          setReasoningFor(undefined);
          setReasoningBadges(null);
          void performModelSwitch(selectionKey);
          return;
        }
      } else {
        uiState?.historyManager.addItem(
          {
            type: 'error',
            text: `Could not resolve ${reasoningFor.modelId} to save its reasoning configuration.`,
          },
          Date.now(),
        );
      }
      setReasoningFor(undefined);
      setReasoningBadges(null);
    },
    [reasoningFor, settings, persistScope, uiState, config, performModelSwitch],
  );

  const handleSelect = useCallback(
    async (selected: string) => {
      if (selectionInFlightRef.current || selectionCommittedRef.current) return;
      setErrorMessage(null);
      const selectedEntry = availableModelEntries.find(
        ({ authType: t2, model, isRuntime, snapshotId }) => {
          const value =
            isRuntime && snapshotId
              ? snapshotId
              : buildModelSelectionKey(
                  t2,
                  model.id,
                  isAdvisorModelMode ? model.registryBaseUrl : model.baseUrl,
                );
          return value === selected;
        },
      );

      if (isAdvisorModelMode) {
        if (!config) {
          setErrorMessage(t('Configuration not available.'));
          return;
        }
        if (selected === ADVISOR_OFF_OPTION) {
          settings.setValue(SettingScope.User, 'advisorModel', '');
          selectionInFlightRef.current = true;
          try {
            await config.setAdvisorModel(undefined);
          } finally {
            selectionInFlightRef.current = false;
          }
          reportAuxiliaryModelSelection({
            type: 'success',
            text: t('Advisor disabled'),
          });
          onClose();
          return;
        }
        if (!selectedEntry) {
          setErrorMessage(t('Selected Advisor model is unavailable.'));
          return;
        }

        hydrateApiKeyEnvFromSettings(settings, selectedEntry.model.envKey);
        // encodeAuxModelSelector already keeps the row's baseUrl as the
        // endpoint disambiguator; strip it here because advisorModel appends
        // the registry baseUrl itself below.
        const advisorSelector = encodeAuxModelSelector(selected).split(
          '\0',
          1,
        )[0];
        const advisorModel = selectedEntry.isRuntime
          ? advisorSelector
          : `${advisorSelector}\0${selectedEntry.model.registryBaseUrl ?? ''}`;
        if (!checkAdvisorModelAvailability(config, advisorModel).available) {
          setErrorMessage(t('Selected Advisor model is unavailable.'));
          return;
        }
        selectionInFlightRef.current = true;
        let applied: boolean | undefined;
        try {
          applied = await config.setAdvisorModel(advisorModel);
        } finally {
          selectionInFlightRef.current = false;
        }
        if (applied === false) {
          setErrorMessage(t('Advisor configuration is unavailable.'));
          return;
        }
        settings.setValue(SettingScope.User, 'advisorModel', advisorModel);
        reportAuxiliaryModelSelection({
          type: 'success',
          text: t('Advisor set to {{model}}', { model: advisorSelector }),
        });
        onClose();
        return;
      }

      hydrateApiKeyEnvFromSettings(settings, selectedEntry?.model.envKey);

      // Fast model mode: save authType:modelId (plus the baseUrl endpoint
      // disambiguator when the row carries one) so duplicate model ids
      // across providers bind the selected provider's credentials.
      if (isFastModelMode) {
        const fastModel = encodeAuxModelSelector(selected);
        const scope = resolvePersistScope(settings, persistScope);
        // The shareable workspace file only ever receives a provably public
        // endpoint; this session's in-memory pin keeps the picked row.
        const persistedFastModel = shareableAuxSelector(fastModel, scope);
        settings.setValue(scope, 'fastModel', persistedFastModel);
        // Sync the runtime Config so forked agents pick up the change immediately.
        config?.setFastModel(fastModel);
        const scopeSuffix =
          persistScope === 'workspace'
            ? t(' (this project)')
            : persistScope === 'user'
              ? t(' (global)')
              : '';
        reportAuxiliaryModelSelection({
          type: 'success',
          text: `${t('Fast Model')}: ${persistedFastModel.split('\0')[0]}${scopeSuffix}${endpointNotSavedNote(fastModel, persistedFastModel)}`,
        });
        onClose();
        return;
      }

      // Vision model mode: keep the selected row's baseUrl when present so
      // same-provider OpenAI-compatible endpoints with the same id stay distinct.
      if (isVisionModelMode) {
        const visionModel = encodeAuxModelSelector(selected);
        const visionModelDisplay =
          parseVisionModelSetting(visionModel)?.selector ?? visionModel;
        // Pinning the primary itself is ignored by the bridge at runtime, so
        // reject it here instead of persisting a dead pin and reporting success.
        if (
          selectedEntry &&
          config?.isCurrentPrimaryModel(selectedEntry.model)
        ) {
          setErrorMessage(
            t(
              "'{{model}}' is the current primary model and cannot be used as the vision bridge.",
              { model: visionModelDisplay },
            ),
          );
          return;
        }
        const scope = resolvePersistScope(settings, persistScope);
        settings.setValue(scope, 'visionModel', visionModel);
        // Sync runtime Config so the vision bridge picks it up without a restart.
        config?.setVisionModel(visionModel);
        // Honor the pin even if the model isn't image-capable, but warn — the
        // bridge will send images to it.
        const visionWarning =
          selectedEntry && !isImageCapable(selectedEntry.model)
            ? `\n${t("⚠ '{{model}}' is not a known image-capable model; the vision bridge may fail on images.", { model: visionModelDisplay })}`
            : '';
        const scopeSuffix =
          persistScope === 'workspace'
            ? t(' (this project)')
            : persistScope === 'user'
              ? t(' (global)')
              : '';
        reportAuxiliaryModelSelection({
          type: 'success',
          text: `${t('Vision Model')}: ${visionModelDisplay}${scopeSuffix}${visionWarning}`,
        });
        onClose();
        return;
      }

      // Compaction model mode: persist the selected model for chat compression.
      if (isCompactionModelMode) {
        if (!selectedEntry || !config) {
          setErrorMessage(t('Selected compaction model is unavailable.'));
          return;
        }
        const compactionModelId = encodeAuxModelSelector(selected);
        const scope = resolvePersistScope(settings, persistScope);
        const persistedCompactionModel = shareableAuxSelector(
          compactionModelId,
          scope,
        );
        settings.setValue(scope, 'compactionModel', persistedCompactionModel);
        // Sync runtime Config so the compression service picks it up immediately.
        config.setCompactionModel(compactionModelId);
        const scopeSuffix =
          persistScope === 'workspace'
            ? t(' (this project)')
            : persistScope === 'user'
              ? t(' (global)')
              : '';
        reportAuxiliaryModelSelection({
          type: 'success',
          text: `${t('Compaction Model')}: ${persistedCompactionModel.split('\0')[0]}${scopeSuffix}${endpointNotSavedNote(compactionModelId, persistedCompactionModel)}`,
        });
        onClose();
        return;
      }

      if (isImageModelMode) {
        if (!selectedEntry || !config) {
          setErrorMessage(t('Selected image model is unavailable.'));
          return;
        }
        const imageModel = encodeAuxModelSelector(selected);
        const imageModelDisplay =
          parseVisionModelSetting(imageModel)?.selector ?? imageModel;
        if (!config.resolveImageGenerationModel(imageModel)) {
          setErrorMessage(
            t(
              "'{{model}}' must declare a valid HTTPS baseUrl and credential environment variable.",
              { model: imageModelDisplay },
            ),
          );
          return;
        }
        const scope = resolvePersistScope(settings, persistScope);
        settings.setValue(scope, 'imageModel', imageModel);
        selectionInFlightRef.current = true;
        try {
          await config.setImageModel(imageModel);
        } finally {
          selectionInFlightRef.current = false;
        }
        const scopeSuffix =
          persistScope === 'workspace'
            ? t(' (this project)')
            : persistScope === 'user'
              ? t(' (global)')
              : '';
        reportAuxiliaryModelSelection({
          type: 'success',
          text: `${t('Image Model')}: ${imageModelDisplay}${scopeSuffix}`,
        });
        onClose();
        return;
      }

      // Main model: switch to the selected model directly.
      await performModelSwitch(selected);
    },
    [
      config,
      onClose,
      settings,
      setErrorMessage,
      isFastModelMode,
      isAdvisorModelMode,
      isVisionModelMode,
      isCompactionModelMode,
      isImageModelMode,
      availableModelEntries,
      persistScope,
      reportAuxiliaryModelSelection,
      performModelSwitch,
    ],
  );

  const hasModels = MODEL_OPTIONS.length > 0;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>
        {(reasoningFor
          ? t('Configure Reasoning')
          : isVisionModelMode
            ? t('Select Vision Model')
            : isCompactionModelMode
              ? t('Select Compaction Model')
              : isImageModelMode
                ? t('Select Image Model')
                : isAdvisorModelMode
                  ? t('Select Advisor Model')
                  : isFastModelMode
                    ? t('Select Fast Model')
                    : t('Select Model')) +
          (persistScope === 'workspace'
            ? t(' (this project)')
            : persistScope === 'user'
              ? t(' (global)')
              : '')}
      </Text>

      {reasoningFor ? (
        <ReasoningConfigDialog
          modelId={reasoningFor.modelId}
          canVerify={canVerifyReasoning}
          onVerify={handleReasoningVerify}
          badges={reasoningBadges}
          verifying={reasoningVerifying}
          onSelect={handleReasoningSelect}
        />
      ) : discoveryState === 'loading' ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Loading models from {{hub}}…', { hub: hubLabel })}
          </Text>
        </Box>
      ) : discoveryState === 'auth_error' ? (
        // Token/401 rejection: don't offer a stale model list behind an
        // unreachable-looking note — show the token error + how to renew.
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.status.error}>{AUTH_TOKEN_ERROR_HELP}</Text>
        </Box>
      ) : (
        <>
          {discoveryState === 'error' && (
            <Box marginTop={1}>
              <Text color={theme.text.secondary}>
                {t("⚠ Couldn't reach {{hub}} — showing last known models", {
                  hub: hubLabel,
                })}
              </Text>
            </Box>
          )}
          {!hasModels ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.status.warning}>
                {t(
                  'No models available for the current authentication type ({{authType}}).',
                  {
                    authType: authType ? String(authType) : t('(none)'),
                  },
                )}
              </Text>
              <Box marginTop={1}>
                <Text color={theme.text.secondary}>
                  {t(
                    'Please configure models in settings.modelProviders or use environment variables.',
                  )}
                </Text>
              </Box>
            </Box>
          ) : (
            <Box marginTop={1}>
              <DescriptiveRadioButtonSelect
                items={MODEL_OPTIONS}
                onSelect={handleSelect}
                onHighlight={handleHighlight}
                initialIndex={initialIndex}
                showNumbers={true}
                maxItemsToShow={maxModelItemsToShow}
              />
            </Box>
          )}
        </>
      )}

      {!reasoningFor && highlightedEntry && (
        <Box marginTop={1} flexDirection="column">
          <Box
            borderStyle="single"
            borderTop
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
            borderColor={theme.border.default}
          />
          <DetailRow
            label={t('Modality')}
            value={formatModalities(highlightedEntry.model.modalities)}
          />
          <DetailRow
            label={t('Context Window')}
            value={formatContextWindow(
              highlightedEntry.model.contextWindowSize,
            )}
          />
          <DetailRow
            label="Base URL"
            value={highlightedEntry.model.baseUrl ?? t('(default)')}
          />
          <DetailRow
            label="API Key"
            value={highlightedEntry.model.envKey ?? t('(not set)')}
          />
        </Box>
      )}

      {errorMessage && (
        <Box marginTop={1} flexDirection="column" paddingX={1}>
          <Text color={theme.status.error} wrap="wrap">
            ✕ {errorMessage}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {reasoningFor
            ? t('Enter to select · Esc to go back')
            : t('Enter to select, ↑↓ to navigate, Esc to close')}
        </Text>
        {!reasoningFor && hasModels && (
          <Text color={theme.text.secondary}>
            {t('press r to configure reasoning')}
          </Text>
        )}
      </Box>
    </Box>
  );
}
