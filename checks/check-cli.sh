#!/usr/bin/env bash
# WATCHER — CLI and config check.

set -u
cd "$(dirname "$0")/.." || exit 1

if ! node --test 'test/cli/**/*.test.mjs' > /tmp/watcher-cli-test.log 2>&1; then
  echo "cli test suite FAILED:"
  tail -30 /tmp/watcher-cli-test.log
  exit 1
fi

pass=$(grep -E '^# pass ' /tmp/watcher-cli-test.log | awk '{print $3}')
fail=$(grep -E '^# fail ' /tmp/watcher-cli-test.log | awk '{print $3}')
echo "cli: ${pass} passed, ${fail} failed"
[ "${fail:-1}" = "0" ] || exit 1
case "$pass" in ''|*[!0-9]*) echo "cli test suite FAILED: no pass count"; exit 1;; esac
[ "$pass" -eq 0 ] && { echo "cli test suite FAILED: 0 tests ran"; exit 1; }

# bin/watcher must be runnable and must print usage without doing anything.
[ -x bin/watcher ] || { echo "cli FAILED: bin/watcher is not executable"; exit 1; }
if ! node bin/watcher --help | grep -q 'watcher <url> --task'; then
  echo "cli FAILED: bin/watcher --help did not print usage"
  exit 1
fi
echo "cli: bin/watcher runs and prints usage"

# The CLI wires objects together. It must not make safety decisions itself:
# no allowlist arithmetic, no verb list, no credential vocabulary of its own.
# Comments are stripped first so the file's prose can still explain the rules.
stripped=$(sed -e 's;//.*;;' src/cli/main.mjs)
if echo "$stripped" | grep -qE '\b(BLOCKED_VERBS|DEFAULT_BLOCKED_VERBS|hostMatches|looksLike[A-Z]|CREDENTIAL_FIELD)\b'; then
  echo "cli FAILED: src/cli/main.mjs has started making safety decisions of its own"
  exit 1
fi
echo "cli: no safety decisions in src/cli"

# There must be no flag, anywhere, that turns a safety property off.
if grep -rEn -- "--(no-gate|skip-gate|skip-approval|auto-approve|allow-credentials|no-detect|solve-captcha|allow-all)" src/ bin/ 2>/dev/null; then
  echo "cli FAILED: a flag that disables a safety property exists"
  exit 1
fi
echo "cli: no flag disables the gate, credential refusal or detection"

exit 0
