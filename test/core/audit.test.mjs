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

test('read returns empty when the file does not exist yet', () => {
  const { dir, file } = tmpFile();
  const audit = createAudit({ path: file, runId: 'run-5' });
  assert.deepEqual(audit.read(), []);
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
