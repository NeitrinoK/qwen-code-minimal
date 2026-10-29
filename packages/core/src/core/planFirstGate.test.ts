/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  shouldGatePlanFirst,
  extractGatedWritePath,
  PLAN_GATE_SKILL,
} from './planFirstGate.js';

const base = {
  enabled: true,
  sessionOverride: false,
  toolName: 'write_file',
  filePath: '/repo/src/foo.ts',
  writingPlansInvoked: false,
};

describe('shouldGatePlanFirst', () => {
  it('blocks an unplanned code write', () => {
    expect(shouldGatePlanFirst(base)).toBe(true);
  });

  it('allows once writing-plans has been invoked', () => {
    expect(shouldGatePlanFirst({ ...base, writingPlansInvoked: true })).toBe(
      false,
    );
  });

  it('allows when the session override is set', () => {
    expect(shouldGatePlanFirst({ ...base, sessionOverride: true })).toBe(false);
  });

  it('allows when the gate is disabled', () => {
    expect(shouldGatePlanFirst({ ...base, enabled: false })).toBe(false);
  });

  it('allows writes under docs/superpowers/', () => {
    expect(
      shouldGatePlanFirst({
        ...base,
        filePath: '/repo/docs/superpowers/specs/x.md',
      }),
    ).toBe(false);
  });

  it('allows writes under docs/superpowers/ with Windows path separators', () => {
    expect(
      shouldGatePlanFirst({
        ...base,
        filePath: 'C:\\repo\\docs\\superpowers\\specs\\x.md',
      }),
    ).toBe(false);
  });

  it('allows a bare relative docs/superpowers/ path', () => {
    expect(
      shouldGatePlanFirst({ ...base, filePath: 'docs/superpowers/x.md' }),
    ).toBe(false);
  });

  it('gates a mid-segment "docs/superpowers/" match (e.g. mydocs/superpowers/)', () => {
    // The exemption must anchor to a path-segment boundary; a directory whose
    // name merely ends in "docs" must NOT slip the gate.
    expect(
      shouldGatePlanFirst({
        ...base,
        filePath: '/repo/mydocs/superpowers/foo.ts',
      }),
    ).toBe(true);
  });

  it('allows non-write tools', () => {
    expect(
      shouldGatePlanFirst({ ...base, toolName: 'run_shell_command' }),
    ).toBe(false);
    expect(shouldGatePlanFirst({ ...base, toolName: 'read_file' })).toBe(false);
  });

  it('gates edit and notebook_edit as well as write_file', () => {
    expect(shouldGatePlanFirst({ ...base, toolName: 'edit' })).toBe(true);
    expect(shouldGatePlanFirst({ ...base, toolName: 'notebook_edit' })).toBe(
      true,
    );
  });

  it('allows a gated tool with no resolvable path (cannot judge exemption → do not block)', () => {
    expect(shouldGatePlanFirst({ ...base, filePath: undefined })).toBe(false);
  });

  it('exposes the writing-plans skill name', () => {
    expect(PLAN_GATE_SKILL).toBe('superpowers:writing-plans');
  });
});

describe('extractGatedWritePath', () => {
  it('reads file_path for write_file and edit', () => {
    expect(extractGatedWritePath('write_file', { file_path: '/a/b.ts' })).toBe(
      '/a/b.ts',
    );
    expect(extractGatedWritePath('edit', { file_path: '/a/c.ts' })).toBe(
      '/a/c.ts',
    );
  });

  it('reads notebook_path for notebook_edit', () => {
    expect(
      extractGatedWritePath('notebook_edit', { notebook_path: '/a/n.ipynb' }),
    ).toBe('/a/n.ipynb');
  });

  it('returns undefined for a non-write tool or missing key', () => {
    expect(extractGatedWritePath('read_file', { file_path: '/a/b.ts' })).toBe(
      undefined,
    );
    expect(extractGatedWritePath('write_file', {})).toBe(undefined);
  });
});
