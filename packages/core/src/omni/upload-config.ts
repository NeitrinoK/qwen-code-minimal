/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The DashScope provider class is not part of this build, so the upload
// channel carries its own endpoint check. Hostname comparison (not a regex on
// the raw URL) rejects path-only look-alikes such as
// https://evil.example/dashscope.aliyuncs.com/.
const DASHSCOPE_REGIONAL_HOSTS: readonly string[] = [
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
];

function isDashScopeBaseUrl(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    DASHSCOPE_REGIONAL_HOSTS.some(
      (host) => hostname === host || hostname.endsWith('.' + host),
    ) ||
    (hostname.startsWith('token-plan.') &&
      hostname.endsWith('.maas.aliyuncs.com'))
  );
}

export interface OmniUploadConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface RawOmniUploadConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
}

export class OmniUploadConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmniUploadConfigError';
  }
}

/**
 * Resolve an explicitly separated upload channel. All-or-nothing validation
 * prevents a typo from silently falling back to inference credentials.
 */
export function normalizeDedicatedOmniUploadConfig(
  raw: RawOmniUploadConfig,
  env: NodeJS.ProcessEnv = process.env,
): OmniUploadConfig | undefined {
  const configured =
    raw.baseUrl !== undefined ||
    raw.apiKeyEnv !== undefined ||
    raw.model !== undefined;
  if (!configured) return undefined;

  const baseUrl = raw.baseUrl?.trim();
  const apiKeyEnv = raw.apiKeyEnv?.trim();
  const model = raw.model?.trim();
  if (!baseUrl || !apiKeyEnv || !model) {
    throw new OmniUploadConfigError(
      'omni.delivery.upload.baseUrl, apiKeyEnv, and model must all be set when a dedicated upload channel is configured.',
    );
  }
  if (!ENV_VAR_NAME_PATTERN.test(apiKeyEnv)) {
    throw new OmniUploadConfigError(
      'omni.delivery.upload.apiKeyEnv must be a valid environment variable name.',
    );
  }
  if (!isDashScopeBaseUrl(baseUrl)) {
    throw new OmniUploadConfigError(
      'omni.delivery.upload.baseUrl must be a DashScope-compatible endpoint.',
    );
  }
  const apiKey = env[apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new OmniUploadConfigError(
      `omni.delivery.upload.apiKeyEnv names ${apiKeyEnv}, but that environment variable is not set or is empty.`,
    );
  }
  return { baseUrl, apiKey, model };
}

function resolveLegacyOmniUploadConfig(
  contentGeneratorConfig: ContentGeneratorConfig | undefined,
  model: string | undefined,
): OmniUploadConfig | undefined {
  if (
    !contentGeneratorConfig ||
    !contentGeneratorConfig.apiKey ||
    !contentGeneratorConfig.baseUrl ||
    !model ||
    !isDashScopeBaseUrl(contentGeneratorConfig.baseUrl)
  ) {
    return undefined;
  }
  return {
    baseUrl: contentGeneratorConfig.baseUrl,
    apiKey: contentGeneratorConfig.apiKey,
    model,
  };
}

/** Dedicated upload settings take precedence; otherwise preserve the original
 * DashScope-inference-as-upload behavior. */
export function getEffectiveOmniUploadConfig(
  config: Config,
): OmniUploadConfig | undefined {
  const dedicated = config.getOmniUploadConfig?.();
  if (dedicated) return dedicated;
  return resolveLegacyOmniUploadConfig(
    config.getContentGeneratorConfig?.(),
    config.getModel?.(),
  );
}

export function requireEffectiveOmniUploadConfig(
  config: Config,
): OmniUploadConfig {
  const upload = getEffectiveOmniUploadConfig(config);
  if (!upload) {
    throw new OmniUploadConfigError(
      'Omni upload is not configured. Set all of omni.delivery.upload.baseUrl, apiKeyEnv, and model, or use a static DashScope inference configuration.',
    );
  }
  return upload;
}
