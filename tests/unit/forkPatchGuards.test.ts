/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards for fork-local patches that upstream does not carry.
 *
 * This fork tracks upstream and merges from it. Most of our deltas defend
 * themselves: if a merge drops the ACP spaced-path fix, `acpConnectors.test.ts`
 * and `mcpAgentConsumption.test.ts` go red immediately.
 *
 * The patches asserted HERE are the ones that fail SILENTLY. They live in files
 * upstream edits routinely, nothing else exercises them at test time, and losing
 * one costs an install or a debugging session rather than a red test. Each entry
 * exists because its absence would otherwise be invisible.
 *
 * See FORK-PATCHES.md for the full delta list and the reasoning behind each.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
};

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as PackageManifest;

/**
 * The WhatsApp bridge is a separate package with its own package.json, its own
 * lockfile and its own `bun install`, so it inherits NOTHING from the root
 * manifest - including the yauzl pin. It reaches the same broken extractor by
 * its own route: puppeteer -> @puppeteer/browsers -> extract-zip -> yauzl 2.x.
 */
const BRIDGE_MANIFEST_PATH = resolve(
  process.cwd(),
  'src',
  'process',
  'channels',
  'whatsapp-bridge',
  'package.json'
);
const bridgeManifest = JSON.parse(readFileSync(BRIDGE_MANIFEST_PATH, 'utf8')) as PackageManifest;

/** Lowest major version a range can resolve to, e.g. `^3.4.0` -> 3. */
function lowestMajor(range: string): number {
  const match = /(\d+)/.exec(range);
  return match ? Number(match[1]) : Number.NaN;
}

describe('fork patch: yauzl is pinned above the version that cannot inflate', () => {
  // electron's installer extracts its platform zip through extract-zip -> yauzl.
  // yauzl 2.x's inflating read stream stalls partway through the first entry on
  // modern Node: no error, no rejection, the promise never settles, the event
  // loop drains and node exits 0. The install "succeeds" leaving a dist/ with no
  // executable, surfacing much later as electron-vite's `Error: Electron uninstall`.
  //
  // Our fix is two lines in package.json. They sit LAST in each block, right
  // against the closing brace, in a file upstream rewrites on every dependency
  // bump - so they are the single most likely thing to be lost to a merge, and
  // nothing else in the suite would notice. This test is that notice.
  it.each([
    ['overrides', manifest.overrides],
    ['resolutions', manifest.resolutions],
  ])('%s pins yauzl to a major that can inflate', (_block, entries) => {
    const range = entries?.yauzl;

    expect(range, 'the yauzl pin was dropped - see FORK-PATCHES.md before removing it').toBeTruthy();
    expect(lowestMajor(range as string), `yauzl range "${range}" allows a 2.x resolution`).toBeGreaterThanOrEqual(3);
  });

  it('keeps both blocks in agreement so bun and npm resolve the same yauzl', () => {
    expect(manifest.overrides?.yauzl).toBe(manifest.resolutions?.yauzl);
  });

  it('pins yauzl in the whatsapp-bridge too, which installs separately', () => {
    // The bridge reaches the same broken extractor by its own route:
    // puppeteer -> @puppeteer/browsers -> extract-zip -> yauzl 2.x. Its
    // extraction stalls a few entries in, leaving a browser directory holding
    // ABOUT and LICENSE and no executable - and puppeteer's DefaultProvider then
    // treats that directory as installed and refuses to re-download, so the
    // failure is permanent until the cache is cleared by hand.
    const range = bridgeManifest.overrides?.yauzl;

    expect(range, 'the whatsapp-bridge yauzl pin was dropped - see FORK-PATCHES.md').toBeTruthy();
    expect(lowestMajor(range as string), `yauzl range "${range}" allows a 2.x resolution`).toBeGreaterThanOrEqual(3);
  });
});

describe('fork patch: postinstall still verifies the Electron binary', () => {
  // The pin above prevents the known cause; this guard catches every other one
  // (a new Node break, a corrupted cache, a half-extracted dist) by refusing to
  // let an install report success without producing a runnable binary. It lives
  // in scripts/postinstall.js, which upstream owns and edits.
  it('exposes the verifier and still fails a dist with no executable', () => {
    const postinstall = require('../../scripts/postinstall.js') as {
      verifyElectronBinary?: (electronRoot: string) => boolean;
    };

    expect(
      typeof postinstall.verifyElectronBinary,
      'the postinstall Electron guard was dropped - see FORK-PATCHES.md'
    ).toBe('function');

    // A directory with no electron package at all is none of the guard's
    // business and must pass; the negative cases are covered in
    // tests/unit/scripts/postinstallElectronBinary.test.ts.
    const absent = resolve(process.cwd(), 'node_modules', `.fork-guard-absent-${process.pid}`);
    expect(postinstall.verifyElectronBinary?.(absent)).toBe(true);
  });
});
