/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillContent } from './skill-load.js';

const bundledDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'bundled',
);

export const EXPECTED = [
  'brainstorming',
  'writing-plans',
  'subagent-driven-development',
  'executing-plans',
  'systematic-debugging',
  'test-driven-development',
  'verification-before-completion',
  'requesting-code-review',
  'using-git-worktrees',
  'finishing-a-development-branch',
] as const;

const EXCLUDED = [
  'using-superpowers',
  'writing-skills',
  'dispatching-parallel-agents',
  'receiving-code-review',
];

// Distinctive (hyphenated) sibling names: an *invocation* of one of these must
// be prefixed. We only flag the invocation-verb pattern to avoid false positives
// on prose mentions of the concept.
const DISTINCTIVE = EXPECTED.filter((n) => n.includes('-'));

function superpowersDirs(): string[] {
  if (!fs.existsSync(bundledDir)) return [];
  return fs
    .readdirSync(bundledDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('superpowers-'))
    .map((d) => d.name)
    .sort();
}

describe('bundled superpowers: license', () => {
  it('ships the MIT license + NOTICE', () => {
    const lic = path.join(bundledDir, 'SUPERPOWERS_LICENSE');
    expect(fs.existsSync(lic)).toBe(true);
    expect(fs.readFileSync(lic, 'utf8')).toContain('MIT License');
    expect(fs.existsSync(path.join(bundledDir, 'SUPERPOWERS_NOTICE'))).toBe(
      true,
    );
  });
});

describe.each(superpowersDirs())('bundled superpowers: %s', (dir) => {
  const suffix = dir.replace(/^superpowers-/, '');
  const file = path.join(bundledDir, dir, 'SKILL.md');
  const content = fs.readFileSync(file, 'utf8');

  it('has valid frontmatter (name superpowers:<suffix> + description)', () => {
    const cfg = parseSkillContent(content, file);
    expect(cfg.name).toBe(`superpowers:${suffix}`);
    expect(cfg.description).toBeTruthy();
    expect(cfg.body.length).toBeGreaterThan(0);
  });

  it('contains no Claude-Code-specific artifacts', () => {
    expect(content).not.toMatch(/\.claude\/plugins/);
    expect(content).not.toMatch(/Visual Companion/i);
    expect(content).not.toMatch(/SessionStart/);
  });

  it('prefixed cross-refs resolve to the curated set (none excluded)', () => {
    const refs = content.match(/superpowers:[a-z0-9-]+/g) ?? [];
    for (const ref of refs) {
      const name = ref.slice('superpowers:'.length);
      if (name === suffix) continue;
      expect([...EXPECTED]).toContain(name);
      expect(EXCLUDED).not.toContain(name);
    }
  });

  it('invocations of sibling skills use the superpowers: prefix', () => {
    for (const d of DISTINCTIVE) {
      if (d === suffix) continue;
      // "invoke ... <bare-d>" within a short window, not already prefixed
      const bareInvoke = new RegExp(
        `\\binvoke\\b[^\\n]{0,40}?(?<!superpowers:)\\b${d}\\b`,
        'i',
      );
      expect(content).not.toMatch(bareInvoke);
    }
  });

  it('referenced local supporting files exist', () => {
    const refs =
      content.match(
        /(?:scripts\/[A-Za-z0-9._\-/]+|\.\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g,
      ) ?? [];
    for (const r of refs) {
      const rel = r.replace(/^\.\//, '');
      expect(fs.existsSync(path.join(bundledDir, dir, rel))).toBe(true);
    }
  });

  it('references no non-bundled golang-* skills', () => {
    expect(content).not.toMatch(/golang-[a-z-]+/i);
  });
});

describe('bundled superpowers: completeness', () => {
  it('bundles exactly the 10 curated skills', () => {
    const present = new Set(
      fs
        .readdirSync(bundledDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('superpowers-'))
        .map((d) => d.name.replace(/^superpowers-/, '')),
    );
    for (const n of EXPECTED) expect([...present]).toContain(n);
    expect(present.size).toBe(EXPECTED.length);
  });
});
