/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Tests point the gate at a fixture root; the default stays the repository.
// Truthiness, not `??`: an exported-but-empty variable would otherwise make
// every path below cwd-relative, and the gate would report on whatever
// lockfile happens to sit in that directory as if it were the repository's.
const envRoot = process.env.CHECK_LOCKFILE_ROOT?.trim();
const root = envRoot ? envRoot : join(__dirname, '..');
const lockfilePath = join(root, 'package-lock.json');

function readJsonFile(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    console.error(`Error reading or parsing ${filePath}:`, error);
    return null;
  }
}

console.log('Checking lockfile...');

const lockfile = readJsonFile(lockfilePath);
if (lockfile === null) {
  process.exit(1);
}
const packages = lockfile.packages || {};
if (Object.keys(packages).length === 0) {
  console.error(
    '\nError: package-lock.json has no packages section; regenerate it with `npm install`.',
  );
  process.exit(1);
}

const invalidPackages = [];
for (const [location, details] of Object.entries(packages)) {
  // 1. Skip the root package itself.
  if (location === '') {
    continue;
  }

  // 2. Skip local workspace packages.
  // They are identifiable in two ways:
  // a) As a symlink within node_modules.
  // b) As the source package definition, whose path is not in node_modules.
  if (details.link === true || !location.includes('node_modules')) {
    continue;
  }

  // 3. Any remaining package should be a third-party dependency.
  // 1) Registry package with both "resolved" and "integrity" fields is valid.
  if (details.resolved && details.integrity) {
    continue;
  }
  // 2) Git and file dependencies only need a "resolved" field.
  const isGitOrFileDep =
    details.resolved?.startsWith('git') ||
    details.resolved?.startsWith('file:');
  if (isGitOrFileDep) {
    continue;
  }

  // Mark the left dependency as invalid.
  invalidPackages.push(location);
}

// The lockfile must describe the workspaces the root manifest declares:
// a stale entry for a removed package, or a missing one for a kept package,
// means `npm ci` installs a tree that no longer matches the manifests.
const workspaceErrors = [];
const rootManifest = readJsonFile(join(root, 'package.json'));
if (rootManifest === null) {
  process.exit(1);
}
const lockedWorkspaces = Object.entries(packages)
  .filter(
    ([location, details]) =>
      location !== '' &&
      !location.includes('node_modules') &&
      details.link !== true,
  )
  .map(([location]) => location);
for (const location of lockedWorkspaces) {
  const manifest = join(root, location, 'package.json');
  if (!fs.existsSync(manifest)) {
    workspaceErrors.push(
      `package-lock.json lists workspace "${location}", which has no package.json`,
    );
  }
}
const declaredWorkspaces = Array.isArray(packages['']?.workspaces)
  ? packages[''].workspaces
  : [];
const manifestWorkspaces = Array.isArray(rootManifest.workspaces)
  ? rootManifest.workspaces
  : [];
if (
  JSON.stringify([...declaredWorkspaces].sort()) !==
  JSON.stringify([...manifestWorkspaces].sort())
) {
  workspaceErrors.push(
    `package-lock.json workspaces ${JSON.stringify(declaredWorkspaces)} do not match package.json workspaces ${JSON.stringify(manifestWorkspaces)}; run \`npm install\``,
  );
}

if (invalidPackages.length > 0) {
  console.error(
    '\nError: The following dependencies in package-lock.json are missing the "resolved" or "integrity" field:',
  );
  invalidPackages.forEach((pkg) => console.error(`- ${pkg}`));
  process.exitCode = 1;
}
if (workspaceErrors.length > 0) {
  console.error('\nError: package-lock.json is out of step with package.json:');
  workspaceErrors.forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
}
if (invalidPackages.length === 0 && workspaceErrors.length === 0) {
  console.log('Lockfile check passed.');
  process.exitCode = 0;
}
