#!/usr/bin/env node
// Post-build sourcemap stripper.
//
// react-scripts emits foo.js + foo.js.map alongside each chunk. Sentry
// uploads the .maps for symbolication, but nothing else in production
// needs them — they only inflate the Capgo OTA payload and Vercel
// deploy size. This script deletes every .map file in ./build and
// removes the trailing //# sourceMappingURL= comment from the .js/.css
// files so browsers don't 404 chasing a nonexistent map.
//
// Runs unconditionally after sentry-sourcemaps.js — safe to run even
// when Sentry upload was skipped (missing env vars) because the maps
// aren't needed for the shipped app either way.

'use strict';

const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');

if (!fs.existsSync(buildDir)) {
  console.log('strip-sourcemaps: no build/ dir, nothing to strip.');
  process.exit(0);
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

let mapCount = 0;
let mapBytes = 0;
let stripCount = 0;

for (const f of walk(buildDir)) {
  if (f.endsWith('.map')) {
    mapBytes += fs.statSync(f).size;
    fs.unlinkSync(f);
    mapCount++;
    continue;
  }
  if (f.endsWith('.js') || f.endsWith('.css')) {
    const content = fs.readFileSync(f, 'utf8');
    const stripped = content
      .replace(/\r?\n?\s*\/\/# sourceMappingURL=[^\s]+\s*$/g, '')
      .replace(/\r?\n?\s*\/\*# sourceMappingURL=[^*]+\*\/\s*$/g, '');
    if (stripped !== content) {
      fs.writeFileSync(f, stripped);
      stripCount++;
    }
  }
}

const mb = (mapBytes / 1024 / 1024).toFixed(1);
console.log(`strip-sourcemaps: removed ${mapCount} .map files (${mb} MB), stripped sourceMappingURL from ${stripCount} JS/CSS files.`);
