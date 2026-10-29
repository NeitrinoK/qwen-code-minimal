/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { PromptOverheadDisplay } from './PromptOverheadDisplay.js';

const WIDE = 120;
const NARROW = 80;

describe('<PromptOverheadDisplay />', () => {
  it('reports invoked skills against the catalog that every request pays for', () => {
    const { lastFrame } = render(
      <PromptOverheadDisplay
        invokedSkillCount={3}
        catalogSkillCount={85}
        basePromptTokenCount={42000}
        terminalWidth={WIDE}
      />,
    );

    expect(lastFrame()).toContain('3/85 skills');
  });

  it('reports the fixed prompt overhead in rounded thousands', () => {
    const { lastFrame } = render(
      <PromptOverheadDisplay
        invokedSkillCount={3}
        catalogSkillCount={85}
        basePromptTokenCount={42000}
        terminalWidth={WIDE}
      />,
    );

    expect(lastFrame()).toContain('42k base');
  });

  it('abbreviates on a narrow terminal so the pill chain still fits', () => {
    const { lastFrame } = render(
      <PromptOverheadDisplay
        invokedSkillCount={3}
        catalogSkillCount={85}
        basePromptTokenCount={42000}
        terminalWidth={NARROW}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain('3/85 sk');
    expect(frame).toContain('42k');
    expect(frame).not.toContain('skills');
    expect(frame).not.toContain('base');
  });

  it('omits the overhead until the first response has reported it', () => {
    // The base is the provider-reported prompt count of the first request.
    // Before that it is genuinely unknown, and showing 0 would be a lie.
    const { lastFrame } = render(
      <PromptOverheadDisplay
        invokedSkillCount={0}
        catalogSkillCount={85}
        basePromptTokenCount={0}
        terminalWidth={WIDE}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain('0/85 skills');
    expect(frame).not.toContain('base');
  });

  it('renders nothing when no skills are installed', () => {
    const { lastFrame } = render(
      <PromptOverheadDisplay
        invokedSkillCount={0}
        catalogSkillCount={0}
        basePromptTokenCount={0}
        terminalWidth={WIDE}
      />,
    );

    expect(lastFrame()).toBe('');
  });
});
