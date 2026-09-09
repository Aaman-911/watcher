#!/usr/bin/env bash
# WATCHER — the conformance suite, run against our own core.
#
# If WATCHER cannot pass the suite it publishes for third parties, the suite
# is wrong or the claim is. Either way it must not ship green.

set -u
cd "$(dirname "$0")/.." || exit 1

if ! node --test 'test/conformance/**/*.test.mjs' > /tmp/watcher-conf-test.log 2>&1; then
  echo "conformance FAILED:"
  tail -40 /tmp/watcher-conf-test.log
  exit 1
fi

pass=$(grep -E '^# pass ' /tmp/watcher-conf-test.log | awk '{print $3}')
fail=$(grep -E '^# fail ' /tmp/watcher-conf-test.log | awk '{print $3}')
echo "conformance: ${pass} passed, ${fail} failed"
[ "${fail:-1}" = "0" ] || exit 1
case "$pass" in ''|*[!0-9]*) echo "conformance FAILED: no pass count"; exit 1;; esac
[ "$pass" -eq 0 ] && { echo "conformance FAILED: 0 tests ran"; exit 1; }

# The published suite must import nothing from this project. A third party
# runs it against THEIR integration; if it reaches into src/ it is testing us,
# not them.
if grep -nE "from\s+['\"]\.\..*(src|lib)/" test/conformance/suite.mjs; then
  echo "conformance FAILED: suite.mjs imports this project's own code"
  exit 1
fi
echo "conformance: the published suite imports nothing from this project"

exit 0
