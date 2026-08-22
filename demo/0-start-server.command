#!/bin/bash
# WATCHER — start the corpus server.
#
# Double-click this from Finder. It opens its own Terminal window, starts the
# server, and stays open. Leave the window alone for the whole demo.

# Work from the project root no matter where this was launched from.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || { echo "Could not find the project folder. Stopping."; exit 1; }

clear
printf '\n'
printf '  ============================================================\n'
printf '                      W A T C H E R\n'
printf '                    corpus server\n'
printf '  ============================================================\n'
printf '\n'
printf '  Project folder   %s\n' "$ROOT"
printf '\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  PROBLEM: node is not installed, or not on this PATH.\n'
  printf '  The server cannot start without it.\n\n'
  printf '  Press any key to close this window.\n'
  read -r -n 1 -s
  exit 1
fi

if [ ! -f "$ROOT/server.mjs" ]; then
  printf '  PROBLEM: server.mjs was not found in the project folder.\n\n'
  printf '  Press any key to close this window.\n'
  read -r -n 1 -s
  exit 1
fi

printf '  node             %s\n' "$(node --version)"
printf '\n'

node "$ROOT/server.mjs"
STATUS=$?

printf '\n'
if [ "$STATUS" -eq 0 ]; then
  printf '  The server has stopped.\n'
else
  printf '  The server stopped with an error (exit code %s).\n' "$STATUS"
  printf '  The reason should be printed just above this line.\n'
fi
printf '\n  Press any key to close this window.\n'
read -r -n 1 -s
