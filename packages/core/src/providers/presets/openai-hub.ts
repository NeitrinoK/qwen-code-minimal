/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export interface HubEndpointSettings {
  name: string;
  baseUrl: string;
}
export interface HubModelSettings {
  id: string;
  contextWindowSize?: number;
  enableThinking?: boolean;
}
export interface HubLoadPillSettings {
  dashboardBaseUrl: string;
  dashboardToken: string;
  activePanelId?: number;
  queuePanelId?: number;
  refreshMs?: number;
  staleMs?: number;
  queueWarn?: number;
}
/** The `hub` settings block: a self-hosted OpenAI-compatible model hub. */
export interface HubSettings {
  label?: string;
  endpoints?: HubEndpointSettings[];
  envKey?: string;
  docsUrl?: string;
  modelNamePrefix?: string;
  models?: HubModelSettings[];
  discoverModels?: boolean;
  loadPill?: HubLoadPillSettings;
}

export const HUB_UI_GROUP = 'hub';
export const HUB_DEFAULT_ENV_KEY = 'HUB_API_KEY';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;

/**
 * One provider per configured endpoint; [] when the block is absent or
 * incomplete. The input is raw user JSON, so every field is type-checked.
 */
export function buildHubProviders(
  hub: HubSettings | undefined,
): ProviderConfig[] {
  const label = typeof hub?.label === 'string' ? hub.label.trim() : '';
  if (!label || !Array.isArray(hub?.endpoints)) return [];
  const endpoints = (hub.endpoints as unknown[]).flatMap((e) => {
    if (!e || typeof e !== 'object') return [];
    const { name, baseUrl } = e as { name?: unknown; baseUrl?: unknown };
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) return [];
    return [{ name: str(name), baseUrl: baseUrl.trim() }];
  });
  if (endpoints.length === 0) return [];
  const envKey = str(hub.envKey) ?? HUB_DEFAULT_ENV_KEY;
  const docsUrl = str(hub.docsUrl);
  const prefix = str(hub.modelNamePrefix) ?? label;
  const models = Array.isArray(hub.models) ? hub.models : undefined;
  const seen = new Set<string>();
  return endpoints.map((e, i) => {
    let id = i === 0 ? 'openai-hub' : `openai-hub-${e.name || i}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const name = i === 0 ? '' : ` (${e.name || i})`;
    const baseUrl = e.baseUrl.replace(/\/+$/, '');
    return {
      id,
      label: `${label}${name}`,
      description: `${label}${name} (${baseUrl}) — OpenAI-compatible`,
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      envKey,
      models,
      modelsEditable: true,
      discoverModels: hub.discoverModels ?? true,
      modelNamePrefix: `${prefix}${name}`,
      documentationUrl: docsUrl,
      uiGroup: HUB_UI_GROUP,
    };
  });
}

export function isHubProvider(p: ProviderConfig | undefined): boolean {
  return p?.uiGroup === HUB_UI_GROUP;
}
