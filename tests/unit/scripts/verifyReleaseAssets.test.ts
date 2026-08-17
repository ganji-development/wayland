/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #989: verify-release-assets.sh must assert the COMPLETE expected artifact set.
 *
 * The verifier previously checked a hand-picked subset (.exe/.dmg/.deb) and had
 * no zip expectation at all, so the Windows portable zip could vanish and the
 * gate still exited 0 - which is why #941 shipped unnoticed for several
 * releases. These tests drive the real fixture pipeline
 * (create-mock -> prepare -> verify) and assert the gate FAILS on the absence of
 * every declared artifact class, one at a time. A gate that cannot fail is the
 * defect, so the negative cases are the point of this file.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireBash } from '../../helpers/resolveBash';

const VERSION = '1.0.0';
const roots: string[] = [];

function run(script: string, args: string[]) {
  // Resolved, not bare: a stock Windows PowerShell session has no `bash` on
  // PATH even with Git for Windows installed, so a bare spawn fails ENOENT and
  // returns `status: null` - reported here as "expected null to be 0", which
  // reads as every release script failing rather than as a missing interpreter.
  return spawnSync(requireBash(), [script, ...args], { cwd: process.cwd(), encoding: 'utf8' });
}

/**
 * A complete release-assets directory, built ONCE through the real scripts.
 *
 * Every case needs the same 26-artifact set and then removes one file from it.
 * Rebuilding it per case cost ~4.9s of shell work each time on Windows
 * (create-mock 1.7s + prepare 3.2s, measured), which against a 10s per-test
 * budget made the whole file a timeout generator - the pipeline is genuinely
 * that slow when every process spawn goes through Git Bash.
 *
 * Built lazily so the cost lands on the first case rather than on import.
 */
let template: string | null = null;
/** Held apart from `roots`: afterEach clears that list, and the template has to
 *  outlive every case. Removed once in afterAll. */
let templateRoot: string | null = null;

function templateAssets(): string {
  if (template) return template;

  const root = mkdtempSync(path.join(os.tmpdir(), 'wayland-verify-assets-template-'));
  templateRoot = root;
  const input = path.join(root, 'build-artifacts');
  const output = path.join(root, 'release-assets');

  const mock = run('scripts/create-mock-release-artifacts.sh', [input, VERSION]);
  expect(mock.status, `${mock.stdout}\n${mock.stderr}`).toBe(0);

  const prepared = run('scripts/prepare-release-assets.sh', [input, output]);
  expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);

  template = output;
  return template;
}

/**
 * A private, complete copy of that set for one case to mutate.
 *
 * Copying ~26 small files is far cheaper than re-running two shell scripts, and
 * each case still gets its own directory - so deleting an artifact in one case
 * cannot leak into another.
 */
function preparedAssets(): string {
  const source = templateAssets();
  const root = mkdtempSync(path.join(os.tmpdir(), 'wayland-verify-assets-'));
  roots.push(root);
  const output = path.join(root, 'release-assets');
  cpSync(source, output, { recursive: true });
  return output;
}

function verify(output: string) {
  return run('scripts/verify-release-assets.sh', [output]);
}

/**
 * Every artifact the release is supposed to produce. Deliberately spelled out
 * rather than imported from the script: if someone deletes an expectation from
 * verify-release-assets.sh, this list still demands the gate fail on it.
 */
const EXPECTED_ARTIFACTS = [
  `Wayland-${VERSION}-win-x64.exe`,
  `Wayland-${VERSION}-win-x64.exe.blockmap`,
  `Wayland-${VERSION}-win-arm64.exe`,
  `Wayland-${VERSION}-win-arm64.exe.blockmap`,
  `Wayland-${VERSION}-win-x64.zip`,
  `Wayland-${VERSION}-win-arm64.zip`,
  `Wayland-${VERSION}-mac-x64.dmg`,
  `Wayland-${VERSION}-mac-x64.dmg.blockmap`,
  `Wayland-${VERSION}-mac-arm64.dmg`,
  `Wayland-${VERSION}-mac-arm64.dmg.blockmap`,
  `Wayland-${VERSION}-mac-x64.zip`,
  `Wayland-${VERSION}-mac-x64.zip.blockmap`,
  `Wayland-${VERSION}-mac-arm64.zip`,
  `Wayland-${VERSION}-mac-arm64.zip.blockmap`,
  `Wayland-${VERSION}-linux-x86_64.AppImage`,
  `Wayland-${VERSION}-linux-arm64.AppImage`,
  `Wayland-${VERSION}-linux-amd64.deb`,
  `Wayland-${VERSION}-linux-arm64.deb`,
  `Wayland-${VERSION}-linux-x86_64.rpm`,
  `Wayland-${VERSION}-linux-aarch64.rpm`,
];

const EXPECTED_METADATA = [
  ['latest.yml', 'missing canonical metadata'],
  ['latest-mac.yml', 'missing canonical metadata'],
  ['latest-linux.yml', 'missing canonical metadata'],
  ['latest-linux-arm64.yml', 'missing canonical metadata'],
  ['latest-win-arm64.yml', 'missing arch-specific updater metadata'],
  ['latest-arm64-mac.yml', 'missing arch-specific updater metadata'],
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (templateRoot) rmSync(templateRoot, { recursive: true, force: true });
  templateRoot = null;
  template = null;
});

describe('verify-release-assets expected-set completeness', () => {
  it('passes on the complete artifact set the mock pipeline produces', () => {
    const result = verify(preparedAssets());
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('ALL CHECKS PASSED');
  });

  it.each(EXPECTED_ARTIFACTS)('fails closed when %s is absent', (artifact) => {
    const output = preparedAssets();
    unlinkSync(path.join(output, artifact));

    const result = verify(output);
    expect(result.status, `expected a non-zero exit, got:\n${result.stdout}`).toBe(1);
    expect(result.stdout).toContain(`FAIL: missing release artifact: ${artifact}`);
  });

  it.each(EXPECTED_METADATA)('fails closed when %s is absent', (metadata, message) => {
    const output = preparedAssets();
    unlinkSync(path.join(output, metadata));

    const result = verify(output);
    expect(result.status, `expected a non-zero exit, got:\n${result.stdout}`).toBe(1);
    expect(result.stdout).toContain(`FAIL: ${message}: ${metadata}`);
  });

  /**
   * The version drives every expected filename, so an unresolvable version must
   * fail loudly rather than silently expand to a set of names nothing matches.
   */
  it('fails closed when the release version cannot be resolved', () => {
    const output = preparedAssets();
    // Keep the feed present and pointing at a real file so the metadata checks
    // still pass - only the version: line, which the expected set is derived
    // from, is gone.
    writeFileSync(
      path.join(output, 'latest.yml'),
      `path: Wayland-${VERSION}-win-x64.exe\nsha512: fake\nreleaseDate: '2025-01-01'\n`
    );

    const result = verify(output);
    expect(result.status, `expected a non-zero exit, got:\n${result.stdout}`).toBe(1);
    expect(result.stdout).toContain('FAIL: cannot resolve release version');
  });
});
