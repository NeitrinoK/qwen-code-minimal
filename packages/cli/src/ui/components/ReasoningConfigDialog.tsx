/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type React from 'react';
import { Box, Text } from 'ink';
import {
  reasoningCandidates,
  type ReasoningCandidates,
  type ReasoningEffortLevel,
} from '@qwen-code/qwen-code-core/reasoning/candidates.js';
import type {
  ReasoningTrial,
  ProbeResult,
} from '@qwen-code/qwen-code-core/reasoning/probe.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { theme } from '../semantic-colors.js';
import type { ReasoningChoice } from './reasoning-config-merge.js';

const BADGE: Record<ProbeResult, string> = {
  supported: '✓',
  accepted_no_thinking: '⚠',
  rejected: '✗',
  unknown: '?',
};

// Special option value for the "verify against provider" action item.
const VERIFY = '__verify__';

/** Map a model family's candidate knobs to live-probe trials. */
export function buildTrials(c: ReasoningCandidates): ReasoningTrial[] {
  if (c.effortLevels.length > 0) {
    return c.effortLevels.map((lvl) => ({
      key: `effort:${lvl}`,
      body: { enable_thinking: true, reasoning_effort: lvl },
    }));
  }
  return [{ key: 'thinking:on', body: { enable_thinking: true } }];
}

/** Build the curated reasoning options, annotated with probe-result badges. */
export function buildReasoningOptions(
  c: ReasoningCandidates,
  badges: Map<string, ProbeResult> | null,
): Array<{ title: string; value: string }> {
  const badge = (key: string) => {
    const r = badges?.get(key);
    return r ? ` ${BADGE[r]}` : '';
  };
  const opts: Array<{ title: string; value: string }> = [];
  opts.push({ title: 'Thinking: off', value: 'thinking:off' });
  if (c.effortLevels.length > 0) {
    for (const lvl of c.effortLevels) {
      opts.push({
        title: `Thinking: on · effort ${lvl}${badge(`effort:${lvl}`)}`,
        value: `effort:${lvl}`,
      });
    }
  } else {
    opts.push({
      title: `Thinking: on${badge('thinking:on')}`,
      value: 'thinking:on',
    });
  }
  return opts;
}

function valueToChoice(value: string, c: ReasoningCandidates): ReasoningChoice {
  if (value === 'thinking:off') {
    return { enableThinking: false, thinkingKey: c.thinkingKey };
  }
  if (value.startsWith('effort:')) {
    return {
      enableThinking: true,
      effort: value.slice('effort:'.length) as ReasoningEffortLevel,
      thinkingKey: c.thinkingKey,
    };
  }
  return { enableThinking: true, thinkingKey: c.thinkingKey };
}

export interface ReasoningConfigDialogProps {
  modelId: string;
  canVerify: boolean;
  onVerify: () => void;
  badges: Map<string, ProbeResult> | null;
  verifying: boolean;
  onSelect: (choice: ReasoningChoice) => void;
}

export const ReasoningConfigDialog: React.FC<ReasoningConfigDialogProps> = ({
  modelId,
  canVerify,
  onVerify,
  badges,
  verifying,
  onSelect,
}) => {
  const candidates = reasoningCandidates(modelId);
  const items = buildReasoningOptions(candidates, badges).map((o) => ({
    title: <Text>{o.title}</Text>,
    description: '',
    value: o.value,
    key: o.value,
  }));
  if (canVerify) {
    items.push({
      title: (
        <Text>{verifying ? 'Verifying…' : 'Verify against provider'}</Text>
      ),
      description: '',
      value: VERIFY,
      key: VERIFY,
    });
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.text.secondary}>{`Reasoning for ${modelId}`}</Text>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={items}
          onSelect={(value: string) => {
            if (value === VERIFY) {
              onVerify();
              return;
            }
            onSelect(valueToChoice(value, candidates));
          }}
          initialIndex={0}
          showNumbers={true}
        />
      </Box>
    </Box>
  );
};
