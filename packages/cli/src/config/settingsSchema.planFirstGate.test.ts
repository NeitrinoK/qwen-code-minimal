/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getSettingsSchema } from './settingsSchema.js';

describe('skills.planFirstGate setting', () => {
  it('exists as a boolean defaulting to true', () => {
    const SETTINGS_SCHEMA = getSettingsSchema();
    const prop = SETTINGS_SCHEMA.skills.properties.planFirstGate;
    expect(prop).toBeDefined();
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(true);
  });
});
