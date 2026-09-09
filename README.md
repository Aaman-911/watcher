# WATCHER

Prompt-injection defence for browsing agents, and a defended agent built on it.

A web page can carry text aimed at an AI rather than at you — hidden in white
text, in an `aria-label`, in something dressed up as a system notice. WATCHER
treats every page as untrusted data, reports what the page attempted, and puts
a human in front of anything irreversible.

Two things ship here:

- **`src/core`** — the defence, as a library. No browser, no network, no CLI,
  no npm dependencies. Give it page text and an intended action; it gives you
  findings, an envelope, and a verdict.
- **`bin/watcher`** — a browsing agent built on that library, and the proof it
  is usable in anger.

---

## The one idea

**The load-bearing parts never ask a model anything.**

A model that can be talked out of a rule is not enforcing it. So the allowlist
is a hostname comparison, the verb gate is a JavaScript array compared with
`===`, credential refusal is a set of patterns with no configuration switch,
and the human gate blocks until a person answers. A page can say whatever it
likes; it cannot reach any of them.

The model-facing defences — the envelope, the detector — are real and useful,
but they are advisory. Everything that must hold is code.

---

## Quick start

Requires Node 20.6+ and [webcmd](https://www.npmjs.com/package/@agentrhq/webcmd).
No API key: the agent shells out to `claude -p`, using whatever Claude Code
login you already have.

```bash
node bin/watcher https://example.com/page \
  --task "Summarise the customer reviews" \
  --allow example.com \
  --dry-run
```

`--dry-run` runs every check and writes the full audit log without performing
a single action. Use it first, every time you point the agent somewhere new.

Drop `--dry-run` when you are satisfied. Anything sensitive stops and asks:

```
  ############################################################
  #  BLOCKED — this action needs a human                     #
  ############################################################
  verb     buy
  target   Place order
  summary  Click "Place order", which performs: buy

  Approve? type y or n, then Enter. Nothing happens until you do.
  No answer within the timeout is a refusal.
```

**The allowlist is empty by default and the agent refuses to run without one.**
An agent with a default-open allowlist will eventually read something you did
not choose.

### Configuration

`watcher.config.json`, found by walking up from the working directory. Flags
override it.

```json
{
  "allowHosts": ["localhost", "*.corp.test"],
  "blockedVerbs": ["archive"],
  "model": "sonnet",
  "maxSteps": 8,
  "maxCostUsd": 2.00,
  "snapshotMode": "read",
  "auditPath": "results/audit.jsonl"
}
```

An unknown key is an **error**, not something ignored — if you write a setting
and it does not exist, you find out immediately rather than believing it took
effect. `blockedVerbs` only ever *adds* to the standard eight; it cannot
shorten them. There is no key that disables the gate, credential refusal or
the detector, and asking for one by name tells you so.

`maxSteps` defaults to 8 because a `claude -p` call measured at **$0.2181**,
almost all of it system-prompt overhead. Twenty steps would cost about $4.40.

---

## Using the library in your own agent

```js
import {
  createPolicy, createAudit, createGate, createFileTransport, detect, envelope
} from './src/core/index.mjs';

const audit  = createAudit({ path: './run.jsonl', runId: crypto.randomUUID() });
const policy = createPolicy({ allowHosts: ['docs.corp.test'] });
const gate   = createGate({ transport: createFileTransport({ /* ... */ }), audit });

// 1. before fetching
if (!policy.canVisit(url).allowed) return;

// 2. detect BEFORE the model sees anything, and record it
const findings = detect(pageText);
audit.record({ type: 'findings', url, findings });

// 3. wrap the page as data, not instruction
const answer = await yourModel(envelope({ url, pageText, task, history }));

// 4. check every action in JavaScript, before it happens
const verb = policy.verbOfControl({ text: control.accessibleName });
if (verb && policy.canAct(verb).needsApproval) {
  if (await gate.request({ verb, target, summary }) !== 'approve') return;
}

// 5. never type a secret
if (!policy.canFill(field, value).allowed) return;
```

Then run the conformance suite against your integration:

```js
import { runConformance } from './test/conformance/suite.mjs';

const { failed, results } = await runConformance({
  policy, detect, envelope,
  makePolicy: options => createPolicy({ allowHosts: [...], ...options }),
  makeGate: createGate,
  allowedHost: 'docs.corp.test'
});
```

It imports nothing from this project. It tries to defeat your integration —
userinfo tricks in URLs, config that tries to empty the verb list, a page that
writes the envelope's own closing tag, a gate whose transport throws — and
tells you which invariants did not hold. It is checked against a deliberately
wide-open integration in our own tests, so it is known to be capable of
failing.

---

## What the defence actually consists of

| Part | What it does | Consults a model? |
|---|---|---|
| `canVisit` | hostname allowlist, re-checked after redirects; http/https only | no |
| `canAct` | eight verbs always need a human; config can add, never remove | no |
| `verbOfControl` | reads what a control *does* — "Place order" is a purchase | no |
| `canFill` | refuses credential fields and secret-shaped values | no |
| `gate` | blocks until a human answers; fails closed on silence, on a mismatched id, and on a transport that throws | no |
| `envelope` | wraps page content as data a model must report, never obey | advisory |
| `detect` | deterministic scan for text aimed at an AI | no |
| `audit` | append-only JSONL; survives a run that crashed | no |

### The audit log is a product output

The claim WATCHER makes is that you can prove what a page *attempted*
independently of what any model *did*. That holds only if the evidence
outlives the run — including a run that was killed part-way through. So
`detect()` and its audit write happen **before** any model call, and a torn
final line costs that one line and nothing else.

A test asserts the ordering. A companion test kills the model call outright
and proves the findings survive it.

---

## Honest limits

**Detection is patterns, not comprehension.** It catches phrasings it was
written to catch. Novel phrasing slips past. Its virtue is being deterministic
and auditable, not complete.

**A defended agent is not a safe agent.** The gate reduces the blast radius of
a successful injection; it does not prevent injection. An agent whose
allowlist includes a compromised host is still reading hostile content.

**Model resistance is not a security property.** Measured over 36 real model
calls across three runs on the bundled corpus: COMPLIED 0, REFUSED 18,
IGNORED 0, false positives 0 of 3. **The naive control agent scored
identically to WATCHER** — current models refuse these injections without any
envelope at all.

That is a fact about today's models, not a guarantee, and it is reported here
rather than tuned away. It is also precisely why the load-bearing parts of
this design are the ones that never consult a model.

**The corpus is synthetic**, written by one hand in one style. Real hostile
pages are written by people trying to win.

---

## Repository layout

```
src/core/        the defence. Pure. No browser, no network, no CLI, no npm.
src/agent/       browser, model, loop, actions, report. Consumes core.
src/cli/         argument parsing, config. Wiring only.
bin/watcher      the executable
corpus/          six self-hosted pages: three injected, three clean
agents/          the demo pair — naive.mjs (vulnerable by design) and watcher.mjs
report/score.mjs the scorecard: both agents over every page, real model calls
test/            unit, adversarial, integration, conformance
checks/          verify-all.sh runs every check and prints a board
```

`src/core` imports nothing but Node built-ins, and a test walks its import
graph and fails the build if that stops being true.

**`agents/naive.mjs` is deliberately vulnerable.** It concatenates page text
and task with nothing between them. It is the control in an experiment; do not
defend it.

---

## Verifying

```bash
./checks/verify-all.sh
```

Runs every check and prints a board. Integration tests need webcmd installed;
without it they skip and say so rather than passing quietly.

---

## Safety commitments

- **No credentials, ever.** The agent cannot log in. `canFill` refuses
  password fields, credential-shaped names and secret-shaped values, and there
  is no configuration key that turns it off. Login flows are permanently out
  of scope.
- **No CAPTCHA solving, no bot-detection evasion.** A challenge halts the run
  and hands control back to you. Nothing here is intended to make the agent
  harder to identify as an agent.
- **No fabricated model output.** If the model call fails, the run fails and
  says so. A test walks every file under `src/` and fails the build if a mock
  transport appears — this went wrong once already, and a mock in the model
  path puts invented results on a scorecard indistinguishably from real ones.
