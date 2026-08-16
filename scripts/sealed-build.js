/**
 * Refresh the capability acceptance receipts and run a packaged build with them.
 *
 * Why this exists: `dist:*` refuses to package without
 * WAYLAND_CAPABILITY_RECEIPTS_DIR, the receipts bind to the exact commit AND
 * tree, and the generator writes exclusively so it will not overwrite a stale
 * directory. Done by hand that is three commands in a fixed order, and getting
 * any of them wrong produces an error that names a symptom rather than the fix:
 *
 *   "Capability acceptance output directory already exists."   -> you did not clear it
 *   "...manifest belongs to a stale or foreign candidate."     -> you committed since generating
 *   "WAYLAND_CAPABILITY_RECEIPTS_DIR is required..."           -> new shell, variable never set
 *
 * The variable is the part a shell cannot solve: exporting it in one terminal
 * does nothing for the next one. So this script sets it on the CHILD process,
 * which makes a packaged build a single command from a cold shell.
 *
 * Usage:
 *   node scripts/sealed-build.js dist:win     # refresh, then run that script
 *   node scripts/sealed-build.js --refresh-only
 *   node scripts/sealed-build.js dist:win --out D:\somewhere
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Build scripts this wrapper may invoke. An allowlist, not a passthrough: the
 * value reaches a child process launcher, and there is no reason to accept an
 * arbitrary command here.
 */
const BUILD_TARGETS = new Set(['dist', 'dist:win', 'dist:mac', 'dist:linux', 'package', 'make']);

/** Receipts must live OUTSIDE the repo: the seal rejects any untracked file. */
const DEFAULT_OUT = path.join(os.tmpdir(), 'wayland-capability-acceptance');

function parseArgs(argv) {
  const outFlag = argv.indexOf('--out');
  const out = outFlag === -1 ? DEFAULT_OUT : argv[outFlag + 1];
  if (outFlag !== -1 && !out) throw new Error('--out requires a directory');

  const positional = argv.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    return !(outFlag !== -1 && index === outFlag + 1);
  });

  const refreshOnly = argv.includes('--refresh-only');
  const target = positional[0];

  if (!refreshOnly && !target) {
    throw new Error(`Specify a build target (${[...BUILD_TARGETS].join(', ')}) or --refresh-only`);
  }
  if (target && !BUILD_TARGETS.has(target)) {
    throw new Error(`Unknown build target "${target}". Allowed: ${[...BUILD_TARGETS].join(', ')}`);
  }
  return { target: refreshOnly ? null : target, out: path.resolve(out) };
}

/**
 * The seal binds a clean tree, so a dirty one fails deep inside the generator
 * with "capability evidence cannot bind mutable source". Say it up front, and
 * name the files, so the fix is obvious.
 */
function assertCleanTree() {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  if (!status) return;
  throw new Error(
    `Working tree is dirty; capability evidence cannot bind mutable source.\nCommit, stash or ignore these first:\n${status}`
  );
}

function refreshReceipts(out) {
  // The generator writes exclusively and will not overwrite, so clearing is not
  // optional - it is the whole reason a second run fails.
  fs.rmSync(out, { recursive: true, force: true });
  execFileSync('node', [path.join('scripts', 'capability-seal', 'generateCapabilityAcceptanceReceipts.js'), '--out', out], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  return manifest.candidate;
}

function main() {
  const { target, out } = parseArgs(process.argv.slice(2));

  assertCleanTree();
  const candidate = refreshReceipts(out);
  console.log(`[sealed-build] receipts bound to ${candidate.commit.slice(0, 9)} (tree ${candidate.tree.slice(0, 9)})`);
  console.log(`[sealed-build] ${out}`);

  if (!target) {
    console.log('[sealed-build] refresh only; export WAYLAND_CAPABILITY_RECEIPTS_DIR to use these.');
    return 0;
  }

  console.log(`[sealed-build] running ${target}`);
  const result = spawnSync('bun', ['run', target], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, WAYLAND_CAPABILITY_RECEIPTS_DIR: out },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[sealed-build] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
