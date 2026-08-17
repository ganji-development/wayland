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
const cache = new Map<string, string | null>();

/**
 * A file that exists at the repo root, used to prove a candidate can actually
 * SEE the working directory it was handed.
 */
const SENTINEL = 'package.json';

/**
 * "A bash exists" is the wrong question; "can this bash see our cwd" is the
 * right one.
 *
 * WSL ships `C:\Windows\System32\bash.exe`, which lands on PATH the moment the
 * optional feature is enabled. It answers `bash -c 'exit 0'` with a cheerful 0,
 * then ignores the Windows `cwd` completely and starts in `/root` - so every
 * relative script path exits 127 with "No such file or directory". That looked
 * like the release scripts had vanished, on a machine where they were present
 * and executable.
 */
function canSeeWorkingDirectory(candidate: string, cwd: string): boolean {
  const probe = spawnSync(candidate, ['-c', `test -f ${SENTINEL}`], { cwd });
  return !probe.error && probe.status === 0;
}

export function resolveBash(cwd: string = process.cwd()): string | null {
  const hit = cache.get(cwd);
  if (hit !== undefined) return hit;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    // Git for Windows FIRST. It honours a Windows cwd; a PATH `bash` on Windows
    // is as likely to be WSL, which does not. On POSIX, PATH is the only entry.
    for (const root of [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files']) {
      if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
    }
  }
  candidates.push('bash');

  for (const candidate of candidates) {
    if (canSeeWorkingDirectory(candidate, cwd)) {
      cache.set(cwd, candidate);
      return candidate;
    }
  }
  cache.set(cwd, null);
  return null;
}

/**
 * `resolveBash()` or a thrown explanation. Use at the call site so a missing
 * interpreter reports itself instead of masquerading as a script failure.
 */
export function requireBash(cwd: string = process.cwd()): string {
  const bash = resolveBash(cwd);
  if (!bash) {
    throw new Error(
      `No bash able to see ${cwd} was found. Install Git for Windows, or put a bash on PATH that ` +
        `honours a Windows working directory (WSL's bash does not - it starts in /root).`
    );
  }
  return bash;
}
