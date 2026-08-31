#!/usr/bin/env bash
#
# Spin up the Firestore emulator, run the rules test suite against
# it, tear down cleanly whether or not the tests pass.
#
# Requires: firebase-tools (already a devDep), @firebase/rules-unit-testing,
# and ts-jest (installed by test:rules setup).

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# firebase emulators:exec runs a command with the emulator up, then
# tears down. Uses the port set in firebase.json (8080).
npx firebase emulators:exec \
  --only firestore \
  --project gk-rules-test \
  "npx jest --config tests/rules/jest.config.js"
