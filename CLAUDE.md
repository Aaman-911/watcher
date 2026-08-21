# WATCHER

This project demonstrates that hidden text on a webpage can issue
instructions to an AI agent, and defends against it.

Three parts: a corpus of self-hosted pages carrying concealed
instructions; two agents, one deliberately vulnerable and one defended;
and an automatically generated scorecard. Everything runs on localhost.
No third-party sites, no logins, no credentials anywhere in this project.

---

## Authority

- **STATUS.md is the authority on what is already built.** Read it at the
  start of every session.
- **docs/PLAN.md is reference material.** Read it only when I point you
  at it. If it disagrees with STATUS.md, STATUS.md wins.
- **Never build ahead of the session I name.** If you think a later
  session's work is needed now, say so and wait.

---

## Hard rules

- All page reading goes through **webcmd**. Never use WebFetch — it is
  denied in settings. Do not work around it.
- Plain Node ESM. No frameworks, no build step, no bundler, no TypeScript.
- **Zero npm dependencies** outside `@agentrhq/webcmd`. Node built-ins only.
- **Never start `server.mjs` yourself.** It runs forever and would hang
  the session. It lives in its own Terminal window, started by me from
  `demo/0-start-server.command`.
- Every injected instruction must be harmless and obviously fake. Canary
  words only. Reserved `.test` domains only. Never a real credential, a
  real endpoint, or a real company name.
- Canary words live only in `corpus/manifest.json`. Never hardcode one
  anywhere else.
- The naive agent is **supposed** to fail. Do not defend it, do not
  sanitise its input, do not improve it.

---

## How to work with me

- I am not a programmer. Explain what you changed in plain English.
- Change only what I asked for. If something else needs changing, tell me
  first and wait for an answer.
- Before saying anything works, run it twice and show me both outputs.
  Don't summarise output — paste what actually printed.
- If you've tried the same fix three times, stop. List three different
  possible causes, say which is most likely and why, and touch no files
  until I reply.
- If something doesn't reproduce or a number is disappointing, tell me
  plainly. Never adjust a test until it passes.
- Don't guess at CLI flags or APIs. Check with `--help` or read the
  relevant skill first, then tell me what you found.

---

## Session rhythm

Every session ends with:

1. `checks/verify-all.sh` run twice, both outputs shown
2. STATUS.md rewritten — what works and how it was verified, what's
   broken, what the next session starts with, decisions not to relitigate
3. `git add -A`, commit as `session <N>: <what landed>`, tag `session-<N>`
4. Push to the remote if one is configured
