/**
 * Postinstall script for Wayland
 * Handles native module installation for different environments
 */

const { execSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');

const OBSOLETE_RUNTIME_PACKAGES = ['@monaco-editor/react', '@monaco-editor/loader', 'monaco-editor'];

// Note: web-tree-sitter is now a direct dependency in package.json
// No need for symlinks or copying - npm will install it directly to node_modules

/**
 * Bun does not remove every extraneous package from an existing node_modules
 * tree when a dependency disappears from package.json and bun.lock. That can
 * leave a removed runtime available to packaging after an in-place upgrade.
 *
 * Remove only this fixed, reviewed denylist. Never derive deletion targets
 * from package metadata or user input: each target remains a direct child of
 * the supplied node_modules root, and rmSync removes a symlink itself rather
 * than following it.
 */
function pruneObsoleteRuntimePackages(nodeModulesRoot = path.join(__dirname, '..', 'node_modules')) {
  if (!fs.existsSync(nodeModulesRoot)) return [];

  const removed = [];
  for (const packageName of OBSOLETE_RUNTIME_PACKAGES) {
    const packagePath = path.join(nodeModulesRoot, ...packageName.split('/'));
    try {
      fs.lstatSync(packagePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    fs.rmSync(packagePath, { recursive: true, force: false });
    removed.push(packageName);
  }

  if (removed.length > 0) {
    console.log(`[postinstall] Removed obsolete runtime package(s): ${removed.join(', ')}`);
  }
  return removed;
}

/**
 * Widen declared dep ranges for any package whose version we've pinned
 * via this repo's `resolutions` / `overrides` blocks.
 *
 * Why: our root package.json security-pins several upstream packages
 * (axios, @xmldom/xmldom, body-parser, hono, jws, lodash-es,
 * mdast-util-to-hast, node-forge, tar, tmp, ws) to specific minimum
 * versions that fix CVEs. Bun's flat-hoist install puts the pinned
 * version at the root of node_modules/. Runtime resolution walks up the
 * tree and finds it, so the app works fine. BUT electron-builder's
 * dep-tree traversal collector reads each downstream package's declared
 * range literally - when a downstream declares e.g.
 * `axios: "~1.13.3"` but our override installs 1.16.x, the traversal
 * rejects the build with "production dependency not found ... version=~1.13.3".
 *
 * Fix: walk every nested package.json under node_modules/ and, for any
 * declared dep whose name is in our overrides list, rewrite the range
 * to `*`. This is safe because our root overrides still control which
 * version actually gets installed - the wildcard only relaxes the
 * traversal's literal-range check.
 *
 * Idempotent - only writes when the range actually needs widening.
 *
 * Limitation: this clobbers nested package.json files in node_modules.
 * They'll be restored on the next `bun install`, which is why this is
 * a postinstall script: every install reapplies the patches.
 */
function patchOverriddenDepRanges() {
  const rootPkg = require('../package.json');
  const overrideMap = { ...(rootPkg.resolutions || {}), ...(rootPkg.overrides || {}) };
  const overrideNames = new Set(Object.keys(overrideMap));
  if (overrideNames.size === 0) return;

  const nmRoot = path.join(__dirname, '..', 'node_modules');
  if (!fs.existsSync(nmRoot)) return;

  const pkgPaths = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        // npm scope dir - walk into it
        walk(full);
        continue;
      }
      if (entry.name === 'node_modules') {
        // Nested node_modules - walk into it
        walk(full);
        continue;
      }
      // Regular package dir
      const pkgFile = path.join(full, 'package.json');
      if (fs.existsSync(pkgFile)) {
        pkgPaths.push(pkgFile);
      }
      // Also descend into any nested node_modules this package may have
      const nestedNm = path.join(full, 'node_modules');
      if (fs.existsSync(nestedNm)) {
        walk(nestedNm);
      }
    }
  }
  walk(nmRoot);

  let patched = 0;
  let touched = 0;
  for (const pkgFile of pkgPaths) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch {
      continue;
    }
    let modified = false;
    for (const field of ['dependencies', 'optionalDependencies']) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const depName of Object.keys(deps)) {
        if (overrideNames.has(depName) && deps[depName] !== '*') {
          deps[depName] = '*';
          modified = true;
          touched++;
        }
      }
    }
    if (modified) {
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
      patched++;
    }
  }
  if (patched > 0) {
    console.log(
      `[postinstall] Widened ${touched} declared dep range(s) across ${patched} package.json file(s) to '*' (override-pinned: ${[...overrideNames].join(', ')})`
    );
  }
}

/**
 * Install the WhatsApp bridge subprocess's own node_modules/.
 *
 * The bridge is a standalone ESM Node program (`type: "module"`) at
 * `src/process/channels/whatsapp-bridge/`. It is NOT bundled into the
 * Electron main process - it's forked at runtime via `child_process.fork`
 * and copied verbatim into the packaged app via electron-builder's
 * `extraResources` rule. For its `import` statements to resolve in the
 * packaged build, its own `node_modules/` must be present alongside it.
 *
 * We run `bun install` (or `npm install` if bun is unavailable) inside the
 * bridge dir. Idempotent: skipped silently if the bridge dir is missing.
 * Failures are logged but non-fatal - the rest of the app still installs.
 */
function installBridgeDeps() {
  const bridgeDir = path.join(__dirname, '..', 'src', 'process', 'channels', 'whatsapp-bridge');
  const bridgePkg = path.join(bridgeDir, 'package.json');
  if (!fs.existsSync(bridgePkg)) {
    console.log('[postinstall] whatsapp-bridge package.json not found, skipping bridge deps');
    return;
  }
  // Detect bun; fall back to npm.
  let installer = 'bun install';
  try {
    execSync('bun --version', { stdio: 'ignore' });
  } catch {
    installer = 'npm install --no-audit --no-fund';
  }
  console.log(`[postinstall] Installing whatsapp-bridge deps via \`${installer}\``);
  try {
    execSync(installer, { cwd: bridgeDir, stdio: 'inherit' });
  } catch (e) {
    console.error('[postinstall] whatsapp-bridge dep install failed (non-fatal):', e.message);
  }
}

/**
 * Relative path, inside node_modules/electron/dist, of the binary each platform
 * expects. Used only when electron's own `path.txt` is absent.
 */
const ELECTRON_BINARY_BY_PLATFORM = {
  win32: 'electron.exe',
  darwin: path.join('Electron.app', 'Contents', 'MacOS', 'Electron'),
  linux: 'electron',
};

/**
 * Fail loudly when electron's postinstall produced no runnable binary.
 *
 * electron's installer downloads its platform zip and hands it to
 * `extract-zip` -> `yauzl`. yauzl 2.x's INFLATING read stream stalls partway
 * through the first entry on newer Node runtimes: no error, no rejection, the
 * promise simply never settles, the event loop drains and node exits **0**.
 * The install therefore "succeeds" while leaving a `dist/` holding one partial
 * file and no executable, and the failure only surfaces much later as
 * electron-vite's opaque `Error: Electron uninstall` at `bun run start`.
 *
 * The root cause is pinned in package.json (`yauzl` is overridden to ^3.4.0,
 * which streams correctly). This check is the backstop: it turns any future
 * recurrence - a new Node break, a lost override, a half-extracted cache - into
 * an immediate, named error instead of an hour of misdirected debugging.
 *
 * Honours ELECTRON_SKIP_BINARY_DOWNLOAD for installs that deliberately ship no
 * binary, and WAYLAND_SKIP_ELECTRON_CHECK as a manual escape hatch.
 */
function verifyElectronBinary(electronRoot = path.join(__dirname, '..', 'node_modules', 'electron')) {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || process.env.WAYLAND_SKIP_ELECTRON_CHECK) {
    console.log('[postinstall] Electron binary check skipped (explicitly disabled via env)');
    return true;
  }
  // No electron package at all is not this check's business.
  if (!fs.existsSync(electronRoot)) return true;

  const pathTxt = path.join(electronRoot, 'path.txt');
  const relative = fs.existsSync(pathTxt)
    ? fs.readFileSync(pathTxt, 'utf8').trim()
    : ELECTRON_BINARY_BY_PLATFORM[process.platform];

  // An unknown platform has no expected layout to assert against.
  if (!relative) return true;

  const binary = path.join(electronRoot, 'dist', relative);
  if (fs.existsSync(binary)) return true;

  const distDir = path.join(electronRoot, 'dist');
  const extracted = fs.existsSync(distDir) ? fs.readdirSync(distDir).length : 0;
  console.error(
    [
      '',
      '='.repeat(72),
      '[postinstall] FATAL: Electron installed no runnable binary.',
      '='.repeat(72),
      `  expected: ${binary}`,
      `  dist/ currently holds ${extracted} entr${extracted === 1 ? 'y' : 'ies'}`,
      '',
      "  electron's own postinstall exits 0 even when its zip extraction stalls,",
      '  so this would otherwise surface later as the misleading',
      '  "Error: Electron uninstall" from `bun run start`.',
      '',
      '  Most likely causes:',
      `    - Node ${process.version} is outside this project's supported range`,
      '      (package.json engines). yauzl 2.x cannot inflate on newer runtimes.',
      '    - the `yauzl` override in package.json was dropped or not applied.',
      '',
      '  To retry the download and extraction:',
      '    node node_modules/electron/install.js',
      '',
      '  Set WAYLAND_SKIP_ELECTRON_CHECK=1 to bypass this check deliberately.',
      '='.repeat(72),
      '',
    ].join('\n')
  );
  return false;
}

function runPostInstall() {
  // Bun can retain removed packages during an in-place upgrade. Prune the
  // fixed obsolete-runtime denylist before inspecting or packaging node_modules.
  pruneObsoleteRuntimePackages();
  // Apply nested-dep range widenings before electron-builder install-app-deps.
  patchOverriddenDepRanges();
  // Install the WhatsApp bridge subprocess's own node_modules/. The bridge ships
  // as-is into the packaged app via electron-builder extraResources and forks at
  // runtime - without its own node_modules/ the `import` statements throw.
  installBridgeDeps();
  try {
    // Check if we're in a CI environment
    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    const electronVersion = require('../package.json').devDependencies.electron.replace(/^[~^]/, '');

    console.log(`Environment: CI=${isCI}, Electron=${electronVersion}`);

    if (isCI) {
      // In CI, skip rebuilding to use prebuilt binaries for better compatibility
      console.log('CI environment detected, skipping rebuild to use prebuilt binaries');
      console.log('Native modules will be handled by electron-forge during packaging');
    } else {
      // In local environment, use electron-builder to install dependencies
      console.log('Local environment, installing app deps');
      execSync('bunx electron-builder install-app-deps', {
        stdio: 'inherit',
        env: {
          ...process.env,
          // Prefer prebuilt native modules over source builds (M25/F16). Set true only when prebuilts are unavailable for a target Electron version.
          npm_config_build_from_source: 'false',
        },
      });
    }
  } catch (e) {
    console.error('Postinstall failed:', e.message);
    // Don't exit with error code to avoid breaking installation
  }

  // Last: assert the install actually produced a runnable Electron. Unlike the
  // failures above, this one is not survivable - nothing in the app can start
  // without the binary - so it is the single case where postinstall exits
  // non-zero rather than leaving a broken tree that looks installed.
  return verifyElectronBinary();
}

// Only run if this script is executed directly
if (require.main === module) {
  if (!runPostInstall()) process.exitCode = 1;
}

module.exports = runPostInstall;
module.exports.OBSOLETE_RUNTIME_PACKAGES = OBSOLETE_RUNTIME_PACKAGES;
module.exports.pruneObsoleteRuntimePackages = pruneObsoleteRuntimePackages;
module.exports.verifyElectronBinary = verifyElectronBinary;
module.exports.ELECTRON_BINARY_BY_PLATFORM = ELECTRON_BINARY_BY_PLATFORM;
