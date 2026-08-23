import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGate, createFileTransport } from '../../src/core/gate.mjs';

// A transport that answers immediately, so tests never wait on wall clock.
function scriptedTransport(answers) {
  const published = [];
  let i = 0;
  return {
    published,
    publish: p => { published.push(p); },
    poll: () => (i < answers.length ? answers[i++] : null),
    clear: () => {}
  };
}

const noSleep = () => Promise.resolve();

test('an approval is returned', async () => {
  const t = scriptedTransport(['approve']);
  const gate = createGate({ transport: t, timeoutMs: 1000, sleep: noSleep });
  assert.equal(await gate.request({ verb: 'send', target: 'a@b.test', summary: 's' }), 'approve');
});

test('a rejection is returned', async () => {
  const t = scriptedTransport(['reject']);
  const gate = createGate({ transport: t, timeoutMs: 1000, sleep: noSleep });
  assert.equal(await gate.request({ verb: 'send', target: 'a@b.test', summary: 's' }), 'reject');
});

test('the pending action is published with all its detail', async () => {
  const t = scriptedTransport(['approve']);
  const gate = createGate({ transport: t, timeoutMs: 1000, sleep: noSleep });
  await gate.request({ verb: 'send', target: 'a@b.test', summary: 'Forward transcript', values: { page: 'x' } });
  assert.equal(t.published.length, 1);
  assert.equal(t.published[0].verb, 'send');
  assert.equal(t.published[0].target, 'a@b.test');
  assert.equal(t.published[0].summary, 'Forward transcript');
  assert.deepEqual(t.published[0].values, { page: 'x' });
  assert.ok(t.published[0].requested_at, 'should carry a timestamp');
});

test('NO ANSWER FAILS CLOSED — silence is a reject, never an approve', async () => {
  const t = scriptedTransport([]);                    // never answers
  let elapsed = 0;
  const gate = createGate({
    transport: t,
    timeoutMs: 50,
    sleep: () => { elapsed += 25; return Promise.resolve(); },
    clock: () => elapsed
  });
  assert.equal(await gate.request({ verb: 'send', target: 'x', summary: 's' }), 'reject');
});

test('an unrecognised decision value is treated as a reject', async () => {
  const t = scriptedTransport(['maybe', 'yes', 'APPROVE_PLEASE']);
  let elapsed = 0;
  const gate = createGate({
    transport: t,
    timeoutMs: 50,
    sleep: () => { elapsed += 25; return Promise.resolve(); },
    clock: () => elapsed
  });
  assert.equal(await gate.request({ verb: 'send', target: 'x', summary: 's' }), 'reject');
});

test('a decision left over from a previous run is not reused', async () => {
  const cleared = [];
  const t = {
    publish: () => {},
    poll: () => 'approve',
    clear: () => cleared.push(true)
  };
  const gate = createGate({ transport: t, timeoutMs: 1000, sleep: noSleep });
  await gate.request({ verb: 'send', target: 'x', summary: 's' });
  assert.equal(cleared.length >= 1, true, 'the gate must clear stale decisions before publishing');
});

test('the decision is recorded to the audit log when one is supplied', async () => {
  const events = [];
  const audit = { record: e => { events.push(e); return e; }, read: () => events };
  const t = scriptedTransport(['reject']);
  const gate = createGate({ transport: t, timeoutMs: 1000, sleep: noSleep, audit });
  await gate.request({ verb: 'delete', target: 'account', summary: 's' });
  const kinds = events.map(e => e.type);
  assert.ok(kinds.includes('gate_requested'), `expected gate_requested in ${kinds}`);
  assert.ok(kinds.includes('gate_decided'), `expected gate_decided in ${kinds}`);
  assert.equal(events.find(e => e.type === 'gate_decided').decision, 'reject');
});

test('the file transport round-trips through the filesystem', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-gate-'));
  const pendingPath = path.join(dir, 'pending.json');
  const decisionPath = path.join(dir, 'decision.json');
  const transport = createFileTransport({ pendingPath, decisionPath });

  transport.publish({ verb: 'send', target: 'a@b.test', requested_at: 'now' });
  assert.ok(existsSync(pendingPath));
  assert.equal(JSON.parse(readFileSync(pendingPath, 'utf8')).verb, 'send');
  assert.equal(transport.poll(), null);

  writeFileSync(decisionPath, JSON.stringify({ decision: 'approve' }));
  assert.equal(transport.poll(), 'approve');

  transport.clear();
  assert.equal(existsSync(decisionPath), false);
  assert.equal(existsSync(pendingPath), false);

  rmSync(dir, { recursive: true, force: true });
});

test('the file transport survives a partially written decision file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-gate-'));
  const decisionPath = path.join(dir, 'decision.json');
  const transport = createFileTransport({
    pendingPath: path.join(dir, 'pending.json'), decisionPath
  });
  writeFileSync(decisionPath, '{"decision":"appro');
  assert.equal(transport.poll(), null, 'a torn write must read as no decision yet');
  rmSync(dir, { recursive: true, force: true });
});
