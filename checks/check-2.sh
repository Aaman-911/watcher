#!/usr/bin/env bash
# WATCHER — S2 corpus check

set -u
cd "$(dirname "$0")/.." || exit 1

fail() { echo "$1"; exit 1; }

for p in p1-white-text.html p2-aria-label.html p4-fake-system.html clean-1.html clean-2.html clean-3.html manifest.json reveal.js index.html; do
  [ -f "corpus/$p" ] || fail "Missing corpus/$p"
done

[ -f "server.mjs" ] || fail "Missing server.mjs"

exit 0
