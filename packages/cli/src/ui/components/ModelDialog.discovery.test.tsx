/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderModelDialogForTest } from './__testHelpers__/renderModelDialog.js';

const useHubModelDiscoveryMock = vi.fn();
vi.mock('../hooks/use-hub-model-discovery.js', () => ({
  useHubModelDiscovery: (...args: unknown[]) =>
    useHubModelDiscoveryMock(...args),
}));

// Matches ModelDialog.test.tsx's own mocking: ModelDialog requires a
// KeypressProvider ancestor for useKeypress, which this test's minimal
// provider scaffolding does not supply.
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

// Avoid exercising the interactive select widget for these presentation-only
// assertions, matching ModelDialog.test.tsx's own mocking of it.
vi.mock('./shared/DescriptiveRadioButtonSelect.js', () => ({
  DescriptiveRadioButtonSelect: () => null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ModelDialog hub discovery states', () => {
  it('shows the loading spinner text while state is "loading"', () => {
    useHubModelDiscoveryMock.mockReturnValue({
      state: 'loading',
      refreshToken: 0,
      hubLabel: 'Test Hub',
    });
    const { getByText } = renderModelDialogForTest();
    expect(getByText(/Loading models from Test Hub/)).toBeDefined();
  });

  it('names the STAGE hub in the loading text when discovering stage', () => {
    useHubModelDiscoveryMock.mockReturnValue({
      state: 'loading',
      refreshToken: 0,
      hubLabel: 'Test Hub Stage',
    });
    const { getByText } = renderModelDialogForTest();
    expect(getByText(/Loading models from Test Hub Stage/)).toBeDefined();
  });

  it('shows the fallback note when state is "error"', () => {
    useHubModelDiscoveryMock.mockReturnValue({
      state: 'error',
      refreshToken: 0,
      hubLabel: 'Test Hub',
    });
    const { getByText } = renderModelDialogForTest();
    expect(
      getByText(/Couldn't reach Test Hub — showing last known models/),
    ).toBeDefined();
  });

  it('shows neither spinner nor note when idle', () => {
    useHubModelDiscoveryMock.mockReturnValue({
      state: 'idle',
      refreshToken: 1,
      hubLabel: 'Test Hub',
    });
    const { queryByText } = renderModelDialogForTest();
    expect(queryByText(/Loading models from Test Hub/)).toBeNull();
    expect(queryByText(/Couldn't reach Test Hub/)).toBeNull();
  });
});
