#!/usr/bin/env bash
# WATCHER — core library check. Runs the whole unit and adversarial suite.

set -u
cd "$(dirname "$0")/.." || exit 1

if ! node --test 'test/**/*.test.mjs' > /tmp/watcher-core-test.log 2>&1; then
  echo "core test suite FAILED:"
  tail -30 /tmp/watcher-core-test.log
  exit 1
fi

pass=$(grep -E '^# pass ' /tmp/watcher-core-test.log | awk '{print $3}')
fail=$(grep -E '^# fail ' /tmp/watcher-core-test.log | awk '{print $3}')
echo "core: ${pass} passed, ${fail} failed"

[ "${fail:-1}" = "0" ] || exit 1
exit 0
