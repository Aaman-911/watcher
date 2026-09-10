#!/usr/bin/env bash
# WATCHER Shield — extension check.
#
# Runs test/extension, and asserts the four promises the extension makes:
# one source of truth for the detector, no network, no permissions beyond what
# is claimed, and no page-derived string ever rendered as markup.

set -u
cd "$(dirname "$0")/.." || exit 1

if ! node --test 'test/extension/**/*.test.mjs' > /tmp/watcher-ext-test.log 2>&1; then
  echo "extension test suite FAILED:"
  tail -30 /tmp/watcher-ext-test.log
  exit 1
fi

pass=$(grep -E '^# pass ' /tmp/watcher-ext-test.log | awk '{print $3}')
fail=$(grep -E '^# fail ' /tmp/watcher-ext-test.log | awk '{print $3}')
echo "extension: ${pass} passed, ${fail} failed"
[ "${fail:-1}" = "0" ] || exit 1
case "$pass" in ''|*[!0-9]*) echo "extension FAILED: no pass count"; exit 1;; esac
[ "$pass" -eq 0 ] && { echo "extension FAILED: 0 tests ran"; exit 1; }

# 1. ONE SOURCE OF TRUTH.
# The extension loads detect.mjs by dynamic import rather than through a
# bundler, which keeps the project's no-build-step rule. The cost of that is a
# copy, and a copy drifts. This is what stops it: refresh with
#   cp src/core/detect.mjs extension/core/detect.mjs
if ! diff -q src/core/detect.mjs extension/core/detect.mjs > /dev/null 2>&1; then
  echo "extension FAILED: extension/core/detect.mjs has drifted from src/core/detect.mjs"
  echo "  fix with: cp src/core/detect.mjs extension/core/detect.mjs"
  diff src/core/detect.mjs extension/core/detect.mjs | head -20
  exit 1
fi
echo "extension: detect.mjs is byte-identical to src/core/detect.mjs"

# 2. NO NETWORK.
# The extension reads pages and reports to its own service worker. It must
# never send anything anywhere. Comments are stripped first so the files can
# still say so in prose.
net=$(for f in extension/*.js extension/core/*.mjs; do
        sed -e 's;//.*;;' "$f" | grep -nE '\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(' \
          | sed "s|^|$f:|"
      done)
if [ -n "$net" ]; then
  echo "extension FAILED: something in the extension can talk to a network:"
  echo "$net"
  exit 1
fi
echo "extension: no network call anywhere in the extension"

# 3. NO MARKUP FROM PAGE TEXT.
# Every string the popup renders came from a web page. An extension that
# builds HTML out of attacker-controlled text has handed the page a foothold
# inside the extension, which is worse than the problem it warns about.
markup=$(for f in extension/*.js; do
           sed -e 's;//.*;;' "$f" | grep -nE '\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write' \
             | sed "s|^|$f:|"
         done)
if [ -n "$markup" ]; then
  echo "extension FAILED: page-derived text could be rendered as markup:"
  echo "$markup"
  exit 1
fi
echo "extension: nothing renders page text as markup"

# 4. PERMISSIONS ARE WHAT WE SAY THEY ARE.
node -e '
const m = require("./extension/manifest.json");
const allowed = new Set(["storage"]);
const asked = m.permissions || [];
const extra = asked.filter(p => !allowed.has(p));
if (extra.length) {
  console.error("extension FAILED: unexpected permissions: " + extra.join(", "));
  process.exit(1);
}
if (m.manifest_version !== 3) { console.error("extension FAILED: not Manifest V3"); process.exit(1); }
if (!m.content_scripts || !m.content_scripts.length) { console.error("extension FAILED: no content script"); process.exit(1); }
// A scanner that only ran when you clicked it would miss the page you were
// already reading, so <all_urls> is deliberate — but it must stay declared
// and visible, never quietly widened to include other schemes.
const hosts = m.host_permissions || [];
if (JSON.stringify(hosts) !== JSON.stringify(["<all_urls>"])) {
  console.error("extension FAILED: host_permissions changed: " + JSON.stringify(hosts));
  process.exit(1);
}
console.log("extension: Manifest V3, permissions are [storage] + <all_urls>, nothing more");
' || exit 1

exit 0
