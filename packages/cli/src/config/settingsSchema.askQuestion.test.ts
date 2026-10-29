/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getSettingsSchema } from './settingsSchema.js';

describe('skills.enforceAskQuestion setting', () => {
  it('exists as a boolean defaulting to true', () => {
    const prop = getSettingsSchema().skills.properties.enforceAskQuestion;
    expect(prop).toBeDefined();
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(true);
  });
});
