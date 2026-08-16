# Fork patches

Deltas this fork carries on top of `upstream/main` (`FerroxLabs/wayland`).

This file exists for one reason: when a `git merge upstream/main` throws a conflict, this
tells you what is load-bearing and must survive the resolution. **Resolving a conflict by
taking upstream's side silently reverts the fix.**

Remotes:

```
origin    https://github.com/ganji-development/wayland   (this fork)
upstream  https://github.com/FerroxLabs/wayland
```

## After every upstream merge

```bash
bun run test        # test:vitest && test:bun - the guards below are part of this
bun install         # regenerates bun.lock; also re-downloads Electron on a version bump
```

`tests/unit/forkPatchGuards.test.ts` asserts the patches that would otherwise fail
**silently**. If it goes red after a merge, a fix was dropped — do not "fix" the test.

---

## 1. yauzl pinned to `^3.4.0` — the one that fails silently

**Files:** `package.json` (`overrides` **and** `resolutions`)
**Commit:** `c5217add` · **Guard:** `forkPatchGuards.test.ts`

Electron's installer extracts its platform zip via `extract-zip` → `yauzl`. yauzl 2.x's
*inflating* read stream stalls partway through the first entry on modern Node: no error, no
rejection, the promise never settles, the event loop drains, and node exits **0**. The install
reports success while leaving `node_modules/electron/dist/` holding one partial file and no
executable. It surfaces much later as electron-vite's opaque `Error: Electron uninstall`.

Measured on `electron-v41.6.0-win32-x64.zip` under Node 26:

| path | result |
|---|---|
| yauzl raw read (no inflate) | all 206,006 bytes, ends cleanly |
| `zlib.inflateRawSync` on those bytes | all 668,362 bytes |
| yauzl **inflating** stream | 633,056 bytes, `end` never fires |
| yauzl 3.4.0, same zip | all 75 entries, 1.4s |

**Highest merge risk of anything here.** Upstream rewrites `package.json` on every dependency
bump, and both our lines sit *last* in their blocks against the closing brace, so any new entry
sorting after `ws` collides. **Nothing but the guard test detects the loss** — the suite stays
fully green and you find out on some future Electron bump.

`bun.lock` conflicts are noise; it is derived. Take either side and re-run `bun install`.

## 2. Electron binary verification in postinstall

**Files:** `scripts/postinstall.js` (`verifyElectronBinary`, `ELECTRON_BINARY_BY_PLATFORM`)
**Commit:** `c5217add` · **Guard:** `forkPatchGuards.test.ts`, `tests/unit/scripts/postinstallElectronBinary.test.ts`

Backstop for patch 1. Refuses to let an install report success without producing a runnable
binary, and is the only place in the codebase that exits non-zero on a postinstall failure —
nothing else works without Electron. Turns any future recurrence into a named error instead of
an hour of misdirected debugging. Honours `ELECTRON_SKIP_BINARY_DOWNLOAD` and
`WAYLAND_SKIP_ELECTRON_CHECK`.

Low conflict risk — a discrete block appended to the file — but upstream owns the file.

## 3. Unquoted executable paths containing spaces (ACP)

**Files:** `src/process/agent/acp/acpConnectors.ts`, `src/process/agent/acp/AcpConnection.ts`
**Commit:** `8eddced6` · **Guard:** `tests/unit/acpConnectors.test.ts` (6 cases), `tests/integration/mcpAgentConsumption.test.ts`

`parseWindowsCliPath` split an unquoted `cliPath` on the first whitespace, so
`C:\Program Files\nodejs\node.exe` became command `C:\Program` plus a stray arg. The spawn
failed ENOENT and `AcpConnection` relabelled it as a missing backend CLI — sending users to
install a CLI already on their machine. The default install location of almost everything on
Windows contains a space.

Now resolved the way Windows `CreateProcess` resolves a bare command line: probe the longest
leading prefix that exists on disk, then shorten. Gated on `path.isAbsolute`, so `goose acp` and
`node path/to/file.js` keep their command+args split at no filesystem cost.

**High merge risk** — upstream actively develops ACP. But it defends itself: dropping it turns
the tests above red immediately.

Two details a conflict resolution must not lose:

- The `'<backend>' CLI not found` **prefix** in the ENOENT message is load-bearing.
  `classifyReconnectError` and `buildStartupErrorMessage` both pattern-match on it, and
  `acpStartupError.test.ts` / `acpReconnectErrorClassify.test.ts` assert it.
- `tests/unit/acpConnectors.test.ts` mocks `fs` and needs the `statSync` entry, or the probe
  silently degrades to the old split. `readdirSync` is left undefined **on purpose** — the bunx
  cleanup helper relies on it throwing.

## 4. Windows test-harness fixes

**Files:** `tests/unit/scripts/prepareReleaseAssets.test.ts`, `tests/unit/process/services/recovery/recoveryCapture.test.ts`
**Commit:** `b6f31628`

Neither was a product defect; both were the harness assuming a POSIX box.

- `spawnSync('bash', …)` — a stock Windows PowerShell session has no `bash` on PATH even with
  Git for Windows installed, so it failed ENOENT and returned `status: null`, surfacing as
  `expected null to be 0`. Now probes PATH, then the Git for Windows locations.
- `recoveryCapture` budgeted 30s for a test whose *setup* writes 20,001 files: ~12s on NTFS
  where antivirus scans every create, vs ~1s on ext4/APFS. Raised to 60s.

Low merge risk.

---

## Repo state, not a commit

### Pinned producer commit for the historical-transaction corpus

`contracts/recovery/historical-transactions/manifest.json` pins producer commit
`991c502e74506ec3702f92e429a8b31b655412ba`, which is **not reachable from `main`**. Without it,
`verifyHistoricalTransactionCorpus` fails. Retrieved and pinned so `git gc` cannot prune it:

```bash
git fetch upstream 991c502e74506ec3702f92e429a8b31b655412ba
git update-ref refs/recovery/historical-corpus-producer 991c502e74506ec3702f92e429a8b31b655412ba
```

Survives merges (it is a ref, not a file). **Does not survive a re-clone**, and is not pushed —
re-run both commands after cloning fresh.

---

## Known-unfixed upstream defect

**`scripts/recovery/verifyHistoricalTransactionCorpus.mjs` verifies fail-open.**
`gitBlobSha256` returns `null` on any failure and the caller guards `if (derived && …)`, so when
git cannot produce the blob the check is silently skipped. That is why
`re-derives the exact producer source blob through git` passed for us while verifying *nothing*,
and why its negative sibling failed instead.

With the ref above in place it now verifies for real. Left fail-open deliberately: making it
fail closed is the correct fix, but it would break any clone that has not fetched that commit.
Revisit if this fork is ever cloned fresh or built in CI.
