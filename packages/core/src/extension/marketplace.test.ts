/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseInstallSource } from './marketplace.js';
import * as fs from 'node:fs/promises';

// Remote installs (git, owner/repo, npm, marketplace) have been removed.
// `parseInstallSource` now only supports local-directory installs and throws
// for everything else.
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

describe('parseInstallSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('local path parsing', () => {
    it('should parse relative path with ../ correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({
        isDirectory: () => true,
      } as never);

      const result = await parseInstallSource('../claude-code');

      expect(result.source).toBe('../claude-code');
      expect(result.type).toBe('local');
    });

    it('should parse relative path with ./ correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({
        isDirectory: () => true,
      } as never);

      const result = await parseInstallSource('./my-extension');

      expect(result.source).toBe('./my-extension');
      expect(result.type).toBe('local');
    });

    it('should parse absolute local path', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({
        isDirectory: () => true,
      } as never);

      const result = await parseInstallSource('/path/to/extension');

      expect(result.source).toBe('/path/to/extension');
      expect(result.type).toBe('local');
    });

    it('should use link type when link option is set', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({
        isDirectory: () => true,
      } as never);

      const result = await parseInstallSource('/path/to/extension', {
        link: true,
      });

      expect(result.source).toBe('/path/to/extension');
      expect(result.type).toBe('link');
    });
  });

  describe('remote sources are rejected', () => {
    const remoteSources = [
      'owner/repo',
      'https://github.com/owner/repo',
      'git@github.com:owner/repo.git',
      '@ali/openclaw-tmcp-dingtalk',
      'invalid-format-no-slash',
    ];

    for (const source of remoteSources) {
      it(`should throw for non-local source: ${source}`, async () => {
        vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

        await expect(parseInstallSource(source)).rejects.toThrow(
          /Only local extension installation is supported/,
        );
      });
    }

    it('should throw when the path exists but is not a directory', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({
        isDirectory: () => false,
      } as never);

      await expect(parseInstallSource('/some/file.txt')).rejects.toThrow(
        /Only local extension installation is supported/,
      );
    });
  });
});
