#!/bin/bash
# WATCHER — start the live attack demo.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || { echo "Could not find the project folder. Stopping."; exit 1; }

clear
printf '\n'
printf '  ============================================================\n'
printf '                      W A T C H E R\n'
printf '                   live attack demo\n'
printf '  ============================================================\n'
printf '\n'

URL="http://localhost:8080/live.html"

printf '-> Running Naive Agent on live page...\n\n'
node agents/naive.mjs "$URL"

printf '\n-> Running Watcher Agent on live page...\n\n'
node agents/watcher.mjs "$URL"

printf '\n  Press any key to close this window.\n'
read -r -n 1 -s
