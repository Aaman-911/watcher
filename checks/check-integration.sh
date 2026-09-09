#!/usr/bin/env bash
# WATCHER — integration over real HTTP with a real browser.
#
# The test starts and stops its own throwaway server on an ephemeral port.
# server.mjs and demo/0-start-server.command are NOT touched: that server runs
# forever by design and belongs in its own Terminal window.
#
# The model is scripted here, so this suite costs nothing and is deterministic.
# Model behaviour is measured by report/score.mjs, which is not a test.

set -u
cd "$(dirname "$0")/.." || exit 1

if ! node --test 'test/integration/**/*.test.mjs' > /tmp/watcher-int-test.log 2>&1; then
  echo "integration FAILED:"
  tail -40 /tmp/watcher-int-test.log
  exit 1
fi

pass=$(grep -E '^# pass ' /tmp/watcher-int-test.log | awk '{print $3}')
fail=$(grep -E '^# fail ' /tmp/watcher-int-test.log | awk '{print $3}')
skip=$(grep -E '^# skipped ' /tmp/watcher-int-test.log | awk '{print $3}')
echo "integration: ${pass} passed, ${fail} failed, ${skip} skipped"
[ "${fail:-1}" = "0" ] || exit 1
case "$pass" in ''|*[!0-9]*) echo "integration FAILED: no pass count"; exit 1;; esac

# Skipping is legitimate where webcmd is absent (CI), but say so out loud
# rather than letting an all-skipped run read as a pass.
if [ "${skip:-0}" -gt 0 ] && [ "$pass" -le 1 ]; then
  echo "integration: webcmd is not on this PATH, so the browser tests were skipped."
  echo "             This is not proof the integration works. Run it where webcmd is installed."
fi

# No test may start the long-running demo server.
if grep -rnE "server\.mjs|0-start-server" test/integration/ | grep -v '^\s*//' | grep -vE '//.*(NOT|never|not touched)'; then
  echo "integration FAILED: a test references the long-running demo server"
  exit 1
fi
echo "integration: no test starts the long-running demo server"

exit 0
