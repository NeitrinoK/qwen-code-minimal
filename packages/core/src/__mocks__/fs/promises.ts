/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, type Mock } from 'vitest';
import * as actualFsPromises from 'node:fs/promises';

// Explicit Mock annotation: vitest 4's inferred vi.fn() type references a
// nested `vitest/node_modules/@vitest/spy` that TS cannot name portably (TS2742).
const readFileMock: Mock = vi.fn();

// Export a control object so tests can access and manipulate the mock
export const mockControl = {
  mockReadFile: readFileMock,
};

// Export all other functions from the actual fs/promises module
export const {
  access,
  appendFile,
  chmod,
  chown,
  copyFile,
  cp,
  lchmod,
  lchown,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
} = actualFsPromises;

// Override readFile with our mock
export const readFile = readFileMock;
