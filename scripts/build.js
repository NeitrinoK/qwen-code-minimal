/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// `npm install -g .` runs this build through the `prepare` lifecycle with
// `npm_config_global=true` in the environment. That flag leaks into the nested
// `npm run build --workspace=...` calls below, where npm rejects it with
// "Workspaces not supported for global packages". Strip the global flags so the
// per-package builds always run as a normal (local) workspace build.
const childEnv = { ...process.env };
delete childEnv['npm_config_global'];
delete childEnv['npm_config_g'];
const run = (command) =>
  execSync(command, { stdio: 'inherit', cwd: root, env: childEnv });

// npm install if node_modules was removed (e.g. via npm run clean or scripts/clean.js)
if (!existsSync(join(root, 'node_modules'))) {
  run('npm install');
}

// build all workspaces/packages in dependency order
run('npm run generate');

// Build in dependency order:
// 1. core (foundation package, includes test-utils)
// 2. acp-bridge (depends on core - used by cli)
// 3. cli (depends on core, acp-bridge)
const buildOrder = ['packages/core', 'packages/acp-bridge', 'packages/cli'];

for (const workspace of buildOrder) {
  run(`npm run build --workspace=${workspace}`);
}

// The external-context integration is not an npm workspace, but its compiled
// modules back the bundled Mem0 server's integration tests, which import them
// from integrations/external-context/dist.
run('npx tsc --build integrations/external-context');

// also build container image if sandboxing is enabled
// skip (-s) npm install + build since we did that above
try {
  run('node scripts/sandbox_command.js -q');
  if (
    process.env.BUILD_SANDBOX === '1' ||
    process.env.BUILD_SANDBOX === 'true'
  ) {
    run('node scripts/build_sandbox.js -s');
  }
} catch {
  // ignore
}
