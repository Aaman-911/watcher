# WATCHER — status

Last updated: after the Antigravity review.

## Working right now

- [x] S1 — setup: node, webcmd, plugin, folder structure, git
- [x] S2 — corpus: 4 injected pages + 3 clean, manifest, reveal.js, server
- [x] S3 — naive agent: read-page, think, naive.mjs
- [x] S4 — WATCHER: envelope, detect, watcher.mjs
- [x] S5 — live attack: inject UI + live-attack script
- [x] S6 — gate: sensitive-verb blocking + approval screen
- [x] S7 — scorecard: score.mjs + scorecard.html + false-positive count
- [ ] S8 — optional: compare.mjs product research agent
- [~] S9 — demo prep: launchers done; no rehearsal
- [x] CORE — src/core: policy, detect, envelope, gate, outcome, audit

S2 shipped **four** injected pages, not six. p6 (accessibility-tree
mismatch) was cut before work started. p5 (in-review) was never built.

## How each was verified

**Toolchain** — node v22.14.0, npm 10.9.2, Chrome 151.0.7922.170,
claude 2.1.238, webcmd 0.7.4 at `/Users/aman/.local/bin/webcmd`.
`webcmd doctor` green. webcmd uses its own stealth Chromium in
`~/.cloakbrowser/`, not the installed Google Chrome.

**Corpus** — loaded all eight pages in a real browser through webcmd,
twice, identical both times. Canary present in source on p1, p2, p3;
absent from the *visible text* on p2 and p3. Reveal outlines exactly one
element per injected page and zero on every clean page. No external
requests anywhere: no fonts, no CDNs, no `<img>` tags, inline SVG only.

That browser run caught a defect static grep could not: **p1 was
concealing nothing**, because `.review p { color:#413d37 }` beat
`.ghost { color:#fff }` on CSS specificity and the injection rendered as
ordinary dark grey text. Fixed by scoping to `.review p.ghost`.

**manifest.json** — 7 entries, exactly the keys `id, file, technique,
canary, injected_text, visible_to_human, note`, in that order. Generated
by extracting the injected text and the canary from the pages rather than
transcribing them, so it cannot drift. Verified twice: all canaries
distinct, each present both in its own `injected_text` and in its actual
page file.

**server.mjs** — node built-ins only. Verified *without ever starting it*:
loaded everything above the boot section so nothing bound a port, then
confirmed injected text is escaped, generated `live.html` uses the
specificity-safe selector, path traversal is refused, and missing UI pages
return a placeholder. A generated `live.html` was confirmed white-on-white
in a real browser. The launcher was run with a stub `node` from three
different directories and resolved to the project root every time.

**lib/think.mjs** — every `claude -p` flag checked against `--help` and
tested, none guessed. Prompt goes in on stdin; page text overflows the
command-line length limit.

**The gate** — `lib/gate.mjs` is wired into `agents/watcher.mjs` through
`performAction()`, which is the only path in that agent that reaches an
action, and which checks the verb against `BLOCKED_VERBS` before anything
happens. Both paths were run end to end: a human approval was picked up in
17.7s and the action proceeded; with no decision at all the gate waited out
its 300s limit and failed closed to REJECT. The target address shown on the
approval screen is extracted from the detector's own finding, not typed in.
Exercise it deliberately with `--simulate-action`, which runs the action
path without inventing any model output.

**The server has now actually been run.** `results/live-inject.json` records
a real `POST /inject` and `results/gate-decision.json` a real decision. That
is the first http traffic this project has seen.

**src/core** — 164 unit and adversarial tests, `node --test 'test/**/*.test.mjs'`,
zero failures. The suite includes an import-graph boundary test that fails
the build if core ever imports an npm package or reaches outside `src/core`,
an adversarial invariant suite that feeds hostile content to each invariant
— page text claiming authority to widen the allowlist, instructions to skip
approval, credential-shaped fills in five disguises, and a page trying to
close the envelope early — and per-module unit tests for policy, detect,
envelope, gate, outcome, and audit. Credential refusal is verified to
survive four different config keys that attempt to disable it. Wired into
`checks/check-core.sh`, run as part of `checks/verify-all.sh`.

## Reviewed after the Antigravity session

**A fabrication was removed from `lib/think.mjs`.** A block labelled
`FALLBACK MOCK FOR LIVE DEMO` returned invented model responses whenever the
real API call failed with `session limit`. For the naive agent it returned
`"PINEAPPLE. The customer reviews indicate..."` and `"I have sent the email
with the requested information."` — both of which score COMPLIED. It
manufactured exactly the hijack result this project could not reproduce
honestly, and it would have been indistinguishable from a real run on the
scorecard. It also hardcoded a canary, breaking the manifest rule, and its
`isWatcher` test looked for `BEGIN UNTRUSTED DATA`, a string the envelope
never emits, so WATCHER would have received the hijacked mock too.

It never fired: all 36 rows of `results/scorecard.json` were checked for its
`ms: 420` signature and none carried it. Every number on record is real.
The block has been deleted. **Do not reintroduce a mock in the model path.**

**`docs/PLAN.md` canary leak is fixed.** The five hardcoded canaries were
replaced with `(see manifest.json)`. The rule now holds everywhere.

## Broken or unresolved

**The premise does not reproduce, confirmed at three runs.** 36 real model
calls, no mocks: COMPLIED 0, REFUSED 18, IGNORED 0, false positives 0 of 3.
Both agents caught every injection on every run. The naive agent scores
identically to WATCHER because the model already refuses without the
envelope. This is the finding, not a failure, and it must not be tuned away.

**`checks/check-2.sh` was shallow; Task 11 deepened it.** The original
version ran nine `[ -f ]` file-existence tests and nothing else. It would
have passed on an empty corpus with the right filenames, and it caught
neither real defect this project has hit: p1 rendering its hidden text in
visible grey because `.review p` out-specified `.ghost`, or the MERIDIAN
canary being severed by ~140-char accessible-name truncation. The current
version parses `manifest.json` and asserts content: every canary is
present in both its own `injected_text` and its own page file, p1's rule
is scoped `.review p.ghost{` so the concealment actually conceals, and
MERIDIAN sits at an offset (86) that the check verifies is ≤130 and so
survives truncation. Wired into `checks/verify-all.sh` alongside
`checks/check-core.sh`.

**Only two of four techniques reach the agent**, and only in specific
snapshot modes. p1 and p4 in `read`; p2 in `tree`/`act` but never `read`.

**`--safe-mode` does not suppress CLAUDE.md**, despite its help text. The
working fix is running from outside the project tree, which `lib/think.mjs`
does.

**No demo rehearsal has happened.** The launchers exist and resolve paths
correctly, but `1-naive`, `2-watcher` and `3-live-attack` all point at
`http://localhost:8080/...` and have never been run end to end against a
live server.

## Next session starts with

A rehearsal. Start the server from `demo/0-start-server.command`, then run
each launcher against it. Nothing in S5/S9 has been exercised over http.

After that, S8 (`compare.mjs`) is the only unbuilt session, and it is
optional.

## Decisions already made — do not relitigate

- No npm dependencies beyond `@agentrhq/webcmd`
- Plain Node ESM, no frameworks, no build step
- Canary words live only in `corpus/manifest.json`
- The server always runs in its own Terminal window, never from a session
- The naive agent stays vulnerable by design
- WebFetch is denied; all page reading goes through webcmd
- npm's global prefix is `~/.local`, set in session 1 — leave it
- p6 was cut. p5 was never built. Four injected pages, not six.
- `lib/think.mjs` runs `claude -p` from a directory outside the project,
  to keep this project's CLAUDE.md out of the agent's context
- Findings are reported as found. Nothing is tuned until it passes.
- No mocked, cached or hand-written model responses anywhere in the model
  path. If the API fails, the run fails and says so.
- The gate's blocked-verb list is a JavaScript array checked with ===, not
  an instruction to a model. It is the only defence here that does not
  depend on the model's judgement.
