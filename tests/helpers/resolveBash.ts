/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Locate a usable `bash` for tests that drive the shell release scripts.
 *
 * A stock Windows PowerShell session has no `bash` on PATH even when Git for
 * Windows is installed. `spawnSync('bash', …)` then fails ENOENT and returns
 * `status: null`, which surfaces as `expected null to be 0` - a missing
 * interpreter wearing the costume of a failing script, and the reason a whole
 * release-assets suite reads as broken on Windows when nothing is wrong with it.
 *
 * Probe PATH first so a real bash always wins, then the Git for Windows install
 * locations. Cached: the probe spawns a process, and these suites call it once
 * per script invocation.
 *
 * Shared because upstream keeps adding suites that shell out this way; keeping
 * one resolver means the next one is a two-line change. See FORK-PATCHES.md.
 */
let cached: string | null | undefined;

export function resolveBash(): string | null {
  if (cached !== undefined) return cached;

  const candidates = ['bash'];
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files']) {
      if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
    }
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'exit 0']);
    if (!probe.error && probe.status === 0) {
      cached = candidate;
      return cached;
    }
  }
  cached = null;
  return cached;
}

/**
 * `resolveBash()` or a thrown explanation. Use at the call site so a missing
 * interpreter reports itself instead of masquerading as a script failure.
 */
export function requireBash(): string {
  const bash = resolveBash();
  if (!bash) throw new Error('No usable `bash` found; install Git for Windows or put bash on PATH.');
  return bash;
}
