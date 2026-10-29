/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import OpenAI from 'openai';
import {
  buildRuntimeFetchOptions,
  preloadRuntimeFetchModule,
} from '../utils/runtimeFetchOptions.js';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 4000;

export interface DiscoverModelsOptions {
  baseUrl: string;
  apiKey: string;
  proxy?: string;
  noProxy?: string[];
  caCertificates?: string[];
  /** Abort the request after this many ms. Default 4000. */
  timeoutMs?: number;
}

/**
 * Fetch the model IDs a provider advertises via its OpenAI-compatible
 * `GET {baseUrl}/models` endpoint. Uses the same proxy/CA-aware dispatcher as
 * the model client (so NO_PROXY and configured CA certificates apply). Throws on
 * timeout, non-2xx, or network/parse error — the caller decides fallback.
 */
export async function listProviderModelIds(
  opts: DiscoverModelsOptions,
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  // buildRuntimeFetchOptions is synchronous and needs undici already loaded;
  // /model can open before anything else has loaded it.
  await preloadRuntimeFetchModule();
  const runtimeOptions = buildRuntimeFetchOptions(
    'openai',
    opts.proxy,
    opts.noProxy ?? [],
    opts.caCertificates ?? [],
  );
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
    maxRetries: 0,
    ...(runtimeOptions || {}),
  } as ConstructorParameters<typeof OpenAI>[0]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const page = await client.models.list({ signal: controller.signal });
    return (page.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id);
  } finally {
    clearTimeout(timer);
  }
}
