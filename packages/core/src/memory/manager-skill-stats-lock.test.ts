/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MemoryManager } from './manager.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `withSkillStatsLock` is a private per-projectRoot mutex (see manager.ts).
 * It's exercised directly here rather than through the real scoring/
 * deactivation entry points because driving those end-to-end requires a full
 * skill-outcomes config + on-disk skill fixtures for no added coverage of
 * the mutex itself — the lock's contract (serialize same-root, don't poison
 * on rejection, don't serialize across roots) is independent of what `fn`
 * does.
 */
function getLock(mgr: MemoryManager) {
  return (
    mgr as unknown as {
      withSkillStatsLock: <T>(
        projectRoot: string,
        fn: () => Promise<T>,
      ) => Promise<T>;
    }
  ).withSkillStatsLock.bind(mgr);
}

// ─── withSkillStatsLock() ────────────────────────────────────────────────────

describe('MemoryManager.withSkillStatsLock()', () => {
  it('serializes same-projectRoot read-modify-write so no update is lost', async () => {
    const mgr = new MemoryManager();
    const lock = getLock(mgr);

    let counter = 0;
    const readModifyWrite = async () => {
      const value = counter;
      await delay(10);
      counter = value + 1;
    };

    await Promise.all([
      lock('/proj/a', readModifyWrite),
      lock('/proj/a', readModifyWrite),
    ]);

    // If the two calls interleaved (both read 0 before either wrote), the
    // final value would be 1, not 2.
    expect(counter).toBe(2);
  });

  it('does not poison the chain when fn rejects — the next call still runs', async () => {
    const mgr = new MemoryManager();
    const lock = getLock(mgr);

    await expect(
      lock('/proj/b', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(lock('/proj/b', async () => 'ok')).resolves.toBe('ok');
  });

  it('does not serialize calls for different projectRoots', async () => {
    const mgr = new MemoryManager();
    const lock = getLock(mgr);

    const order: string[] = [];
    const slow = lock('/proj/c', async () => {
      order.push('c-start');
      await delay(20);
      order.push('c-end');
    });
    const fast = lock('/proj/d', async () => {
      order.push('d-start');
      await delay(5);
      order.push('d-end');
    });

    await Promise.all([slow, fast]);

    // Both start immediately (no cross-root serialization), and the
    // shorter-delay call finishes first — if the roots were serialized,
    // 'd-start' would only appear after 'c-end'.
    expect(order).toEqual(['c-start', 'd-start', 'd-end', 'c-end']);
  });
});
