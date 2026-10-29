/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Types
export type {
  BaseUrlOption,
  ModelSpec,
  ProviderId,
  ProviderConfig,
  ProviderInstallPlan,
  ProviderInstallState,
  ProviderModelConfig,
  ProviderModelProvidersPatch,
  ProviderSettingsAdapter,
  ProviderSetupInputs,
} from './types.js';

// Provider config utilities
export {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  findExistingProviderModels,
  getModelsForProviderProtocol,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  providerMatchesCredentials,
  PROVIDER_METADATA_NS,
  resolveBaseUrl,
  resolveMetadataKey,
  resolveOwnsModel,
  shouldShowStep,
} from './provider-config.js';

export { discoverProviderModels } from './model-discovery.js';

// Provider registry
export {
  ALL_PROVIDERS,
  CUSTOM_API_KEY_ENV_PREFIX,
  customProvider,
  findDiscoverableProviderByBaseUrl,
  findProviderByCredentials,
  findProviderById,
  generateCustomEnvKey,
  getAllProviderBaseUrls,
  grokProvider,
  requestyProvider,
  setHubProviders,
} from './all-providers.js';

export {
  buildHubProviders,
  HUB_UI_GROUP,
  isHubProvider,
  type HubEndpointSettings,
  type HubLoadPillSettings,
  type HubModelSettings,
  type HubSettings,
} from './presets/openai-hub.js';

// Preset constants
export { REQUESTY_BASE_URL, REQUESTY_ENV_KEY } from './presets/requesty.js';

// Install logic
export {
  applyProviderInstallPlan,
  ProviderInstallError,
  type ApplyProviderInstallPlanOptions,
  type ApplyProviderInstallPlanResult,
} from './install.js';

export { preserveModelProviderPlaceholders } from './model-config-serialization.js';

// Model discovery
export { listProviderModelIds } from './discover-models.js';
export type { DiscoverModelsOptions } from './discover-models.js';
