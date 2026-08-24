import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAudit } from '../../src/core/audit.mjs';

function tmpFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-audit-'));
  return { dir, file: path.join(dir, 'audit.jsonl') };
}

test('record appends one json line per event', () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-1', clock: () => '2026-01-01T00:00:00.000Z' });

  audit.record({ type: 'page_read', url: 'http://localhost/a' });
  audit.record({ type: 'finding', pattern: 'fake role marker' });

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), {
    at: '2026-01-01T00:00:00.000Z', runId: 'run-1', type: 'page_read', url: 'http://localhost/a'
  });
  rmSync(dir, { recursive: true, force: true });
});

test('record returns the event it wrote', () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-2', clock: () => '2026-01-01T00:00:00.000Z' });
  const ev = audit.record({ type: 'gate_decision', decision: 'reject' });
  assert.equal(ev.runId, 'run-2');
  assert.equal(ev.at, '2026-01-01T00:00:00.000Z');
  assert.equal(ev.decision, 'reject');
  rmSync(dir, { recursive: true, force: true });
});

test('read returns only this run\'s events', () => {
  const { dir, file } = tmpFile();
  const a = createAudit({ path: file, runId: 'run-A', clock: () => '2026-01-01T00:00:00.000Z' });
  const b = createAudit({ path: file, runId: 'run-B', clock: () => '2026-01-01T00:00:00.000Z' });
  a.record({ type: 'x' });
  b.record({ type: 'y' });
  a.record({ type: 'z' });

  assert.deepEqual(a.read().map(e => e.type), ['x', 'z']);
  assert.deepEqual(b.read().map(e => e.type), ['y']);
  rmSync(dir, { recursive: true, force: true });
});

test('the log is append-only — earlier lines are never rewritten', () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-3', clock: () => '2026-01-01T00:00:00.000Z' });
  audit.record({ type: 'first' });
  const afterFirst = readFileSync(file, 'utf8');
  audit.record({ type: 'second' });
  const afterSecond = readFileSync(file, 'utf8');
  assert.ok(afterSecond.startsWith(afterFirst), 'existing content must be a prefix of the new content');
  rmSync(dir, { recursive: true, force: true });
});

test('a corrupt line does not break read', async () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-4', clock: () => '2026-01-01T00:00:00.000Z' });
  audit.record({ type: 'good' });
  // Simulate a torn write from a killed process.
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, '{"runId":"run-4","type":"tor\n');
  audit.record({ type: 'also_good' });
  assert.deepEqual(audit.read().map(e => e.type), ['good', 'also_good']);
  rmSync(dir, { recursive: true, force: true });
});

// Final review MF1. The torn line above ended in a newline, so it was one
// bad line and cost one bad line. A process killed part-way through an
// append leaves NO trailing newline, and the next record() used to
// concatenate straight onto that fragment — making one unparseable line out
// of the torn write AND the good event written after it. The event lost was
// one recorded during recovery, which is precisely the evidence this log
// exists to keep.

test('a torn final line with no trailing newline does not swallow the next event', async () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-7', clock: () => '2026-01-01T00:00:00.000Z' });
  audit.record({ type: 'before_the_crash' });

  // A killed process: half an event, no newline.
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, '{"runId":"run-7","type":"tor');

  audit.record({ type: 'after_the_crash' });

  assert.deepEqual(audit.read().map(e => e.type), ['before_the_crash', 'after_the_crash']);

  // The torn fragment is still on disk, untouched, on a line of its own.
  const lines = readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[1], '{"runId":"run-7","type":"tor');
  rmSync(dir, { recursive: true, force: true });
});

test('closing off a torn line is still append-only', async () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-8', clock: () => '2026-01-01T00:00:00.000Z' });
  audit.record({ type: 'first' });
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, '{"runId":"run-8","half');
  const beforeRecovery = readFileSync(file, 'utf8');

  audit.record({ type: 'second' });

  const afterRecovery = readFileSync(file, 'utf8');
  assert.ok(afterRecovery.startsWith(beforeRecovery),
    'existing content, torn line included, must be a prefix of the new content');
  rmSync(dir, { recursive: true, force: true });
});

test('a healthy log gains no blank lines from the torn-write guard', () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-9', clock: () => '2026-01-01T00:00:00.000Z' });
  audit.record({ type: 'a' });
  audit.record({ type: 'b' });
  audit.record({ type: 'c' });
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(l => l !== '').length, 3);
  assert.deepEqual(audit.read().map(e => e.type), ['a', 'b', 'c']);
  rmSync(dir, { recursive: true, force: true });
});

test('read returns empty when the file does not exist yet', () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-5' });
  assert.deepEqual(audit.read(), []);
  rmSync(dir, { recursive: true, force: true });
});

// Final review H1: the spec publishes `audit.read({ runId })`, and read()
// used to take no argument at all — so read({runId:'someone-else'}) returned
// THIS run's events, which is worse than an error.

test('read({ runId }) reads the run it was asked for', () => {
  const { dir, file } = tmpFile();
  const a = createAudit({ path: file, runId: 'run-A', clock: () => '2026-01-01T00:00:00.000Z' });
  const b = createAudit({ path: file, runId: 'run-B', clock: () => '2026-01-01T00:00:00.000Z' });
  a.record({ type: 'x' });
  b.record({ type: 'y' });
  a.record({ type: 'z' });

  assert.deepEqual(a.read({ runId: 'run-B' }).map(e => e.type), ['y']);
  assert.deepEqual(b.read({ runId: 'run-A' }).map(e => e.type), ['x', 'z']);
  rmSync(dir, { recursive: true, force: true });
});

test('read({ runId }) for a run with nothing in the log returns empty', () => {
  const { dir, file } = tmpFile();
  const a = createAudit({ path: file, runId: 'run-A', clock: () => '2026-01-01T00:00:00.000Z' });
  a.record({ type: 'x' });
  assert.deepEqual(a.read({ runId: 'no-such-run' }), []);
  rmSync(dir, { recursive: true, force: true });
});

test('read defaults to this audit\'s own runId', () => {
  const { dir, file } = tmpFile();
  const a = createAudit({ path: file, runId: 'run-A', clock: () => '2026-01-01T00:00:00.000Z' });
  const b = createAudit({ path: file, runId: 'run-B', clock: () => '2026-01-01T00:00:00.000Z' });
  a.record({ type: 'x' });
  b.record({ type: 'y' });

  // No argument, an empty object, and an explicit undefined runId all mean
  // "my own run".
  assert.deepEqual(a.read().map(e => e.type), ['x']);
  assert.deepEqual(a.read({}).map(e => e.type), ['x']);
  assert.deepEqual(a.read({ runId: undefined }).map(e => e.type), ['x']);
  rmSync(dir, { recursive: true, force: true });
});

test('a spoofed runId or at in the payload cannot override the audit\'s own identity', () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-6', clock: () => '2026-01-01T00:00:00.000Z' });

  const ev = audit.record({ type: 'x', runId: 'spoofed-run', at: 'SPOOFED' });

  // The returned event must carry the audit's real identity, not the
  // payload's.
  assert.equal(ev.runId, 'run-6');
  assert.equal(ev.at, '2026-01-01T00:00:00.000Z');

  // The read-back path is what actually matters: a payload runId must not
  // cause the event to vanish from this run's log (nor surface under
  // whatever run 'spoofed-run' might belong to).
  const readBack = audit.read();
  assert.equal(readBack.length, 1);
  assert.equal(readBack[0].runId, 'run-6');
  assert.equal(readBack[0].at, '2026-01-01T00:00:00.000Z');
  assert.equal(readBack[0].type, 'x');

  rmSync(dir, { recursive: true, force: true });
});
