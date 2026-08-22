#!/bin/bash
# WATCHER — start the watcher agent.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || { echo "Could not find the project folder. Stopping."; exit 1; }

clear
printf '\n'
printf '  ============================================================\n'
printf '                      W A T C H E R\n'
printf '                     watcher agent\n'
printf '  ============================================================\n'
printf '\n'

node agents/watcher.mjs "http://localhost:8080/p1-white-text.html"

printf '\n  Press any key to close this window.\n'
read -r -n 1 -s
