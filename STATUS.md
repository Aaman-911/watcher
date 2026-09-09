# WATCHER — status

Last updated: session 11 (step loop, actions, CLI, config).

## Working right now

- [x] S1 — setup: node, webcmd, plugin, folder structure, git
- [x] S2 — corpus: injected pages + clean pages, manifest, reveal.js, server
- [x] S3 — naive agent: read-page, think, naive.mjs
- [x] S4 — WATCHER: envelope, detect, watcher.mjs
- [x] S5 — live attack: inject UI + live-attack script
- [x] S6 — gate: sensitive-verb blocking + approval screen
- [x] S7 — scorecard: score.mjs + scorecard.html + false-positive count
- [ ] S8 — optional: compare.mjs product research agent
- [~] S9 — demo prep: launchers done; no rehearsal
- [x] CORE — src/core: policy, detect, envelope, gate, outcome, audit
- [x] S10 — src/agent: browser.mjs and model.mjs (spec stages 3-4)
- [x] S11 — src/agent/loop.mjs + actions.mjs + report.mjs, src/cli, bin/watcher (stages 5-6)
- [ ] S12 — rewire watcher.mjs and score.mjs, integration and conformance
      tests, docs, CI (stages 7-9)

## A correction to this file

The previous version of STATUS.md said S2 shipped **four** injected pages
and that `manifest.json` has **7 entries**. Both are wrong, found while
reading `check-2.sh` output in this session.

The manifest has **6 entries**: three injected pages (`p1` white-text,
`p2` aria-label, `p4` fake-system) and three clean pages. Only **two**
carry a canary — `p4` has none, because a fake-system page tests whether
the agent obeys a fabricated authority, not whether it emits a word.
There is no `p3`; it was never built, alongside the already-recorded `p5`
and `p6`.

Nothing was changed to make this true. `check-2.sh` has been reporting
"6 entries, 2 canaries" correctly all along, and the 36 rows of
`results/scorecard.json` are consistent with 6 pages x 2 agents x 3 runs.
Only the prose in this file was wrong.

## What landed in session 10

**`src/agent/browser.mjs`** — owns the webcmd subprocess and turns
intentions into Playwright calls. It decides nothing about what is
permitted; it does not import `src/core/policy.mjs`, and a test asserts
that it has not started to.

Four rules, each with a test behind it:

1. **Refs only.** `click`, `fill` and `submit` accept a ref matching
   `/^w\d+$/` that is present in the most recent inventory. Nine hostile
   ref forms are tried in the tests, including `w0"], [data-x="` and
   `"); await page.goto("http://evil.test"); //`, and every one is
   refused before a Playwright program is built.
2. **No interpolation, ever.** Every value crossing into a Playwright
   program is `JSON.stringify`'d. This matters because page text reaches
   the model, the model produces a target, and the target becomes
   JavaScript that runs inside the page — a raw paste there would be code
   execution one layer past everything core defends. The test strips
   string literals out of the generated program and asserts no
   `page.goto` and no `evil.test` survives in what is left, which is the
   only honest way to ask the question: an escaped payload still contains
   the characters "await page.goto" inside a string, and a substring
   search cannot tell that apart from a real call.
3. **The inventory carries real DOM attributes.** See the finding below.
4. **The redirect chain is returned, not swallowed**, so the caller can
   re-run `canVisit` on the final URL per spec section 5.1.

Also: a deterministic CAPTCHA and bot-challenge check that reports and
never solves (spec 5.4), and snapshot truncation passed through rather
than hidden, because a finding that was cut off is not the same as no
finding.

**`src/agent/model.mjs`** — a transport seam plus the one transport we
ship. `createModel({transport})` takes its transport by injection, so the
step loop in S11 can be tested against a scripted decision sequence for
free. **No fake transport ships from `src/`**, and a test walks every
file under `src/` and fails the build if one appears. Retries once on an
unusable decision, then fails the run with the raw output shown. A
transport failure propagates; nothing is substituted.

## How session 10 was verified

**`checks/verify-all.sh`, run twice, identical both times:**

```
--- check-2.sh ---
corpus: 6 entries, 2 canaries, all consistent

--- check-agent.sh ---
agent: 34 passed, 0 failed
agent: no npm imports in src/agent
agent: every value crossing into Playwright is JSON.stringify'd

--- check-core.sh ---
core: 203 passed, 0 failed

board
-----
  PASS  check-2.sh
  PASS  check-agent.sh
  PASS  check-core.sh

ALL PASS
```

**Two live probes, not guesses.** Both flags this layer depends on were
checked against the installed tools before any code was written.

`webcmd 0.7.4` has **no** click, fill or submit command — only
`browser run` (Playwright JS on stdin) and `browser snapshot` (modes
`act`, `tree`, `read`). Everything the agent does to a page is therefore
a Playwright program, which is what makes rule 2 above load-bearing
rather than tidy.

`claude 2.1.238` with `--json-schema` and `--output-format json` returns
`structured_output` alongside `total_cost_usd`. Real numbers from the
probe: **$0.2181 for one call, on 36,124 cache-creation tokens**, almost
all of it system-prompt overhead. That is what sets the defaults in S11:
`maxSteps: 8` is roughly $1.75, which fits under a `maxCostUsd` of $2.00.
The spec's `maxSteps: 20` would be about $4.40 per run.

**A real finding that changed the design.** webcmd's `act` snapshot does
not expose `type="password"`. Probed against a page carrying both a
quantity field and a password field, it returned:

```
<textbox ref="l4" placeholder="Quantity">Quantity</textbox>
<textbox ref="l5" placeholder="Password">Password</textbox>
```

Identical element types. `policy.canFill({type:'password'})` — the first
rule of spec section 5.3 — can therefore never fire from snapshot data.
It held anyway on that page, via the placeholder path, but only because
the field happened to be labelled: on a field named `q7` with no
placeholder, nothing would have caught it.

`browser.mjs` does not parse the `act` snapshot for this. It runs its own
DOM inventory through `page.evaluate`, tagging each actionable element
with `data-watcher-ref` and reading `type`, `name`, `id`, `placeholder`,
`aria-label`, `href` and the enclosing form's action off the element
itself. Verified against the same page: `type: "password"` comes through.
`describe(ref)` returns that record, and it is what gets handed to
`policy.canFill`.

**A change to an existing check.** `checks/check-core.sh` globbed
`test/**/*.test.mjs`, which would have swallowed the new agent tests and
reported them on the board under the label "core". It is now scoped to
`test/core` and `test/adversarial`, and `checks/check-agent.sh` owns
`test/agent`. Each layer has its own count.

## What landed in session 11

The agent is runnable. `bin/watcher <url> --task "..."` works end to end.

**`src/agent/actions.mjs`** — where a model's intention meets policy. Every
branch runs its policy check first, in ordinary JavaScript, and only then
touches the page. There is no path through the file that reaches a browser
mutation without a check in front of it.

- `navigate` checks `canVisit` before the fetch and again on the URL it
  actually landed on. A page that redirects off the allowlist is refused,
  which also means the loop never snapshots it, so its text never reaches
  the model.
- `click` asks `policy.verbOfControl` what the control actually does. A
  click on "Reviews" is navigation; a click on "Place order" is a purchase
  and goes to a human.
- `fill` hands `policy.canFill` the element as `browser.describe(ref)`
  reports it — real DOM attributes, not the snapshot's flattened view.
- `submit` always asks a human, whatever the button is labelled.
- With no gate wired, a sensitive action fails closed rather than
  proceeding unasked.
- `dryRun` runs every check and every audit write, then stops short of the
  mutation.

**`src/agent/loop.mjs`** — read, detect, decide, check, act. Halts on
`finish`, `maxSteps`, the budget, a bot challenge, or an unrecoverable
error. A policy refusal is not fatal: it is recorded, it appears in the
history the model sees next step, and the run carries on, which is what
lets the agent try another route rather than dying on a locked door.

**`src/cli/config.mjs`** — `watcher.config.json`, found by walking up from
the working directory, with CLI flags overriding it. Config is data: an
unknown key is an **error**, not something ignored, and eleven keys that
would reach for a safety switch (`allowCredentials`, `skipGate`,
`autoApprove`, `disableDetection`, `solveCaptcha`, `allowAllHosts` and
the rest) are refused by name with a message saying why. Silently ignoring
those is the dangerous behaviour — somebody writes one, sees no error, and
believes it took effect.

**`src/cli/main.mjs` and `bin/watcher`** — wiring only. A terminal gate
transport asks on stdin when someone is watching, and falls back to the
file transport `server.mjs` already reads when nothing is. An empty
allowlist stops the run before anything is fetched, with an explanation
rather than a stack trace.

## A real bug the tests caught in session 11

Action dispatch looked up handlers in a plain object literal. That
inherits from `Object.prototype`, so `HANDLERS['__proto__']` returned that
prototype, and `HANDLERS['constructor']` returned the `Object`
constructor — a callable. A decision of `{action: "constructor"}` would
have invoked `Object(decision)`, which returns the decision itself, and
the result would have been recorded as a **completed action**.

The model picks `action` from a schema enum, so this needed the enum to be
violated to fire. That is exactly the assumption this layer is not allowed
to make: the reason the check is written in JavaScript is that it has to
hold when the layer above it does not. Fixed with a null-prototype map and
a `typeof handler === 'function'` check at the lookup. Found by a test that
tried `__proto__` and `constructor` deliberately, not by reading the code.

## How session 11 was verified

`checks/verify-all.sh`, run twice, identical both times:

```
--- check-2.sh ---
corpus: 6 entries, 2 canaries, all consistent

--- check-agent.sh ---
agent: 65 passed, 0 failed
agent: no npm imports in src/agent
agent: every value crossing into Playwright is JSON.stringify'd

--- check-cli.sh ---
cli: 26 passed, 0 failed
cli: bin/watcher runs and prints usage
cli: no safety decisions in src/cli
cli: no flag disables the gate, credential refusal or detection

--- check-core.sh ---
core: 203 passed, 0 failed

board
-----
  PASS  check-2.sh
  PASS  check-agent.sh
  PASS  check-cli.sh
  PASS  check-core.sh

ALL PASS
```

294 tests in total. The one that matters most asserts ordering: the
`findings` event reaches the audit log at a lower index than
`model_decided`. A companion test kills the model call outright and proves
the findings survive it — the model produced nothing, and the log still
shows the page tried to exfiltrate a transcript and tried to conceal
itself.

## Broken or unresolved

**The premise still does not reproduce, at three runs.** 36 real model
calls, no mocks: COMPLIED 0, REFUSED 18, IGNORED 0, false positives 0 of
3. Both agents caught every injection on every run. The naive agent
scores identically to WATCHER because the model already refuses without
the envelope. This is the finding, not a failure, and it must not be
tuned away. It is also exactly why the load-bearing parts of this project
are the ones that never consult a model.

**Only two of three techniques reach the agent**, and only in specific
snapshot modes. `p1` and `p4` in `read`; `p2` in `tree`/`act` but never
`read`.

**`--safe-mode` does not suppress CLAUDE.md**, despite its help text. The
working fix is running from outside the project tree, which both
`lib/think.mjs` and `src/agent/model.mjs` do.

**No demo rehearsal has happened.** The launchers exist and resolve paths
correctly, but `1-naive`, `2-watcher` and `3-live-attack` all point at
`http://localhost:8080/...` and have never been run end to end against a
live server.

**Nothing has driven `src/agent` against a live page yet.** Both modules
are fully unit-tested with the subprocess injected, and the two probes
above exercised the real webcmd and the real `claude -p`, but no code
path in `src/agent` has read a real page in anger. That is what S11's
loop is for.

**`agents/watcher.mjs` still imports the `lib/` shims**, not core or the
new agent layer. S12 rewires it.

## Next session starts with

**S12 — rewire, integration, conformance, docs, CI (spec stages 7-9).**

- `agents/watcher.mjs` and `report/score.mjs` rewired onto core and the
  new agent layer; the `lib/` shims deleted.
- `test/integration/` over real HTTP against the corpus, with the test
  starting and stopping its own server on its own port. The rule that the
  demo server is never started from a session stands: that rule exists
  because `server.mjs` runs forever and would hang the session, and a test
  that binds, runs and kills does not.
- `test/conformance/` — the suite a third party runs against their own
  core integration.
- README rewritten around the library and the agent rather than the demo.
- CI running `checks/verify-all.sh`.

Still unrun: `bin/watcher` has never made a real model call against a live
page. One real end-to-end run against the local corpus is the last thing
S12 should do, with the cost reported.

## Decisions already made — do not relitigate

- No npm dependencies beyond `@agentrhq/webcmd`
- Plain Node ESM, no frameworks, no build step
- Canary words live only in `corpus/manifest.json`
- The server always runs in its own Terminal window, never from a session
- The naive agent stays vulnerable by design
- WebFetch is denied; all page reading goes through webcmd
- npm's global prefix is `~/.local`, set in session 1 — leave it
- The corpus is 6 entries: p1, p2, p4, and three clean pages. p3, p5 and
  p6 were never built.
- The model path runs from a directory outside the project, to keep this
  project's CLAUDE.md out of the context of the model being measured
- Findings are reported as found. Nothing is tuned until it passes.
- No mocked, cached or hand-written model responses anywhere in the model
  path. If the API fails, the run fails and says so. A test under
  `test/agent/` enforces this across all of `src/`.
- The gate's blocked-verb list is a JavaScript array checked with `===`,
  not an instruction to a model. It is the only defence here that does
  not depend on the model's judgement.
- The model is reached through `claude -p`, behind a transport seam. There
  is no Anthropic API key in this project — a Pro subscription does not
  provide one, and buying API credits is a separate decision nobody has
  made.
- The agent may act on live allowlisted hosts, not only localhost. Chosen
  deliberately in session 10, with the risk stated: a gate bug or a
  mis-scanned control means a real action on somebody else's site. The
  mitigations are that the allowlist is empty by default, every blocked
  verb routes through a gate that fails closed, and `--dry-run` lands in
  S11 before anything is pointed at a live site.
- Element refs are minted by WATCHER in its own DOM inventory, never taken
  from a page, a model, or webcmd's snapshot. Values crossing into a
  Playwright program are always `JSON.stringify`'d.
- An unknown config key is an error, not a warning. There is no
  pass-through, and there is no flag or key anywhere that disables the
  gate, the credential refusal or the detector.
- `maxSteps` defaults to 8, not the spec's 20, because a measured
  `claude -p` call costs $0.2181 and 20 steps would exceed the $2.00
  default budget before the run started.
- The allowlist is empty by default and the CLI refuses to run with it
  empty. An agent with a default-open allowlist will eventually read
  something nobody chose.
