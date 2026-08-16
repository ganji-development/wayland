/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postinstall = require('../../../scripts/postinstall.js') as {
  verifyElectronBinary(electronRoot: string): boolean;
  ELECTRON_BINARY_BY_PLATFORM: Record<string, string | undefined>;
};

const testRoots: string[] = [];

/** An `node_modules/electron`-shaped directory that no real install owns. */
function createElectronRoot(): string {
  const root = resolve(process.cwd(), 'node_modules', `.postinstall-electron-test-${process.pid}-${testRoots.length}`);
  mkdirSync(root, { recursive: true });
  testRoots.push(root);
  return root;
}

/** Lay down `dist/<relative>` with a byte in it, plus the `path.txt` that names it. */
function createBinary(root: string, relative: string, { withPathTxt = true } = {}): void {
  const binary = resolve(root, 'dist', relative);
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, 'binary');
  if (withPathTxt) writeFileSync(resolve(root, 'path.txt'), relative);
}

beforeEach(() => {
  // The real failure prints a large diagnostic block; keep the suite output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete process.env.WAYLAND_SKIP_ELECTRON_CHECK;
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('postinstall electron binary verification', () => {
  it('passes when the binary named by path.txt is present', () => {
    const root = createElectronRoot();
    createBinary(root, 'electron.exe');

    expect(postinstall.verifyElectronBinary(root)).toBe(true);
  });

  it('fails on the half-extracted dist that yauzl leaves behind', () => {
    // The exact shape of the silent failure: extraction stalls on entry 1, so
    // dist/ exists and holds one unrelated file while the executable never lands.
    const root = createElectronRoot();
    mkdirSync(resolve(root, 'dist', 'locales'), { recursive: true });
    writeFileSync(resolve(root, 'dist', 'locales', 'pt-BR.pak'), 'partial');
    writeFileSync(resolve(root, 'path.txt'), 'electron.exe');

    expect(postinstall.verifyElectronBinary(root)).toBe(false);
  });

  it('fails when the installer produced no dist at all', () => {
    const root = createElectronRoot();
    writeFileSync(resolve(root, 'path.txt'), 'electron.exe');

    expect(postinstall.verifyElectronBinary(root)).toBe(false);
  });

  it('falls back to the platform layout when path.txt is absent', () => {
    const relative = postinstall.ELECTRON_BINARY_BY_PLATFORM[process.platform];
    // Only assert the fallback on platforms the map actually describes.
    if (!relative) return;

    const missing = createElectronRoot();
    expect(postinstall.verifyElectronBinary(missing)).toBe(false);

    const present = createElectronRoot();
    createBinary(present, relative, { withPathTxt: false });
    expect(postinstall.verifyElectronBinary(present)).toBe(true);
  });

  it('stays out of the way when electron is absent or the check is opted out of', () => {
    const absent = resolve(process.cwd(), 'node_modules', `.postinstall-electron-missing-${process.pid}`);
    expect(postinstall.verifyElectronBinary(absent)).toBe(true);

    // A broken root must still pass once the install declares it ships no binary.
    const broken = createElectronRoot();
    writeFileSync(resolve(broken, 'path.txt'), 'electron.exe');
    expect(postinstall.verifyElectronBinary(broken)).toBe(false);

    process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1';
    expect(postinstall.verifyElectronBinary(broken)).toBe(true);
    delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;

    process.env.WAYLAND_SKIP_ELECTRON_CHECK = '1';
    expect(postinstall.verifyElectronBinary(broken)).toBe(true);
  });
});
