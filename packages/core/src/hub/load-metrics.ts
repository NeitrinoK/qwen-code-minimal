/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { fetch } from 'undici';
import { createHttpDispatcher } from '../utils/proxyUtils.js';

export interface HubLoad {
  active?: number;
  queue?: number;
}
export type HubLoadSnapshot = Map<string, HubLoad>;

export const HUB_LOAD_DEFAULTS = {
  activePanelId: 7,
  queuePanelId: 8,
  refreshMs: 15000,
  staleMs: 60000,
  queueWarn: 20,
} as const;

const QUERY_WINDOW_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 3000;

interface GrafanaField {
  type?: string;
  labels?: { model?: string } & Record<string, string>;
}
interface GrafanaFrame {
  schema?: { fields?: GrafanaField[] };
  data?: { values?: unknown[][] };
}

/** Last non-null numeric value per `labels.model` across all frames in a panel response. */
function lastValuePerModel(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const results = (
    json as { results?: Record<string, { frames?: GrafanaFrame[] }> }
  )?.results;
  if (!results || typeof results !== 'object') return out;
  for (const res of Object.values(results)) {
    // Guard against non-array frames
    if (!Array.isArray(res?.frames)) continue;
    for (const frame of res.frames) {
      // Skip null or non-object frames
      if (!frame || typeof frame !== 'object') continue;
      // Guard against non-array schema.fields
      const fields = frame.schema?.fields;
      if (!Array.isArray(fields)) continue;
      // Guard against non-array data.values
      const values = frame.data?.values;
      if (!Array.isArray(values)) continue;
      fields.forEach((field, idx) => {
        const model = field.labels?.model;
        if (!model || field.type === 'time') return;
        const column = values[idx];
        if (!Array.isArray(column)) return;
        for (let i = column.length - 1; i >= 0; i--) {
          const v = column[i];
          if (typeof v === 'number' && Number.isFinite(v)) {
            out.set(model, v);
            break;
          }
        }
      });
    }
  }
  return out;
}

export function parseLoadFrames(
  activeJson: unknown,
  queueJson: unknown,
): HubLoadSnapshot {
  const snap: HubLoadSnapshot = new Map();
  for (const [m, active] of lastValuePerModel(activeJson)) {
    snap.set(m, { ...(snap.get(m) ?? {}), active });
  }
  for (const [m, queue] of lastValuePerModel(queueJson)) {
    snap.set(m, { ...(snap.get(m) ?? {}), queue });
  }
  return snap;
}

export interface FetchHubLoadDeps {
  baseUrl: string;
  token: string;
  activePanelId: number;
  queuePanelId: number;
  proxy?: string;
  noProxy?: string[];
  caCertificates?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function fetchHubLoad(
  deps: FetchHubLoadDeps,
): Promise<HubLoadSnapshot | null> {
  try {
    const now = Date.now();
    const body = JSON.stringify({
      intervalMs: 5000,
      maxDataPoints: 30,
      timeRange: {
        from: String(now - QUERY_WINDOW_MS),
        to: String(now),
        timezone: 'browser',
      },
    });
    // Honour the configured proxy, NO_PROXY and CA certificates.
    const dispatcher = createHttpDispatcher({
      proxyUrl: deps.proxy,
      noProxy: deps.noProxy,
      caCertificates: deps.caCertificates,
    });
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = deps.signal
      ? AbortSignal.any([deps.signal, timeout])
      : timeout;

    const call = async (panelId: number): Promise<unknown> => {
      const res = await fetch(
        `${deps.baseUrl}/api/public/dashboards/${deps.token}/panels/${panelId}/query`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        },
      );
      if (!res.ok) throw new Error(`grafana ${res.status}`);
      return res.json();
    };

    const [activeJson, queueJson] = await Promise.all([
      call(deps.activePanelId),
      call(deps.queuePanelId),
    ]);
    return parseLoadFrames(activeJson, queueJson);
  } catch {
    return null;
  }
}
