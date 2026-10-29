/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

const timeoutMinutes = Number(process.env['TB_TIMEOUT_MINUTES'] || '5');
const testTimeoutMs = timeoutMinutes * 60 * 1000;
const isSelfHostedRunner = process.env['RUNNER_ENVIRONMENT'] === 'self-hosted';

export default defineConfig({
  test: {
    testTimeout: testTimeoutMs,
    globalSetup: './globalSetup.ts',
    reporters: ['default'],
    include: ['**/*.test.ts'],
    exclude: [
      '**/terminal-bench/*.test.ts',
      '**/hook-integration/**',
      '**/qwen-daemon-loadtest*',
      '**/qwen-daemon-first-output-benchmark*',
      '**/node_modules/**',
    ],
    retry: 2,
    fileParallelism: true,
    pool: 'forks',
    // Vitest 4 moved the pool limits to top-level options. Each ECS host runs
    // several Actions runners, so keep every E2E shard to one worker there so
    // concurrent jobs cannot multiply the host load and starve
    // latency-sensitive integration paths.
    maxWorkers: isSelfHostedRunner ? 1 : 4,
    // The worker->main `onTaskUpdate` RPC runs on a 60s budget; under
    // resource pressure a stall longer than that surfaces as an unhandled
    // error and exits an all-green run red (the same failure class the
    // core, cli, and scripts suites hit on the macOS lane). Self-hosted
    // runners hit the same pressure class, so they are exempted as well.
    // Test failures still fail the run; only unhandled errors stop being
    // fatal — github-hosted Linux and local Linux runs keep the signal.
    dangerouslyIgnoreUnhandledErrors:
      process.platform !== 'linux' || isSelfHostedRunner,
  },
});
