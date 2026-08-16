/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const metadata = [
  ['windows-build-x64', 'latest.yml'],
  ['windows-build-arm64', 'latest.yml'],
  ['macos-build-x64', 'latest-mac.yml'],
  ['macos-build-arm64', 'latest-mac.yml'],
  ['linux-build-x64', 'latest-linux.yml'],
  ['linux-build-arm64', 'latest-linux-arm64.yml'],
] as const;

function fixture(omitted?: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wayland-release-assets-'));
  roots.push(root);
  const input = path.join(root, 'build-artifacts');
  const output = path.join(root, 'release-assets');
  for (const [artifact, name] of metadata) {
    if (artifact === omitted) continue;
    const directory = path.join(input, artifact);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, name), 'version: 1.2.3\n');
  }
  writeFileSync(path.join(input, 'windows-build-x64', 'Wayland-test.exe'), 'installer');
  return { input, output };
}

/**
 * Locate a usable `bash`.
 *
 * A stock Windows PowerShell session has no `bash` on PATH even when Git for
 * Windows is installed, so `spawnSync('bash', …)` fails ENOENT and reports
 * `status: null`. That surfaces as "expected null to be 0" - a missing
 * interpreter wearing the costume of a failed assertion. Probe PATH first, then
 * the Git for Windows install locations, and cache the winner.
 */
let cachedBash: string | null | undefined;
function resolveBash(): string | null {
  if (cachedBash !== undefined) return cachedBash;

  const candidates = ['bash'];
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'];
    for (const root of roots) {
      if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
    }
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'exit 0']);
    if (!probe.error && probe.status === 0) {
      cachedBash = candidate;
      return cachedBash;
    }
  }
  cachedBash = null;
  return cachedBash;
}

function prepare(input: string, output: string) {
  const bash = resolveBash();
  // Say so plainly rather than letting a null exit status masquerade as a
  // release-script defect.
  if (!bash) throw new Error('No usable `bash` found; install Git for Windows or put bash on PATH.');
  return spawnSync(bash, ['scripts/prepare-release-assets.sh', input, output], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('prepare-release-assets updater feed completeness', () => {
  it('accepts the complete six-target updater metadata set', () => {
    const { input, output } = fixture();
    const result = prepare(input, output);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it.each([
    ['windows-build-arm64', 'latest-win-arm64.yml'],
    ['macos-build-arm64', 'latest-arm64-mac.yml'],
  ])('fails closed when %s metadata is absent', (artifact, expectedName) => {
    const { input, output } = fixture(artifact);
    const result = prepare(input, output);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`Missing required updater metadata: ${expectedName}`);
  });
});
