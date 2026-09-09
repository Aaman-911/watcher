#!/usr/bin/env bash
# WATCHER — agent layer check. Runs test/agent and asserts the boundary rules
# that keep the browser and model layers honest.

set -u
cd "$(dirname "$0")/.." || exit 1

if ! node --test 'test/agent/**/*.test.mjs' > /tmp/watcher-agent-test.log 2>&1; then
  echo "agent test suite FAILED:"
  tail -30 /tmp/watcher-agent-test.log
  exit 1
fi

pass=$(grep -E '^# pass ' /tmp/watcher-agent-test.log | awk '{print $3}')
fail=$(grep -E '^# fail ' /tmp/watcher-agent-test.log | awk '{print $3}')
echo "agent: ${pass} passed, ${fail} failed"

[ "${fail:-1}" = "0" ] || exit 1

# node --test exits 0 with "# pass 0" when the glob matches nothing at all.
# Reject that silently-empty case rather than letting it read as success.
case "$pass" in
  ''|*[!0-9]*)
    echo "agent test suite FAILED: could not read a pass count from the log"
    exit 1
    ;;
esac
if [ "$pass" -eq 0 ]; then
  echo "agent test suite FAILED: 0 tests ran — the glob matched no files"
  exit 1
fi

# The agent layer may spawn webcmd as a subprocess, but it must not IMPORT any
# npm package. Every import in src/agent has to be a node: builtin or a
# relative path. Zero dependencies is a project rule, and a rule with no test
# behind it is a preference.
bad=$(grep -hoE "^[[:space:]]*(import|export)[^'\"]*from[[:space:]]*['\"][^'\"]+['\"]" src/agent/*.mjs \
      | grep -oE "['\"][^'\"]+['\"]$" | tr -d "\"'" \
      | grep -vE '^node:' | grep -vE '^\.' || true)
if [ -n "$bad" ]; then
  echo "agent boundary FAILED: src/agent imports something that is not a node: builtin or a relative path:"
  echo "$bad"
  exit 1
fi
echo "agent: no npm imports in src/agent"

# Playwright programs are built by string concatenation, which is exactly the
# place a page-derived value could become code. Every value crossing into one
# must be JSON.stringify'd. A raw ${...} hole inside a page.* call is the
# failure this greps for.
holes=$(grep -nE 'page\.(goto|click|fill|evaluate|type|press)\([^)]*\$\{' src/agent/browser.mjs \
        | grep -v 'JSON.stringify' || true)
if [ -n "$holes" ]; then
  echo "agent boundary FAILED: a value is interpolated into a Playwright call without JSON.stringify:"
  echo "$holes"
  exit 1
fi
echo "agent: every value crossing into Playwright is JSON.stringify'd"

exit 0
