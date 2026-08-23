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

// --- Fix round 1 -----------------------------------------------------------
//
// Finding 1 (Critical): a decision must be bound to the request awaiting it.
// Without that binding, two agent processes sharing one file transport can
// cross wires — a human approves the action they can currently see, and
// BOTH the request they saw and some other in-flight request accept that
// same answer. The fix: publish() carries an id, poll(expectedId) only
// returns a decision whose id matches, and a decision with no id at all
// never matches a real request.

test("a decision naming an earlier request is not accepted by a later request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-gate-'));
  const pendingPath = path.join(dir, 'pending.json');
  const decisionPath = path.join(dir, 'decision.json');
  const transport = createFileTransport({ pendingPath, decisionPath });

  // A decision naming an earlier, unrelated request is already sitting on
  // disk when this request starts — for example two agent processes
  // sharing one transport, or a decision left over from a run that crashed
  // before its own cleanup ran.
  writeFileSync(decisionPath, JSON.stringify({ id: 'earlier-request', decision: 'approve' }));

  let elapsed = 0;
  const gate = createGate({
    transport,
    timeoutMs: 50,
    sleep: () => { elapsed += 25; return Promise.resolve(); },
    clock: () => elapsed
  });

  // This request's own id (derived from clock()) will never equal
  // 'earlier-request'. The leftover decision must be ignored, and with
  // nothing else ever answering, this must time out to reject rather than
  // silently inherit an approval that was never actually given to it.
  const decision = await gate.request({ verb: 'delete', target: 'account', summary: 's' });
  assert.equal(decision, 'reject', 'a decision meant for a different request must not be accepted');

  rmSync(dir, { recursive: true, force: true });
});

test('a decision with no id at all is not accepted', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-gate-'));
  const pendingPath = path.join(dir, 'pending.json');
  const decisionPath = path.join(dir, 'decision.json');
  const transport = createFileTransport({ pendingPath, decisionPath });

  writeFileSync(decisionPath, JSON.stringify({ decision: 'approve' }));   // no id field

  let elapsed = 0;
  const gate = createGate({
    transport,
    timeoutMs: 50,
    sleep: () => { elapsed += 25; return Promise.resolve(); },
    clock: () => elapsed
  });

  const decision = await gate.request({ verb: 'delete', target: 'account', summary: 's' });
  assert.equal(decision, 'reject', 'a decision with no id must never be treated as an answer to a real request');

  rmSync(dir, { recursive: true, force: true });
});

// Finding 2 (Important): a throwing transport must fail closed, not escape
// request() as a rejected promise — a caller that catches and continues
// would otherwise fail open.

test('a transport whose publish throws resolves reject, not a rejected promise', async () => {
  const events = [];
  const audit = { record: e => { events.push(e); return e; }, read: () => events };
  const t = {
    publish: () => { throw new Error('disk full'); },
    poll: () => null,
    clear: () => {}
  };
  const gate = createGate({ transport: t, timeoutMs: 1000, sleep: noSleep, audit });

  const decision = await gate.request({ verb: 'send', target: 'x', summary: 's' });
  assert.equal(decision, 'reject');

  const kinds = events.map(e => e.type);
  assert.ok(kinds.includes('gate_requested'), 'evidence that an approval was asked for must survive a transport failure');
  assert.ok(kinds.includes('gate_decided'));
  assert.equal(events.find(e => e.type === 'gate_decided').decision, 'reject');
});

test('a transport whose poll throws also fails closed', async () => {
  const t = {
    publish: () => {},
    poll: () => { throw new Error('boom'); },
    clear: () => {}
  };
  const gate = createGate({ transport: t, timeoutMs: 1000, sleep: noSleep });
  assert.equal(await gate.request({ verb: 'send', target: 'x', summary: 's' }), 'reject');
});

test('a transport that fails during cleanup after a genuine approval still fails closed', async () => {
  // A disk error while tidying up is not the same thing as "no one ever
  // touched the transport" — but it is still an anomaly in the one path
  // that is supposed to be the most trustworthy thing in the project, so
  // it is treated the same paranoid way as every other transport failure.
  const t = {
    publish: () => {},
    poll: () => 'approve',
    clear: () => { throw new Error('cannot delete'); }
  };
  const gate = createGate({ transport: t, timeoutMs: 1000, sleep: noSleep });
  assert.equal(await gate.request({ verb: 'send', target: 'x', summary: 's' }), 'reject');
});
