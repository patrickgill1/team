#!/usr/bin/env node
// Sentry sourcemap upload — post-build step.
//
// Called from the "build" npm script after react-scripts finishes.
// Uploads sourcemaps + release artifacts to Sentry so future events
// symbolicate to real src/ file paths instead of chunk.js:1:1.
//
// Deliberately ALWAYS exits 0. Sourcemap upload is a nice-to-have
// observability workflow; it must not gate the app shipping. The
// build's real deliverable is /build; if that's on disk, we ship.
//
// Vercel prod fix 2026-07-12: the prior shell-based approach with
// `(cmd || echo)` wrapping didn't reliably short-circuit on Vercel.
// Some combination of npm's script runner + Vercel's shell + sentry-
// cli's exit semantics propagated a non-zero exit up through the
// wrapper. Node script gives us bulletproof error swallow.

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const {
  SENTRY_AUTH_TOKEN,
  SENTRY_ORG,
  SENTRY_PROJECT,
} = process.env;

const requiredVars = { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT };
const missing = Object.entries(requiredVars)
  .filter(([, v]) => !v || !String(v).trim())
  .map(([k]) => k);

if (missing.length > 0) {
  console.log(
    `Skipping Sentry sourcemap upload — missing env var(s): ${missing.join(', ')}. ` +
    'Set them in Vercel Project Settings → Environment Variables to enable.'
  );
  process.exit(0);
}

// Resolve the app version. We prefer REACT_APP_VERSION (already
// stamped into the client bundle by the react-scripts build), then
// npm_package_version (set by npm when running scripts), then the
// package.json fallback.
let version = process.env.REACT_APP_VERSION || process.env.npm_package_version || 'unknown';
if (version === 'unknown') {
  try {
    version = require(path.join('..', 'package.json')).version || 'unknown';
  } catch { /* keep 'unknown' */ }
}

console.log(`Sentry sourcemaps: uploading release ${version} to org=${SENTRY_ORG} project=${SENTRY_PROJECT}`);

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', env: process.env });
}

try {
  run('npx --yes @sentry/cli@latest sourcemaps inject ./build');
  run(`npx --yes @sentry/cli@latest sourcemaps upload --release="${version}" ./build`);
  console.log(`Sentry sourcemap upload complete for release ${version}.`);
} catch (err) {
  // Log the failure loudly but do NOT propagate — the app bundle is
  // already built and needs to ship. Symbolication for this release
  // just falls back to the minified frames.
  console.log('---');
  console.log(`Sentry sourcemap upload FAILED (non-fatal): ${err && err.message ? err.message : err}`);
  console.log('Build will continue. Fix the auth token / org / project slug in Vercel and re-deploy to re-enable.');
  console.log('---');
}

process.exit(0);
