/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getWorkspacePackageJsonPaths } from './workspaces.js';

// A script to handle versioning and ensure all related changes are in a single, atomic commit.

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

const TOP_LEVEL_VERSION = /^( {2}"version": )"[^"]*"/m;

// Rewrite only the top-level "version" field so a release bump leaves the
// rest of the manifest (key order, empty blocks) byte-identical.
function setManifestVersion(filePath, version) {
  const text = readFileSync(filePath, 'utf-8');
  if (!TOP_LEVEL_VERSION.test(text)) {
    throw new Error(`No top-level "version" field in ${filePath}`);
  }
  writeFileSync(
    filePath,
    text.replace(
      TOP_LEVEL_VERSION,
      (_, prefix) => `${prefix}${JSON.stringify(version)}`,
    ),
  );
}

// 1. Get the version from the command line arguments.
const versionType = process.argv[2];
if (!versionType) {
  console.error('Error: No version specified.');
  console.error(
    'Usage: npm run version <version> (e.g., 1.2.3 or patch|minor|major|prerelease)',
  );
  process.exit(1);
}

// 2. Resolve patch/minor/etc. once against the root, then align every
// workspace to that exact version. Bumping each workspace with the same
// increment would let a lagging workspace drift instead of converging.
// --no-workspaces-update keeps npm from reifying node_modules here; the
// lockfile is updated explicitly below.
run(
  `npm version ${versionType} --no-git-tag-version --allow-same-version --no-workspaces-update`,
);
const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
const newVersion = readJson(rootPackageJsonPath).version;

const { workspaces } = readJson(rootPackageJsonPath);
const workspaceManifests = getWorkspacePackageJsonPaths(
  process.cwd(),
  workspaces,
);
for (const manifestPath of workspaceManifests) {
  setManifestVersion(resolve(process.cwd(), manifestPath), newVersion);
}

// 3. Keep package-lock.json in step without a network-dependent reify: the
// root entry and every workspace entry carry the manifest version verbatim.
const lockfilePath = resolve(process.cwd(), 'package-lock.json');
if (existsSync(lockfilePath)) {
  const lockfile = readJson(lockfilePath);
  lockfile.version = newVersion;
  if (lockfile.packages?.['']) {
    lockfile.packages[''].version = newVersion;
  }
  for (const manifestPath of workspaceManifests) {
    const entry = lockfile.packages?.[dirname(manifestPath)];
    if (entry) {
      entry.version = newVersion;
    }
  }
  writeJson(lockfilePath, lockfile);
}

// 4. Update the sandboxImageUri in the root package.json
const rootPackageJson = readJson(rootPackageJsonPath);
if (rootPackageJson.config?.sandboxImageUri) {
  rootPackageJson.config.sandboxImageUri =
    rootPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(`Updated sandboxImageUri in root to use version ${newVersion}`);
  writeJson(rootPackageJsonPath, rootPackageJson);
}

// 5. Update the sandboxImageUri in the cli package.json
const cliPackageJsonPath = resolve(process.cwd(), 'packages/cli/package.json');
const cliPackageJson = readJson(cliPackageJsonPath);
if (cliPackageJson.config?.sandboxImageUri) {
  cliPackageJson.config.sandboxImageUri =
    cliPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(
    `Updated sandboxImageUri in cli package to use version ${newVersion}`,
  );
  writeJson(cliPackageJsonPath, cliPackageJson);
}

console.log(`Successfully bumped versions to v${newVersion}.`);
