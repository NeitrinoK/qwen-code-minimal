/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Tests for the restored OpenTUI header banner: it renders the title, model and
 * directory, and suppresses itself in screen-reader mode or when `ui.hideBanner`
 * is set — the same conditions the ink AppHeader honours.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

const mocks = vi.hoisted(() => {
  const state = { dimensions: { width: 110, height: 40 } };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        // jsdom drops unknown props, so the colour-bearing opentui attributes
        // are surfaced as data-* for assertions to pin.
        const dom: Record<string, unknown> = key === undefined ? {} : { key };
        const source = (config ?? {}) as Record<string, unknown>;
        for (const name of ['fg', 'bg', 'borderColor', 'attributes']) {
          if (source[name] !== undefined) dom[`data-${name}`] = source[name];
        }
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          dom,
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', () => ({
  useTerminalDimensions: () => mocks.state.dimensions,
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { OpenTuiBanner } from './opentui-header.js';
import { shortAsciiLogo } from '../components/AsciiArt.js';
import { getActiveOpenTuiTheme, getOpenTuiTheme } from './theme-parity.js';
import { C, applyOpenTuiTheme, applyThemeMode } from './theme.js';

/** Per-wordmark-row foregrounds, in column order. */
function logoRows(container: HTMLElement): Array<Array<string | null>> {
  const panel = container.querySelector('[data-bordercolor]');
  const logo = panel?.parentElement?.children[0];
  return (
    [...(logo?.children ?? [])]
      .map((row) =>
        [...row.children].map((cell) => cell.getAttribute('data-fg')),
      )
      // The bundled logo string ends with a newline, which leaves one empty row.
      .filter((row) => row.length > 0)
  );
}

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    getScreenReader: () => false,
    getCliVersion: () => '9.9.9-test',
    getContentGeneratorConfig: () => ({ contextWindowSize: 1_000_000 }),
    getModelDisplayName: () => 'qwen3-coder-plus',
    getTargetDir: () => '/home/user/projects/qwen-code',
    ...overrides,
  } as unknown as Config;
}

function fakeSettings(ui: Record<string, unknown> = {}): LoadedSettings {
  return {
    merged: { ui },
    isTrusted: true,
    system: { settings: {} },
    workspace: { settings: {} },
    user: { settings: {} },
    systemDefaults: { settings: {} },
  } as unknown as LoadedSettings;
}

describe('OpenTuiBanner', () => {
  it('renders the title, model and project directory', () => {
    const { container } = render(
      <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('>_ Qwen Code');
    expect(text).toContain('qwen3-coder-plus');
    expect(text).toContain('qwen-code');
  });

  it('outlines the info panel with the palette’s default border colour', () => {
    const { container } = render(
      <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
    );
    const panel = container.querySelector('[data-bordercolor]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('data-bordercolor')).toBe(C.borderDefault);
  });

  it('renders the version reported by the config with a v prefix', () => {
    const { container } = render(
      <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
    );
    expect(container.textContent).toContain('(v9.9.9-test)');
  });

  it('shows a non-semver version as-is instead of prefixing it', () => {
    const { container } = render(
      <OpenTuiBanner
        config={fakeConfig({
          getCliVersion: () => 'nightly',
        } as Partial<Config>)}
        settings={fakeSettings()}
      />,
    );
    expect(container.textContent).toContain('(nightly)');
  });

  it('falls back to unknown rather than an empty label', () => {
    const { container } = render(
      <OpenTuiBanner
        config={fakeConfig({
          getCliVersion: () => undefined,
        } as Partial<Config>)}
        settings={fakeSettings()}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('(unknown)');
    expect(text).not.toContain('()');
  });

  it('suppresses the banner when ui.hideBanner is set', () => {
    const { container } = render(
      <OpenTuiBanner
        config={fakeConfig()}
        settings={fakeSettings({ hideBanner: true })}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('suppresses the banner in screen-reader mode', () => {
    const { container } = render(
      <OpenTuiBanner
        config={fakeConfig({ getScreenReader: () => true } as Partial<Config>)}
        settings={fakeSettings()}
      />,
    );
    expect(container.textContent).toBe('');
  });
});

/**
 * Expected foregrounds read off the ink truecolor capture of this frame
 * (s01-boot-banner/ink/boot.styled.txt), where the wordmark is 36,37,37,37,37,37
 * columns wide and `ink-gradient` samples a fresh ramp per laid-out line.
 */
describe('wordmark gradient', () => {
  it('samples each line on its own ramp, as ink’s per-line Transform does', () => {
    const { container } = render(
      <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
    );
    const rows = logoRows(container);
    // One rendered row per logo line, each as wide as its own line.
    const logoLines = shortAsciiLogo.split('\n').filter((line) => line.length);
    expect(rows.map((row) => row.length)).toEqual(
      logoLines.map((line) => [...line].length),
    );
    // Every line starts on the first stop and ends on the last: each line runs
    // its own ramp rather than slicing one shared ramp.
    for (const row of rows) {
      expect(row[0]).toBe('#4796e4');
      expect(row.at(-1)).toBe('#c3677f');
    }
  });

  it('reaches the last stop on every line, including the shorter first one', () => {
    const { container } = render(
      <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
    );
    for (const row of logoRows(container)) {
      expect(row.at(-1)).toBe('#c3677f');
    }
  });

  it('follows the active theme’s own ramp', () => {
    applyOpenTuiTheme(getOpenTuiTheme('Dracula')!);
    try {
      const { container } = render(
        <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
      );
      for (const row of logoRows(container)) {
        expect(row[0]).toBe('#ff79c6');
        expect(row.at(-1)).toBe('#8be9fd');
      }
    } finally {
      applyThemeMode('dark');
    }
  });

  it('repaints a mounted banner when the theme changes', () => {
    // `/theme` mutates this LoadedSettings in place and leaves the Config
    // alone, so no other memo dep changes identity under a live banner.
    const config = fakeConfig();
    const settings = fakeSettings();
    const { container, rerender } = render(
      <OpenTuiBanner config={config} settings={settings} />,
    );
    expect(logoRows(container)[0]![0]).toBe('#4796e4');

    applyOpenTuiTheme(getOpenTuiTheme('Dracula')!);
    try {
      rerender(<OpenTuiBanner config={config} settings={settings} />);
      expect(logoRows(container)[0]![0]).toBe('#ff79c6');
    } finally {
      applyThemeMode('dark');
    }
  });

  it('leaves the logo uncolored when the theme has no usable ramp', () => {
    const previous = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    applyOpenTuiTheme(getActiveOpenTuiTheme());
    try {
      const { container } = render(
        <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
      );
      const rows = logoRows(container);
      expect(rows).toHaveLength(
        shortAsciiLogo.split('\n').filter((line) => line.length).length,
      );
      for (const row of rows) {
        for (const cell of row) {
          expect(cell).toBeNull();
        }
      }
    } finally {
      if (previous === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = previous;
      applyThemeMode('dark');
    }
  });
});
