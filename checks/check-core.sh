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

# node --test exits 0 with "# pass 0" / "# fail 0" when the glob matches no
# files at all — a green board with no tests run. Reject that silently-empty
# case explicitly rather than letting an unparsed or zero pass count slip
# through as success.
case "$pass" in
  ''|*[!0-9]*)
    echo "core test suite FAILED: could not read a pass count from the log — the run did not produce the expected 'node --test' summary"
    exit 1
    ;;
esac
if [ "$pass" -eq 0 ]; then
  echo "core test suite FAILED: 0 tests ran — the glob 'test/**/*.test.mjs' matched no files, so this would otherwise be a false PASS"
  exit 1
fi

exit 0
