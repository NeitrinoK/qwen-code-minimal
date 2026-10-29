/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MemorySearchIndex } from './search-index.js';
import type { MemoryIndexDoc } from './search-index.js';

const memoryDocs: MemoryIndexDoc[] = [
  {
    id: 'mem-1',
    source: 'memory',
    tier: 'project',
    name: 'logviewer build recipe',
    description: 'How the log viewer was built here',
    body: 'Qt6 native arm64, cert-bundle, patches applied to build.',
  },
  {
    id: 'mem-2',
    source: 'memory',
    tier: 'user',
    name: 'DbClusterX cluster',
    description: 'Dev database cluster nodes',
    body: 'system.truncated bloat blocks node startup and the fix.',
  },
  {
    id: 'mem-3',
    source: 'memory',
    tier: 'project',
    name: 'Access a git server via IP',
    description: 'Reach the git server when DNS fails',
    body: 'Resolve to 192.0.2.10, curl --resolve for build logs zorblatt.',
  },
];

const transcriptDocs: MemoryIndexDoc[] = [
  {
    id: 'session-a#1',
    source: 'transcript',
    sessionId: 'session-a',
    ts: 1000,
    text: 'We discussed the logviewer build recipe and the cert-bundle patch.',
  },
  {
    id: 'session-b#1',
    source: 'transcript',
    sessionId: 'session-b',
    ts: 2000,
    text: 'Unrelated conversation about zorblatt widgets.',
  },
];

function buildIndex(): MemorySearchIndex {
  const index = new MemorySearchIndex();
  index.addOrReplace(memoryDocs);
  index.addOrReplace(transcriptDocs);
  return index;
}

describe('MemorySearchIndex', () => {
  it('searches full body text, not just name/description', () => {
    const index = buildIndex();
    const hits = index.search('zorblatt', { source: 'memory', limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['mem-3']);
  });

  it('filters search results by source', () => {
    const index = buildIndex();

    const memoryHits = index.search('logviewer', {
      source: 'memory',
      limit: 10,
    });
    expect(memoryHits.every((h) => h.source === 'memory')).toBe(true);
    expect(memoryHits.map((h) => h.id)).toContain('mem-1');

    const transcriptHits = index.search('logviewer', {
      source: 'transcript',
      limit: 10,
    });
    expect(transcriptHits.every((h) => h.source === 'transcript')).toBe(true);
    expect(transcriptHits.map((h) => h.id)).toContain('session-a#1');
    expect(transcriptHits.map((h) => h.id)).not.toContain('mem-1');
  });

  it('caps results at the requested limit', () => {
    const index = buildIndex();
    const hits = index.search('the', { source: 'memory', limit: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('addOrReplace updates an existing doc in place', () => {
    const index = buildIndex();
    expect(index.size()).toBe(memoryDocs.length + transcriptDocs.length);

    index.addOrReplace([
      {
        id: 'mem-1',
        source: 'memory',
        tier: 'project',
        name: 'logviewer build recipe',
        description: 'How the log viewer was built here',
        body: 'Completely rewritten with a brand new gribblesnort term.',
      },
    ]);

    expect(index.size()).toBe(memoryDocs.length + transcriptDocs.length);

    const newHits = index.search('gribblesnort', {
      source: 'memory',
      limit: 10,
    });
    expect(newHits.map((h) => h.id)).toEqual(['mem-1']);

    const oldHits = index.search('cert-bundle', {
      source: 'memory',
      limit: 10,
    });
    expect(oldHits.map((h) => h.id)).not.toContain('mem-1');
  });

  it('remove drops a doc from search results', () => {
    const index = buildIndex();
    expect(index.has('mem-2')).toBe(true);

    index.remove(['mem-2']);

    expect(index.has('mem-2')).toBe(false);
    expect(index.size()).toBe(memoryDocs.length + transcriptDocs.length - 1);
    const hits = index.search('DbClusterX', { source: 'memory', limit: 10 });
    expect(hits).toEqual([]);
  });

  it('remove tolerates ids that are not present', () => {
    const index = buildIndex();
    expect(() => index.remove(['does-not-exist'])).not.toThrow();
    expect(index.size()).toBe(memoryDocs.length + transcriptDocs.length);
  });

  it('round-trips through toJSON/fromJSON with identical search results', () => {
    const index = buildIndex();
    const before = index.search('zorblatt', { source: 'memory', limit: 10 });

    const json = index.toJSON();
    const restored = MemorySearchIndex.fromJSON(json);
    expect(restored).not.toBeNull();

    const after = restored!.search('zorblatt', {
      source: 'memory',
      limit: 10,
    });
    expect(after).toEqual(before);
    expect(restored!.size()).toBe(index.size());
  });

  it('fromJSON returns null for a wrong schemaVersion', () => {
    const index = buildIndex();
    const json = index.toJSON();
    const parsed = JSON.parse(json) as { schemaVersion: number; mini: unknown };
    const badJson = JSON.stringify({ ...parsed, schemaVersion: -1 });

    expect(MemorySearchIndex.fromJSON(badJson)).toBeNull();
  });

  it('fromJSON returns null for invalid JSON', () => {
    expect(MemorySearchIndex.fromJSON('not json')).toBeNull();
  });
});
