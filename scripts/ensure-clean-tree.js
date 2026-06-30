#!/usr/bin/env node
/**
 * Pre-build guard. Refuses to build (and therefore refuses to deploy
 * via capgo:push, ios:sync, or vercel) when the git working tree has
 * uncommitted changes.
 *
 * Why: we got bitten by "Vercel CLI + capgo:push without commits"
 * causing weeks of work to live only on a laptop until someone
 * remembered to git add. This script fails the build loudly so the
 * deploy can't ship code that isn't on origin.
 *
 * Escape hatch: `npm run build:dirty` bypasses the guard for the rare
 * case you genuinely need a dirty build (e.g. WIP debugging on
 * device).
 */
const { execSync } = require('child_process');

function safe(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// Only inside a git repo — skip cleanly if checked out without git
// (rare, e.g. a tarball deploy).
const insideRepo = safe('git rev-parse --is-inside-work-tree');
if (insideRepo !== 'true') process.exit(0);

const status = safe('git status --porcelain');
if (!status) process.exit(0);

const lines = status.split('\n').filter(Boolean);
console.error('');
console.error('  Build blocked: uncommitted changes in the working tree.');
console.error('');
console.error('  Files:');
for (const line of lines.slice(0, 20)) console.error('    ' + line);
if (lines.length > 20) console.error('    ... and ' + (lines.length - 20) + ' more');
console.error('');
console.error('  Commit + push first so the deploy matches origin:');
console.error('    git add -A && git commit -m "..." && git push origin main');
console.error('');
console.error('  Or, if you know what you are doing:');
console.error('    npm run build:dirty   (skips this guard)');
console.error('');
process.exit(1);
