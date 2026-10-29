/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MemorySearchIndex: a MiniSearch wrapper holding memory + transcript docs.
 *
 * Both memory entries and transcript excerpts are indexed together (tagged
 * with `source`) so the same in-process index can serve either. The index is
 * persisted via {@link MemorySearchIndex.prototype.toJSON} /
 * {@link MemorySearchIndex.fromJSON}; `fromJSON` returns `null` on any parse
 * error or schema-version mismatch, in which case the caller is expected to
 * rebuild the index from scratch rather than trust stale/incompatible data.
 */

import MiniSearch from 'minisearch';
import type { Options as MiniSearchOptions } from 'minisearch';

export interface MemoryIndexDoc {
  id: string;
  source: 'memory' | 'transcript';
  tier?: 'project' | 'user';
  topic?: string;
  sessionId?: string;
  ts?: number;
  mtimeMs?: number;
  name?: string;
  description?: string;
  body?: string;
  text?: string;
}

export interface IndexHit {
  id: string;
  source: 'memory' | 'transcript';
  score: number;
  sessionId?: string;
  ts?: number;
  name?: string;
  description?: string;
  tier?: string;
  /** Stored transcript excerpt (only present for `source: 'transcript'` hits). */
  text?: string;
}

interface PersistedIndex {
  schemaVersion: number;
  mini: unknown;
}

const MINISEARCH_OPTIONS: MiniSearchOptions<MemoryIndexDoc> = {
  idField: 'id',
  fields: ['name', 'description', 'body', 'text'],
  storeFields: [
    'source',
    'tier',
    'topic',
    'sessionId',
    'ts',
    'name',
    'description',
    'mtimeMs',
    // `text` is only populated on transcript docs; recall's
    // "## Relevant past conversation" block reads it back off search hits
    // to render a snippet without re-reading transcript files. Storing it
    // (rather than only indexing it) changes the persisted shape, hence the
    // SCHEMA_VERSION bump below.
    'text',
  ],
  searchOptions: { prefix: true, fuzzy: 0.2 },
};

export class MemorySearchIndex {
  static readonly SCHEMA_VERSION = 2;

  private readonly mini: MiniSearch<MemoryIndexDoc>;

  constructor(mini?: MiniSearch<MemoryIndexDoc>) {
    this.mini = mini ?? new MiniSearch<MemoryIndexDoc>(MINISEARCH_OPTIONS);
  }

  addOrReplace(docs: MemoryIndexDoc[]): void {
    for (const doc of docs) {
      if (this.mini.has(doc.id)) {
        this.mini.replace(doc);
      } else {
        this.mini.add(doc);
      }
    }
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      if (this.mini.has(id)) {
        this.mini.discard(id);
      }
    }
  }

  search(
    query: string,
    opts: { source: 'memory' | 'transcript'; limit: number },
  ): IndexHit[] {
    const results = this.mini.search(query);
    const hits: IndexHit[] = [];
    for (const result of results) {
      if (result['source'] !== opts.source) {
        continue;
      }
      if (hits.length >= opts.limit) {
        break;
      }
      hits.push({
        id: result.id,
        source: result['source'],
        score: result.score,
        sessionId: result['sessionId'],
        ts: result['ts'],
        name: result['name'],
        description: result['description'],
        tier: result['tier'],
        text: result['text'],
      });
    }
    return hits;
  }

  has(id: string): boolean {
    return this.mini.has(id);
  }

  size(): number {
    return this.mini.documentCount;
  }

  toJSON(): string {
    const payload: PersistedIndex = {
      schemaVersion: MemorySearchIndex.SCHEMA_VERSION,
      mini: this.mini.toJSON(),
    };
    return JSON.stringify(payload);
  }

  static fromJSON(json: string): MemorySearchIndex | null {
    try {
      const parsed = JSON.parse(json) as Partial<PersistedIndex>;
      if (parsed.schemaVersion !== MemorySearchIndex.SCHEMA_VERSION) {
        return null;
      }
      const mini = MiniSearch.loadJSON<MemoryIndexDoc>(
        JSON.stringify(parsed.mini),
        MINISEARCH_OPTIONS,
      );
      return new MemorySearchIndex(mini);
    } catch {
      return null;
    }
  }
}
