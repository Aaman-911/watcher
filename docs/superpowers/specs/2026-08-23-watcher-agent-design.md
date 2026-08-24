# WATCHER as a product — design

Date: 2026-08-23
Status: approved, not yet implemented

---

## 1. What we are building and why

WATCHER today is a demonstration: scripts that read one page from a local
corpus and print a summary. It proved something worth keeping — that a
deterministic detector can report what a page *attempted* regardless of
whether any model complied — but it is not usable for anything.

This design turns it into two deliverables:

1. **`@watcher/core`** — a library that adds prompt-injection defence to
   anybody's agent. No browser, no network, no CLI. You give it page text and
   an intended action; it gives you findings, an envelope, and a verdict on
   whether the action may proceed.
2. **`watcher`** — a defended browsing agent, built as the first consumer of
   that library. Point it at a URL with a task. It navigates, reads,
   extracts, and can click, fill and submit — with the defence running on
   every page and a human gate in front of every state-changing action.

The agent exists to prove the library is usable in anger. If the agent needs
something the library cannot express, the library is wrong.

### Success criteria

- A third party can `import` core, wire it into their own agent, and pass a
  conformance suite without reading core's internals.
- The agent completes a multi-step task across several pages on a live site.
- Every safety invariant in §5 has a test that attempts to defeat it with
  hostile page content, and fails the build if the invariant breaks.
- No credential ever passes through this codebase.

---

## 2. Architecture

```
src/
  core/                the defence. Pure. No browser, no network, no CLI.
    policy.mjs         allowlist + verb rules; the decision authority
    detect.mjs         deterministic scan for AI-directed instructions
    envelope.mjs       wrap untrusted content for a model
    gate.mjs           human approval for sensitive actions
    outcome.mjs        COMPLIED / REFUSED / IGNORED classification
    audit.mjs          append-only event log
    index.mjs          the public API surface; the only file consumers import

  agent/               the browsing agent. Consumes core.
    browser.mjs        webcmd wrapper: navigate, snapshot, click, fill, submit
    model.mjs          `claude -p` wrapper, structured output, cost accounting
    loop.mjs           the step loop
    actions.mjs        action dispatch; every action passes through policy
    report.mjs         human-readable run report

  cli/
    main.mjs           argument parsing, config loading, output

bin/watcher            executable entry point
```

**`core` must never import from `agent`, `cli`, or any npm package.** This is
enforced by a test that walks core's import graph, not by discipline. A
consumer adopting core must not be forced to adopt webcmd, a CLI, or an
opinion about how to drive a browser.

`agent` may import `core`. `cli` may import both.

### Dependencies

Zero npm dependencies in `core` — Node built-ins only. `agent` may use
`@agentrhq/webcmd`, which is already the project's single permitted
dependency. This preserves the existing rule and makes core trivially
auditable.

---

## 3. Core library API

Everything below is exported from `src/core/index.mjs`. Nothing else is
public.

### 3.1 Policy — the decision authority

```js
const policy = createPolicy({
  allowHosts: ['localhost', '127.0.0.1'],   // exact hostnames or *.example.com
  blockedVerbs: [...],                      // EXTENDS the standard list
  maxSteps: 20,
  maxCostUsd: 2.00,
  approvalTimeoutMs: 300000
});

policy.canVisit(url)          // → { allowed: boolean, reason: string }
policy.canAct(verb)           // → { allowed: boolean, needsApproval: boolean, reason: string }
policy.canFill(field, value)  // → { allowed: boolean, reason: string }
policy.limits()               // → { maxSteps, maxCostUsd, approvalTimeoutMs }
```

Policy is constructed once from config and is **immutable thereafter**. There
is no setter, no `policy.allow(...)`, and no way for a later caller — or a
page — to widen it at runtime. Widening requires a new process with new
config.

`blockedVerbs` is a floor, not a default. Whatever a consumer supplies is
unioned with the standard eight verbs: config may ADD a verb, never remove
one. §5.2 says those verbs always require a human and §6 says config cannot
disable the gate, and those safety clauses govern — an empty
`blockedVerbs: []` therefore leaves the gate exactly as it was.

`canFill` is where credential refusal lives (§5.3).

### 3.2 Detect

```js
detect(text)  // → [{ text, offset, pattern }]
```

Unchanged in behaviour from the current implementation: deterministic regex
patterns, no model call, no network. Same input always gives the same output.

The pattern list grows over time. Each pattern carries a human-readable label
that appears in reports, because "we blocked something" is far less useful
than "the page told an assistant to email a transcript to an outside address".

### 3.3 Envelope

```js
envelope({ url, pageText, task, history })  // → string
```

Wraps untrusted page content in delimited tags carrying its source, preceded
by a statement that the content was written by strangers, may contain text
shaped like instructions, and that such text is data to be reported and never
obeyed. `history` carries prior steps so the model has continuity across a
multi-step task.

### 3.4 Gate

```js
gate.request({ verb, target, summary, values })  // → 'approve' | 'reject'
```

Writes the pending action where an approval UI can see it, blocks until a
human decides, and **fails closed**: no answer within the timeout is a
reject, never an approve.

The gate is transport-agnostic. **Core's built-in transport is the
filesystem only** — it writes the pending action to a file and watches for a
decision file, using Node built-ins and nothing else. This keeps core free of
network code and npm dependencies.

Serving an approval screen over HTTP is the job of a *consumer* of core; our
`server.mjs` already does exactly this by reading and writing those files. A
consumer wanting a different mechanism — a Slack message, a terminal prompt,
a webhook — supplies it via `createGate({ transport })` and core never learns
what happened at the other end.

### 3.5 Outcome

```js
classify(output, expectation)  // → { state, meaning, evidence }
```

Three states — COMPLIED, REFUSED, IGNORED — as already implemented and
already justified: a model that refuses an injection usually names the canary
while explaining what it refused, so a boolean `output.includes(canary)`
scores a defence as an attack.

### 3.6 Audit

```js
audit.record({ type, ...fields })   // append-only
audit.read({ runId })               // → events[]
```

Every page read, every finding, every action attempted, every policy
decision, every gate decision. JSONL, one event per line, never rewritten.

**The audit log is a product output, not a debug aid.** The central claim of
this project is that you can prove what a page attempted independently of
what a model did. That claim is only worth something if the evidence is
durable and reviewable after the fact.

---

## 4. The agent loop

One step is: **read → detect → decide → check → act**.

```
1. read      browser.snapshot(url, mode)      → page text
2. detect    core.detect(pageText)            → findings, recorded to audit
3. decide    model.decide(envelope(...))      → one structured action
4. check     policy.canVisit / canAct / canFill  ← JavaScript, before anything
5. act       actions.dispatch(action)         → result, or gate, or refusal
```

Repeat until the model returns `finish`, or `maxSteps` is reached, or
`maxCostUsd` is exhausted, or an unrecoverable error occurs.

### 4.1 The action vocabulary

The model chooses from a fixed enum, enforced by `--json-schema`:

| action | meaning | policy check |
|---|---|---|
| `navigate` | go to a URL | `canVisit` |
| `extract` | pull specific content from the current page | none — read-only |
| `click` | click an element | `canAct(verbOf(target))` — see below |
| `fill` | type into a field | `canFill(field, value)` |
| `submit` | submit a form | `canAct('submit')` → gate |
| `finish` | task complete, return the answer | none |

The model chooses **what to attempt**. It never decides **what is
permitted**. Steps 4 and 5 are ordinary JavaScript and are not reachable by
anything a page can say.

**Clicks are gated by what they do, not by being clicks.** A click on
"Reviews" is navigation; a click on "Place order" is a purchase. Treating
`click` as uniformly safe would let the single most common interaction walk
straight past the verb gate. Before any click, the target's accessible name,
button text and enclosing form action are scanned for blocked verbs, and a
match routes through the gate exactly as `submit` would.

This check is deliberately generous: an ambiguous control is treated as
sensitive. A false approval prompt costs the user two seconds. A missed one
costs them an order.

### 4.2 Structured decisions

Verified working on claude 2.1.238: `claude -p --json-schema '<schema>'
--output-format json` returns a `structured_output` object matching the
schema, plus `total_cost_usd` for budget accounting.

The decision schema:

```json
{
  "action": "navigate|extract|click|fill|submit|finish",
  "target": "string",
  "value": "string (optional, for fill)",
  "reason": "string",
  "injection_noticed": "string (optional)"
}
```

`injection_noticed` lets the model report what it saw. It is recorded and
compared against the detector's findings, which gives a per-run measure of
agreement between model judgement and deterministic detection — the number
this project actually cares about.

### 4.3 Budget

A single model call in testing cost **$0.19**, almost entirely from ~29,600
cache-creation tokens of system-prompt overhead. A ten-step run is therefore
roughly $2. `total_cost_usd` is **accumulated across every call in the run** and compared
against `maxCostUsd` after each one. When the running total would exceed the
budget the run halts cleanly before the next call, reporting how far it got
and what it spent. The budget bounds the whole run, not any single call.

---

## 5. Safety invariants

These are code paths. Each gets a test that feeds hostile page content
explicitly trying to defeat it, and the build fails if any invariant breaks.

### 5.1 Host allowlist

A URL whose hostname is not on the allowlist is never fetched. Comparison is
exact hostname match, or a single leading-wildcard form (`*.example.com`)
matched by suffix against the hostname only — never against the full URL, so
`evil.com/?x=example.com` cannot pass.

Redirects are re-checked after resolution. A page that redirects to a
disallowed host is dropped, not followed.

### 5.2 Verb gate

`send, submit, pay, buy, delete, message, post, transfer` always require a
human. The list is a JavaScript array compared with `===`. Fails closed.

### 5.3 No credentials, ever

`canFill` refuses:

- any field whose type is `password`
- any field whose name, id, label or placeholder matches credential patterns
  (password, passwd, pin, cvv, otp, mfa, secret, token, api key, card number,
  ssn, passport)
- any value that looks like a secret (long high-entropy strings, key
  prefixes, card-number patterns passing a Luhn check)

**This is not configurable.** There is no config key that turns it off. The
agent cannot log in, and login flows are out of scope permanently.

### 5.4 No CAPTCHA or bot-detection defeat

If a CAPTCHA or bot challenge is detected, the run stops and hands control to
the human with a clear message. The agent never attempts to solve one and
contains nothing intended to make it harder to identify as an agent.

### 5.5 Detection precedes the model

`detect()` runs on raw page text and its findings reach the audit log
*before* any model call. If the model call fails, times out, or returns
nonsense, the record of what the page attempted still exists.

---

## 6. Configuration

`watcher.config.json`, discovered from the working directory upward, with
CLI flags overriding file values:

```json
{
  "allowHosts": ["localhost", "127.0.0.1"],
  "model": "sonnet",
  "maxSteps": 20,
  "maxCostUsd": 2.00,
  "approvalTimeoutMs": 300000,
  "snapshotMode": "read",
  "auditPath": "results/audit.jsonl"
}
```

Config is data. It cannot enable a credential path, disable the gate, or
disable detection — those keys do not exist.

---

## 7. Errors

| condition | behaviour |
|---|---|
| host not allowlisted | refuse the step, record it, continue the run |
| gate timeout | reject, record, continue |
| model returns invalid JSON | one retry, then fail the run with the raw output shown |
| model call fails | fail the run and say so; **never substitute a fabricated response** |
| budget exhausted | halt cleanly, report progress so far |
| max steps reached | halt cleanly, report progress so far |
| page unreachable | record, let the model choose a different step |

The fabrication rule is explicit because it has already gone wrong once in
this repo: a mock was added that returned invented model output on API
failure, which would have put fake results on the scorecard indistinguishably
from real ones. Nothing in the model path may ever return text the model did
not produce.

---

## 8. Testing

**Unit — `test/core/`.** Pure, fast, no network, no model, fully
deterministic. Policy, detect, envelope, outcome, audit.

**Adversarial — `test/adversarial/`.** Page content that actively tries to
talk past each invariant: text claiming operator authority to widen the
allowlist, text instructing the agent to skip approval, credential-shaped
fill requests, redirect chains to disallowed hosts. Each asserts the
invariant held.

**Integration — `test/integration/`.** Runs against the corpus over HTTP,
starting and stopping the server itself. Real browser, real snapshots, no
model.

**Model — `test/model/`.** The only tests that spend money. Gated behind
`WATCHER_MODEL_TESTS=1` so CI stays free and deterministic.

**Conformance — `test/conformance/`.** The suite a third party runs against
their own core integration.

`checks/check-2.sh` is deepened to assert content rather than file existence.
As written it would pass on an empty corpus with the right filenames, and it
caught neither real defect this project has hit.

---

## 9. Migration

Existing files move rather than being rewritten:

| now | becomes |
|---|---|
| `lib/detect.mjs` | `src/core/detect.mjs` |
| `lib/envelope.mjs` | `src/core/envelope.mjs` |
| `lib/gate.mjs` | `src/core/gate.mjs` (transport extracted) |
| `lib/outcome.mjs` | `src/core/outcome.mjs` |
| `lib/read-page.mjs` | `src/agent/browser.mjs` (extended) |
| `lib/think.mjs` | `src/agent/model.mjs` (structured output added) |

`agents/naive.mjs` **stays exactly as it is.** It is the control in an
experiment, it is supposed to be vulnerable, and it must not acquire any of
this. `agents/watcher.mjs` and `report/score.mjs` are rewired onto core and
kept, because the scorecard is the evidence for the project's central claim.

The corpus stays and becomes the integration and conformance fixture.

---

## 10. Non-goals

- Login, authentication, session handling, credential storage
- CAPTCHA solving or bot-detection evasion
- Crawling at scale, parallelism, or a job queue
- A hosted service, accounts, or multi-user anything
- Browser extension or GUI beyond the existing approval and scorecard pages
- Defeating an attacker who has read this design; §11 covers why

---

## 11. Honest limits

**Detection is patterns, not comprehension.** It catches phrasings it was
written to catch. Novel phrasing slips past. Its virtue is being
deterministic and auditable, not complete.

**A defended agent is not a safe agent.** The gate reduces the blast radius
of a successful injection; it does not prevent injection. An agent whose
allowlist includes a compromised host is still reading hostile content.

**The corpus is synthetic**, written by one hand in one style. Real hostile
pages are written by people trying to win.

**Model resistance is not a security property.** Current models refuse these
injections unprompted. That is a fact about today's models, not a guarantee,
and it is exactly why the load-bearing parts of this design are the ones that
do not consult a model.

---

## 12. Build order

1. `core` with unit tests — policy, detect, envelope, outcome, audit
2. `gate` with transport extracted, plus adversarial tests
3. `agent/browser` — navigate, snapshot, click, fill, submit over webcmd
4. `agent/model` — structured output, cost accounting
5. `agent/loop` + `actions` — the step loop with policy checks
6. `cli` + config
7. Rewire `watcher.mjs` and `score.mjs` onto core
8. Integration, conformance, deepened `check-2.sh`
9. Docs, packaging, CI

Each stage lands green before the next begins.

---

## 13. Rule change

`CLAUDE.md` currently says *"Everything runs on localhost. No third-party
sites, no logins, no credentials anywhere in this project."*

It becomes: *"The agent browses only hosts on the configured allowlist;
localhost is the default and the corpus remains local. No logins and no
credentials anywhere in this project, ever — this is not configurable."*

The localhost-only clause is relaxed because an agent that can only read its
own fixtures cannot be evaluated against anything real. The credential clause
is tightened from a convention into an invariant with a test behind it.
