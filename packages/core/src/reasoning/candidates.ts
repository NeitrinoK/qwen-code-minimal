/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
export type ReasoningEffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface ReasoningCandidates {
  supportsThinking: boolean;
  thinkingKey: 'enable_thinking' | 'thinking.enabled';
  effortLevels: ReasoningEffortLevel[];
}

const LEVELS: ReasoningEffortLevel[] = ['low', 'medium', 'high'];
// DeepSeek additionally accepts a `max` tier (verified against a vLLM deployment;
// the canonical reasoning adapter also maps `xhigh` → `max`). Offer it as the
// ceiling so the picker can select maximum effort.
const DEEPSEEK_LEVELS: ReasoningEffortLevel[] = [
  'low',
  'medium',
  'high',
  'max',
];

/**
 * Which reasoning knobs to OFFER for a model's family. This is the instant,
 * zero-network candidate list; the live probe (probe.ts) confirms which the
 * actual deployment accepts. `"auto"` is intentionally never offered — hub
 * deployments reject it.
 */
export function reasoningCandidates(modelId: string): ReasoningCandidates {
  const id = (modelId ?? '').toLowerCase();
  if (id.includes('deepseek')) {
    return {
      supportsThinking: true,
      thinkingKey: 'enable_thinking',
      effortLevels: [...DEEPSEEK_LEVELS],
    };
  }
  if (id.includes('qwen')) {
    return {
      supportsThinking: true,
      thinkingKey: 'enable_thinking',
      effortLevels: [],
    };
  }
  if (id.includes('glm')) {
    return {
      supportsThinking: true,
      thinkingKey: 'thinking.enabled',
      effortLevels: [],
    };
  }
  // Unknown/custom: offer the generic OpenAI-style knobs.
  return {
    supportsThinking: true,
    thinkingKey: 'enable_thinking',
    effortLevels: [...LEVELS],
  };
}
