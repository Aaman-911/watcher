// WATCHER core — the audit log.
//
// Append-only, one JSON object per line. Never rewritten, never truncated.
//
// This is a product output, not a debug aid. The central claim of this
// project is that you can prove what a page attempted independently of what
// a model did. That claim is only worth something if the evidence outlives
// the run — including a run that crashed, timed out, or was killed.

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync
} from 'node:fs';
import path from 'node:path';

const isoNow = () => new Date().toISOString();

const NEWLINE = 0x0a;

// True when the log already has content whose last byte is not a newline —
// i.e. a torn final line, left by a process killed part-way through an
// append.
//
// Without this check the next record() concatenates onto that fragment and
// produces ONE unparseable line, so read()'s per-line try/catch discards
// both the torn fragment AND the good event written after it. Losing
// evidence recorded during recovery is exactly the failure this log exists
// to survive, so a torn line is closed off with a newline before the next
// event is appended. Nothing already on disk is read back into memory,
// rewritten, or truncated — one byte is appended, and the file stays
// append-only.
function endsMidLine(file) {
  if (!existsSync(file)) return false;
  let fd;
  try {
    const size = statSync(file).size;
    if (size === 0) return false;
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(1);
    const got = readSync(fd, buf, 0, 1, size - 1);
    return got === 1 && buf[0] !== NEWLINE;
  } catch {
    // If the last byte cannot be read, do not guess: appending a newline to
    // a file we could not inspect is the riskier of the two mistakes.
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * @param {{path: string, runId: string, clock?: () => string}} options
 * @returns {{record: (event: object) => object,
 *            read: (query?: {runId?: string}) => object[],
 *            runId: string, path: string}}
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
    const prefix = endsMidLine(file) ? '\n' : '';
    appendFileSync(file, prefix + JSON.stringify(full) + '\n');
    return full;
  }

  // read({ runId }) — the signature the spec publishes (§3.6). The runId is
  // optional and defaults to this audit's own, which is what every current
  // caller wants; passing another run's id reads that run's events out of
  // the same log, which is legitimately useful when several runs share a
  // file. Before this took its argument it silently ignored it, so
  // read({runId:'other'}) confidently returned THIS run's events — a
  // consumer following the published API got the wrong data with no error.
  function read({ runId: wanted = runId } = {}) {
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      // A killed process can leave a torn final line. One bad line must not
      // cost us the whole log.
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed && parsed.runId === wanted) out.push(parsed);
    }
    return out;
  }

  return { record, read, runId, path: file };
}
