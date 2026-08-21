#!/usr/bin/env bash
# WATCHER — runs every checks/check-*.sh in order and prints a board.
# Exits 0 only if every check passed.
#
# Written for the bash 3.2 that ships with macOS: no associative arrays,
# no mapfile, and no expansion of a possibly-empty array under `set -u`.

set -u

cd "$(dirname "$0")/.." || exit 1

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

# A glob already expands in sorted order, so the board is stable run to run.
# nullglob means "no matches" yields no loop iterations rather than a literal.
shopt -s nullglob

count=0
failed=0
board=""

echo
echo "WATCHER — verification"
echo "======================"
echo

for c in checks/check-*.sh; do
  name="$(basename "$c")"
  echo "--- $name ---"
  bash "$c"
  code=$?
  echo
  count=$((count + 1))
  if [ "$code" -eq 0 ]; then
    board="${board}  $(green PASS)  ${name}"$'\n'
  else
    board="${board}  $(red FAIL)  ${name} (exit ${code})"$'\n'
    failed=1
  fi
done

echo "board"
echo "-----"

if [ "$count" -eq 0 ]; then
  echo "  (no checks yet)"
else
  printf '%s' "$board"
fi

echo
if [ "$failed" -eq 0 ]; then
  green "ALL PASS"; echo
else
  red "SOME FAILED"; echo
fi
echo

exit "$failed"
