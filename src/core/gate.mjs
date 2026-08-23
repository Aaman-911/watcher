// WATCHER core — the human approval gate.
//
// This is the part of the defence that does not depend on a model's
// judgement. The envelope is advisory, the detector is observational; this
// is the only thing that stops an action happening.
//
// The gate is transport-agnostic. Core ships a filesystem transport built
// from node: builtins and nothing else, which keeps network code out of the
// library. Serving an approval screen over HTTP is a consumer's job.
//
// It FAILS CLOSED. No answer is not the same as yes. Neither is an answer
// that names some OTHER request, and neither is a broken transport.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const realSleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {{transport: object, timeoutMs?: number, audit?: object,
 *          sleep?: (ms:number)=>Promise<void>, clock?: ()=>number,
 *          pollMs?: number}} options
 */
export function createGate({
  transport,
  timeoutMs = 300000,
  audit = null,
  sleep = realSleep,
  clock = () => Date.now(),
  pollMs = 500
} = {}) {
  if (!transport) throw new Error('createGate needs a transport');

  async function request({ verb, target, summary, values = {} }) {
    // The id binds a decision to THIS request. Two requests sharing one
    // transport (two agent processes on the same machine, or two requests
    // in the same process back to back) must never let an answer to one be
    // read as an answer to the other — a human approving what they can see
    // on screen must not be able to accidentally approve something they
    // never saw, because it had already been overwritten by a later
    // request's own pending file.
    const id = String(clock());
    const pending = {
      id,
      requested_at: new Date().toISOString(),
      verb, target, summary, values
    };

    // Record that a human was asked before the transport is touched at
    // all. A transport that fails on its very first call must still leave
    // evidence that an approval was requested — the audit log's whole job
    // is to survive a run that crashed, not just one that finished clean.
    audit?.record({ type: 'gate_requested', verb, target, summary, values });

    let decision;
    try {
      transport.publish(pending);

      const started = clock();
      decision = null;

      while (clock() - started < timeoutMs) {
        // Only a decision naming THIS request's id counts as an answer to
        // it. A stale decision, one meant for a different in-flight
        // request, or one carrying no id at all, is indistinguishable from
        // silence — and silence fails closed.
        const answer = transport.poll(id);
        if (answer === 'approve' || answer === 'reject') { decision = answer; break; }
        // Anything else — a typo, a truncated write, a mismatched id — is
        // not an approval. Keep waiting.
        await sleep(pollMs);
      }

      if (decision === null) decision = 'reject';   // timed out — fail closed

      transport.clear();
    } catch (err) {
      // A broken transport is not an answer either. Whatever step it broke
      // on — publishing, polling, or cleaning up after a genuine decision —
      // this must resolve 'reject' rather than let the exception escape as
      // a rejected promise, which a careless caller could catch and treat
      // as "proceed". Fail closed applies even to a transport that misbehaves
      // only on its way out.
      decision = 'reject';
      audit?.record({
        type: 'gate_transport_error',
        verb, target,
        message: String((err && err.message) || err)
      });
    }

    audit?.record({ type: 'gate_decided', verb, target, decision });
    return decision;
  }

  return { request };
}

/** Filesystem transport: writes a pending file, watches for a decision file. */
export function createFileTransport({ pendingPath, decisionPath }) {
  if (!pendingPath || !decisionPath) {
    throw new Error('createFileTransport needs pendingPath and decisionPath');
  }
  mkdirSync(path.dirname(pendingPath), { recursive: true });
  mkdirSync(path.dirname(decisionPath), { recursive: true });

  return {
    publish(pending) {
      writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n');
    },
    // expectedId is optional so a caller polling outside a gate (or an
    // older caller) still gets the old, unlabelled behaviour: a decision
    // with no id matches a poll with no expected id.
    poll(expectedId) {
      if (!existsSync(decisionPath)) return null;
      try {
        const d = JSON.parse(readFileSync(decisionPath, 'utf8'));
        if (d.id !== expectedId) return null;   // not an answer to THIS request
        return d.decision === 'approve' || d.decision === 'reject' ? d.decision : null;
      } catch {
        return null;      // torn write; try again next tick
      }
    },
    clear() {
      rmSync(decisionPath, { force: true });
      rmSync(pendingPath, { force: true });
    }
  };
}
