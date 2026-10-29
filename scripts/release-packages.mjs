/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspacePackageJsonPaths } from './workspaces.js';

// Workspaces versioned on their own schedule. None of the kept workspaces
// is independent; the list stays so the filter below has one source.
export const INDEPENDENT_PACKAGES = [];

// Resolve beside this script, not cwd: the push guard uses workflow-pinned
// manifests even when the release source comes from a different ref.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { workspaces } = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);

export const RELEASE_WORKSPACES = getWorkspacePackageJsonPaths(root, workspaces)
  .map((path) => JSON.parse(readFileSync(join(root, path), 'utf8')))
  .filter((pkg) => !pkg.private && !INDEPENDENT_PACKAGES.includes(pkg.name))
  .map((pkg) => pkg.name);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of RELEASE_WORKSPACES) {
    console.log(name);
  }
}
