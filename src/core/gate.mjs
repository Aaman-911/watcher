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
// It FAILS CLOSED. No answer is not the same as yes.

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
    // A decision left on disk by an earlier run must never be mistaken for
    // an answer to this one.
    transport.clear();

    const pending = {
      id: String(clock()),
      requested_at: new Date().toISOString(),
      verb, target, summary, values
    };
    transport.publish(pending);
    audit?.record({ type: 'gate_requested', verb, target, summary, values });

    const started = clock();
    let decision = null;

    while (clock() - started < timeoutMs) {
      const answer = transport.poll();
      if (answer === 'approve' || answer === 'reject') { decision = answer; break; }
      // Anything else — a typo, a truncated write, a hostile value — is not
      // an approval. Keep waiting.
      await sleep(pollMs);
    }

    if (decision === null) decision = 'reject';   // fail closed

    transport.clear();
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
    poll() {
      if (!existsSync(decisionPath)) return null;
      try {
        const d = JSON.parse(readFileSync(decisionPath, 'utf8'));
        return d.decision === 'approve' || d.decision === 'reject' ? d.decision : null;
      } catch {
        return null;      // torn write; try again next tick
      }
    },
    clear() {
      if (existsSync(decisionPath)) rmSync(decisionPath);
      if (existsSync(pendingPath)) rmSync(pendingPath);
    }
  };
}
