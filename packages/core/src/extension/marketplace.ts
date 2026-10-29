/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionInstallMetadata } from '../config/config.js';
import type { ClaudeMarketplaceConfig } from './claude-converter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';

const ONLY_LOCAL_ERROR =
  'Only local extension installation is supported; remote installs (git, npm, marketplace) have been removed.';

/**
 * Read marketplace config from a local directory's
 * `.claude-plugin/marketplace.json`.
 */
async function readLocalMarketplaceConfig(
  localPath: string,
): Promise<ClaudeMarketplaceConfig | null> {
  const marketplaceConfigPath = path.join(
    localPath,
    '.claude-plugin',
    'marketplace.json',
  );
  try {
    const content = await fs.promises.readFile(marketplaceConfigPath, 'utf-8');
    return JSON.parse(content) as ClaudeMarketplaceConfig;
  } catch {
    return null;
  }
}

/**
 * Loads a Claude-format marketplace config (`.claude-plugin/marketplace.json`)
 * from a local source string, without installing anything. Used by the
 * marketplace registry / Discover view to enumerate installable plugins.
 *
 * Only local sources are supported — remote installs (git, npm, http
 * marketplace URLs) have been removed. Supported sources:
 * - Local directory containing `.claude-plugin/marketplace.json`
 * - Local path directly to a `marketplace.json` file
 *
 * Returns `null` when no local marketplace config can be resolved.
 */
export async function loadMarketplaceConfigFromSource(
  source: string,
  _networkPolicy?: ExtensionInstallMetadata['networkPolicy'],
): Promise<ClaudeMarketplaceConfig | null> {
  const trimmed = source.trim();

  // Local path: a directory with .claude-plugin/marketplace.json, or a direct
  // marketplace.json file.
  try {
    const stats = await stat(trimmed);
    if (stats.isDirectory()) {
      return await readLocalMarketplaceConfig(trimmed);
    }
    if (stats.isFile()) {
      try {
        const content = await fs.promises.readFile(trimmed, 'utf-8');
        return JSON.parse(content) as ClaudeMarketplaceConfig;
      } catch {
        return null;
      }
    }
  } catch {
    // Not a local path; remote sources are no longer supported.
  }

  return null;
}

/**
 * Parse the install source string into an install metadata object.
 *
 * Only local-path installation is supported. If the source resolves to an
 * existing local directory, the metadata is returned with type 'local' (or
 * 'link' when the caller requests a symlink install). Anything that is not a
 * local path (git URL, owner/repo, @scope/npm package, marketplace url:plugin)
 * is rejected — remote installs have been removed.
 */
export async function parseInstallSource(
  source: string,
  options?: { link?: boolean },
): Promise<ExtensionInstallMetadata> {
  let isLocalPath = false;
  try {
    const stats = await stat(source);
    isLocalPath = stats.isDirectory();
  } catch {
    // Not a local path or doesn't exist.
  }

  if (!isLocalPath) {
    throw new Error(ONLY_LOCAL_ERROR);
  }

  return {
    source,
    type: options?.link ? 'link' : 'local',
  };
}
