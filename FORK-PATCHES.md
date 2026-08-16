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

The whatsapp-bridge installs **separately** and inherits nothing from the root manifest
(see patch 5). Watch `bun install` output for `whatsapp-bridge dep install failed (non-fatal)` —
it does not fail the build, it just leaves WhatsApp broken at runtime.

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

## 5. yauzl pinned in the whatsapp-bridge — patch 1's second front

**Files:** `src/process/channels/whatsapp-bridge/package.json` (`overrides`), and its `bun.lock`
**Guard:** `forkPatchGuards.test.ts`

Same root cause as patch 1, reached by a different route, in a package that inherits **nothing**
from the root manifest. The bridge has its own `package.json`, its own lockfile and its own
`bun install` (driven by `installBridgeDeps` in `scripts/postinstall.js`), so the root's yauzl pin
never applied to it:

```
puppeteer 24.38.0 -> @puppeteer/browsers 2.13.0 -> extract-zip ^2.0.1 -> yauzl 2.10.0
```

Symptom, observed on two independent Windows machines with different browsers
(`chrome` on one, `chrome-headless-shell` on the other):

```
The browser folder (…\chrome\win64-146.0.7680.31) exists but the
executable (…\chrome-win64\chrome.exe) is missing
```

The directory holds `ABOUT` and `LICENSE.headless_shell` and nothing else — extraction stalled a
couple of entries in, exactly as Electron's did.

**This failure is self-perpetuating.** Puppeteer's `DefaultProvider` treats an existing browser
directory as installed and refuses to re-download, so once a partial extraction lands, every
retry fails identically. **Pinning yauzl is not enough on a machine that already failed** — the
poisoned cache must be cleared by hand:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\puppeteer\chrome\win64-<version>"
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\puppeteer\chrome-headless-shell\win64-<version>"
cd src\process\channels\whatsapp-bridge; bun install
```

The bridge's `bun.lock` pins the resolved yauzl, so it must be regenerated for the override to
take effect — a stale lockfile silently overrides the override.

Note this failure is **non-fatal** to `bun install`: `installBridgeDeps` catches it and logs
`whatsapp-bridge dep install failed (non-fatal)`. The root install completes and the app builds;
WhatsApp is simply broken at runtime. Easy to scroll past.

### Two files move with this patch

Changing anything under the bridge invalidates **`scripts/whatsapp-bridge-source.json`**, which
pins every bridge file by size and SHA-256 and is enforced by `verify-packaged-resources.js` at
package time. A stale authority fails **every packaged build**, and no unit test outside
`whatsappBridgeSourcePin.test.ts` notices. There is no generator — recompute by hand:

```powershell
node -e "const{createHash}=require('crypto'),fs=require('fs'),p=require('path');const r='src/process/channels/whatsapp-bridge';for(const f of ['package.json','bun.lock']){const b=fs.readFileSync(p.join(r,f));console.log(f,b.length,createHash('sha256').update(b).digest('hex'));}"
```

Both `package.json` **and** `bun.lock` entries move: the pin covers the lockfile, and the
lockfile is regenerated by the install that applies the override.

This is also why `src/process/channels/whatsapp-bridge/` is listed in `.prettierignore` and
excluded in `.pre-commit-config.yaml` — a formatter pass over the bridge silently breaks
packaging. Do not run a formatter over it.

Rejected alternative: `PUPPETEER_SKIP_DOWNLOAD` plus the system Chrome. The bridge passes only
`{ headless, args }` to `whatsapp-web.js` and sets no `executablePath`, so that moves the failure
from install time to runtime, and `whatsapp-web.js` is sensitive to Chrome version — a
system Chrome auto-updates out from under it, while puppeteer's pinned build does not.

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
