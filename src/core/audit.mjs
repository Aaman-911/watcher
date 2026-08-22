// WATCHER core — the audit log.
//
// Append-only, one JSON object per line. Never rewritten, never truncated.
//
// This is a product output, not a debug aid. The central claim of this
// project is that you can prove what a page attempted independently of what
// a model did. That claim is only worth something if the evidence outlives
// the run — including a run that crashed, timed out, or was killed.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const isoNow = () => new Date().toISOString();

/**
 * @param {{path: string, runId: string, clock?: () => string}} options
 */
export function createAudit({ path: file, runId, clock = isoNow }) {
  if (!file) throw new Error('createAudit needs a path');
  if (!runId) throw new Error('createAudit needs a runId');

  mkdirSync(path.dirname(file), { recursive: true });

  function record(event) {
    // The audit's own identity fields must always win over anything in the
    // caller's payload — an event carrying its own runId or at would
    // otherwise spoof which run it belongs to, or vanish from read()'s
    // runId filter. Spread the payload first so `at` and `runId` below
    // always overwrite whatever the caller supplied.
    const full = { ...event, at: clock(), runId };
    appendFileSync(file, JSON.stringify(full) + '\n');
    return full;
  }

  function read() {
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      // A killed process can leave a torn final line. One bad line must not
      // cost us the whole log.
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed && parsed.runId === runId) out.push(parsed);
    }
    return out;
  }

  return { record, read, runId, path: file };
}
