/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, configDefaults } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@qwen-code/qwen-code-core/noFollowOpen': path.resolve(
        __dirname,
        '../core/src/utils/no-follow-open.ts',
      ),
      '@qwen-code/qwen-code-core/subSessionConstants': path.resolve(
        __dirname,
        '../core/src/tools/sub-session-constants.ts',
      ),
      '@qwen-code/qwen-code-core/goalWire': path.resolve(
        __dirname,
        '../core/src/goals/goal-wire.ts',
      ),
      '@qwen-code/qwen-code-core/transcriptRecords': path.resolve(
        __dirname,
        '../core/src/utils/transcript-records.ts',
      ),
      '@qwen-code/qwen-code-core/telemetryConstants': path.resolve(
        __dirname,
        '../core/src/telemetry/constants.ts',
      ),
      '@qwen-code/qwen-code-core/userPromptSubmitContext': path.resolve(
        __dirname,
        '../core/src/hooks/user-prompt-submit-context.ts',
      ),
    },
  },
  test: {
    // vitest 4 no longer excludes build output by default; keep the compiled
    // dist/ (which contains *.test.js copies) out of test discovery so
    // `build` followed by `test` doesn't run stale duplicates.
    exclude: [...configDefaults.exclude, '**/dist/**'],
    // Shared ECS hosts can pause an otherwise healthy test past Vitest's 5s
    // default when several CI runners on the same machine are busy.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
    hookTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
    reporters: ['default'],
    silent: true,
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    coverage: {
      enabled: false,
      provider: 'v8',
      include: ['src/**/*'],
    },
  },
});
