#!/usr/bin/env node
/**
 * Post-push verification for `npm run capgo:push`.
 *
 * The Capgo CLI has historically exited 0 on "bundle upload" even
 * when the upload silently failed (auth quirks, phantom version
 * records, deprecated CLI versions). We were on 3.9.440 for 6 days
 * while pushes 441-446 all claimed success but never reached the
 * production channel. This script closes the loop: query Capgo's
 * production channel for the current bundle and compare to the
 * version we just tried to push. Exit non-zero on mismatch so the
 * failure surfaces instead of masquerading as success.
 */

const { readFileSync } = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

const APP_ID = 'com.firefc.team';

function log(msg) { process.stdout.write(msg + '\n'); }
function err(msg) { process.stderr.write(msg + '\n'); }

function expectedVersion() {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return String(pkg.version || '').trim();
}

function liveProductionVersion() {
  // `capgo channel currentBundle production <appId>` prints a line
  // like: "●  Current bundle for channel production is 3.9.447"
  const raw = execFileSync(
    'npx',
    ['@capgo/cli', 'channel', 'currentBundle', 'production', APP_ID],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const match = raw.match(/Current bundle for channel production is\s+([0-9]+\.[0-9]+\.[0-9]+)/);
  if (!match) throw new Error(`Could not parse Capgo channel output:\n${raw}`);
  return match[1];
}

try {
  const want = expectedVersion();
  if (!want) {
    err('  verify-capgo-push: package.json version is empty');
    process.exit(1);
  }
  const live = liveProductionVersion();
  if (live === want) {
    log(`  verify-capgo-push: production channel confirmed at ${live}. ✓`);
    process.exit(0);
  }
  err('');
  err(`  ✗ verify-capgo-push: production channel is on ${live}, expected ${want}`);
  err('    The bundle upload appeared to succeed but the production channel');
  err('    did not advance. This is the same silent failure we hit for six');
  err('    days pre-8.45.1. Investigate before assuming users will get the fix.');
  err('    Quick checks:');
  err('      npx @capgo/cli bundle list ' + APP_ID);
  err('      npx @capgo/cli channel list ' + APP_ID);
  err('      cat ~/.capgo   (API key still valid?)');
  process.exit(1);
} catch (e) {
  err('  verify-capgo-push: verification failed');
  err('    ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
