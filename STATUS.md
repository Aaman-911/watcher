# WATCHER — status

Last updated: end of session 1 (setup).

## Working right now

- [x] S1 — setup: node, webcmd, plugin, folder structure, git
- [ ] S2 — corpus: 6 injected pages + 3 clean, manifest, reveal.js, server
- [ ] S3 — naive agent: read-page, think, naive.mjs
- [ ] S4 — WATCHER: envelope, detect, watcher.mjs
- [ ] S5 — live attack: inject UI + live-attack script
- [ ] S6 — gate: sensitive-verb blocking + approval screen
- [ ] S7 — scorecard: score.mjs + scorecard.html + false-positive count
- [ ] S8 — optional: compare.mjs product research agent
- [ ] S9 — demo prep: launchers, fallback recording, rehearsals

## How each was verified

**Toolchain** — checked by running each binary directly:

- node v22.14.0 (`node --version`) — above the 20.6 floor
- npm 10.9.2 (`npm --version`)
- Google Chrome 151.0.7922.170 (`/Applications/Google Chrome.app`)
- claude 2.1.238 (`claude --version`)
- webcmd 0.7.4 (`webcmd --version`), at `/Users/aman/.local/bin/webcmd`

**webcmd** — `webcmd doctor` printed `Everything looks good!` with:
daemon running on port 9777, cloak runtime connected v0.4.5, browser
binary installed, profile `default` connected, connectivity OK in 63.0s.
On first run it downloaded its own stealth Chromium (140 MB) into
`~/.cloakbrowser/`. Checksum and Ed25519 signature both verified.
It does NOT use the installed Google Chrome.

**Claude Code plugin** — `claude plugin marketplace add agentrhq/webcmd`
and `claude plugin install webcmd@webcmd` both succeeded. `claude plugin
list` shows `webcmd@webcmd` v0.7.4, scope user, enabled. `claude plugin
details` lists 7 skills including `webcmd-browser`. See "Broken or
unresolved" for the session-loading caveat.

**checks/verify-all.sh** — executable, runs every `checks/check-*.sh` in
sorted order. Run twice with identical output: empty board, exit 0. The
pass/fail board was then proved with two throwaway checks (one exit 0,
one exit 3): it printed green PASS, red FAIL with the exit code, and
exited 1. Both throwaway files were deleted.

## Broken or unresolved

- **`webcmd-browser` is not loadable inside the session that installed
  it.** Claude Code loads plugin skills at session start, so the skill
  files are on disk and enabled but invoking them returns
  `Unknown skill: webcmd:webcmd-browser`. Restart the app before S3,
  which is the first session that needs the skill. Not a broken install.
- **npm's global prefix was changed** from `/usr/local` to
  `/Users/aman/.local`. `/usr/local/lib/node_modules` is root-owned and
  the install failed with EACCES. The old location held only `corepack`
  and `npm`, so nothing was orphaned, and `~/.local/bin` was already
  first on PATH. Any future `npm install -g` now lands in `~/.local`.
- p6 (accessibility-tree mismatch) is still unvalidated. Must be tested
  against all three real webcmd snapshot modes in S2. If it doesn't
  reproduce, it gets cut and replaced, not tuned.
- The exact `claude -p` flags are still unknown. S3 must check `--help`
  rather than guessing.

## Next session starts with

Session 2 — corpus and server. **Restart Claude Code first** so
`webcmd-browser` loads.

## Decisions already made — do not relitigate

- No npm dependencies beyond `@agentrhq/webcmd`
- Plain Node ESM, no frameworks, no build step
- Canary words live only in `corpus/manifest.json`
- The server always runs in its own Terminal window, never from a session
- The naive agent stays vulnerable by design
- WebFetch is denied; all page reading goes through webcmd
- npm's global prefix is `~/.local`, set in session 1 — leave it
- Empty folders carry a `.gitkeep` so git tracks them; `results/` does
  not, because it is gitignored
