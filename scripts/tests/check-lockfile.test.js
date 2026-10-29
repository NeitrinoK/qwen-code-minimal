/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'check-lockfile.js');
const fixtures = [];

function fixture({ workspaces = ['packages/*'], packages, members = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'check-lockfile-'));
  fixtures.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', workspaces }),
  );
  for (const member of members) {
    mkdirSync(join(dir, member), { recursive: true });
    writeFileSync(join(dir, member, 'package.json'), '{}');
  }
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return dir;
}

function run(dir) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, CHECK_LOCKFILE_ROOT: dir },
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

const registryEntry = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz',
  integrity: 'sha512-abc',
};

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-lockfile', () => {
  it('passes a complete lockfile that matches the workspaces', () => {
    const dir = fixture({
      members: ['packages/core'],
      packages: {
        '': { workspaces: ['packages/*'] },
        'packages/core': { version: '1.0.0' },
        'node_modules/@x/core': { resolved: 'packages/core', link: true },
        'node_modules/dep': registryEntry,
        'node_modules/git-dep': { resolved: 'git+https://example.com/x.git' },
      },
    });
    const { status, out } = run(dir);
    expect(status, out).toBe(0);
    expect(out).toContain('Lockfile check passed.');
  });

  it('rejects a third-party entry without resolved/integrity', () => {
    const dir = fixture({
      packages: {
        '': { workspaces: ['packages/*'] },
        'node_modules/dep': { version: '1.0.0' },
      },
    });
    const { status, out } = run(dir);
    expect(status).toBe(1);
    expect(out).toContain('- node_modules/dep');
  });

  it('rejects a lockfile workspace whose package was removed', () => {
    const dir = fixture({
      packages: {
        '': { workspaces: ['packages/*'] },
        'packages/web-shell': { version: '1.0.0' },
      },
    });
    const { status, out } = run(dir);
    expect(status).toBe(1);
    expect(out).toContain('"packages/web-shell", which has no package.json');
  });

  it('rejects workspace globs that drifted from package.json', () => {
    const dir = fixture({
      workspaces: ['packages/*'],
      packages: {
        '': { workspaces: ['packages/*', 'packages/channels/base'] },
      },
    });
    const { status, out } = run(dir);
    expect(status).toBe(1);
    expect(out).toContain('do not match package.json workspaces');
  });

  it('fails closed on a lockfile with no packages section', () => {
    const dir = fixture({ packages: {} });
    const { status, out } = run(dir);
    expect(status).toBe(1);
    expect(out).toContain('no packages section');
  });
});
