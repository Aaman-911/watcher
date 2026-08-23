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

// --- Fix round 2 -----------------------------------------------------------
//
// Finding 1a (Important): the end-of-request clear() was still unconditional
// even after being moved to the end of request(). Sequence that broke: A
// publishes; B publishes, overwriting the pending file; a human approves B;
// A then times out on its own schedule and its clear() deletes BOTH files —
// destroying B's genuine approval before B's own poll loop can observe it.
// Fix: clear() is scoped to the request's own id — it only removes a pending
// or decision record that actually belongs to it.
//
// Finding 1b (Important): id = String(clock()) let two requests created
// within the same millisecond collide on id, which reopens the Critical from
// round 1 (a decision meant for one request being accepted by another). Fix:
// a module-level monotonic counter combined with the clock value.

test('two requests created in the same clock tick receive different ids, and a decision naming the first is not accepted by the second', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-gate-'));
  const pendingPath = path.join(dir, 'pending.json');
  const decisionPath = path.join(dir, 'decision.json');

  // Two separate gates, each with its OWN elapsed counter starting at 0 —
  // this pins both requests' id-generating clock() call to the exact same
  // value, simulating two requests created within the same millisecond.
  let idA;
  {
    let elapsed = 0;
    const t = { publish: p => { idA = p.id; }, poll: () => null, clear: () => {} };
    const gate = createGate({
      transport: t, timeoutMs: 10,
      sleep: () => { elapsed += 25; return Promise.resolve(); },
      clock: () => elapsed
    });
    await gate.request({ verb: 'send', target: 'a', summary: 's' });
  }

  let idB;
  {
    let elapsed = 0;
    const t = { publish: p => { idB = p.id; }, poll: () => null, clear: () => {} };
    const gate = createGate({
      transport: t, timeoutMs: 10,
      sleep: () => { elapsed += 25; return Promise.resolve(); },
      clock: () => elapsed
    });
    await gate.request({ verb: 'send', target: 'b', summary: 's' });
  }

  assert.ok(idA, 'request A should have published an id');
  assert.ok(idB, 'request B should have published an id');
  assert.notEqual(idA, idB, 'two requests created under the same clock value must still receive different ids');

  // Now prove the distinct id actually matters: a decision naming A's id,
  // already sitting on disk before a fresh request starts, must not be
  // accepted just because the clock tick is identical.
  const transport = createFileTransport({ pendingPath, decisionPath });
  writeFileSync(decisionPath, JSON.stringify({ id: idA, decision: 'approve' }));

  let elapsed = 0;
  const gate = createGate({
    transport, timeoutMs: 50,
    sleep: () => { elapsed += 25; return Promise.resolve(); },
    clock: () => elapsed
  });
  const decision = await gate.request({ verb: 'delete', target: 'account', summary: 's' });
  assert.equal(decision, 'reject', "a decision naming a different request's id must not be accepted even under a colliding clock value");

  rmSync(dir, { recursive: true, force: true });
});

// Reworked in fix round 3. The first version of this test (above pattern:
// A timeoutMs=50 / two 25ms ticks, B timeoutMs=200 / same 25ms ticks) was
// genuinely concurrent but did not land in the vulnerable window: B wrote
// AND observed AND self-cleared its own decision on its first two ticks,
// which finished strictly before A's second tick (A's own timeout). So by
// the time A's clear() ever ran, B's files were already gone — clear()'s
// id-scoping was never actually exercised, and reverting it left this test
// passing 5/5. Caught by the reviewer reverting the fix in isolation.
//
// The fix: make A time out in exactly ONE tick (timeoutMs equals a single
// sleep increment), so A's end-of-request clear() fires on A's very first
// resumption — before B, which is still suspended inside its own first
// sleep call, ever gets a chance to poll for (and therefore clear) the
// decision it just wrote. That is the actual window Finding 1a describes.
test('two genuinely concurrent requests on one shared transport: an earlier request timing out does not destroy a later request\'s still-unconsumed real approval', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-gate-'));
  const pendingPath = path.join(dir, 'pending.json');
  const decisionPath = path.join(dir, 'decision.json');
  const transport = createFileTransport({ pendingPath, decisionPath });

  // Request A: published first, never answered, and times out in exactly
  // ONE poll tick — timeoutMs equals one sleep increment, so its loop
  // condition (clock() - started < timeoutMs) is already false the moment
  // it resumes from its first (and only) sleep, with no second poll.
  let elapsedA = 0;
  const gateA = createGate({
    transport, timeoutMs: 25,
    sleep: () => { elapsedA += 25; return Promise.resolve(); },
    clock: () => elapsedA
  });
  const promiseA = gateA.request({ verb: 'delete', target: 'accountA', summary: 's' });
  // gateA.request() runs synchronously up to its first `await sleep(...)`,
  // so by this point A has already published and done its first (null)
  // poll — it is genuinely in flight, suspended mid-poll-loop, NOT awaited
  // to completion.

  // Request B: started without awaiting A first. Publishing overwrites A's
  // pending file, exactly as the finding describes. B's own decision is
  // written to disk during its first sleep call — standing in for a human
  // approving what they can actually see on screen — but B does not get to
  // POLL for it (and therefore cannot clear it) until its NEXT resumption.
  // B's timeout (200ms) is generous on purpose: this test is about what A
  // does while B is still waiting, not about racing B's own deadline.
  let elapsedB = 0;
  let bAnswered = false;
  const gateB = createGate({
    transport, timeoutMs: 200,
    sleep: () => {
      elapsedB += 25;
      if (!bAnswered) {
        bAnswered = true;
        const idB = JSON.parse(readFileSync(pendingPath, 'utf8')).id;
        writeFileSync(decisionPath, JSON.stringify({ id: idB, decision: 'approve' }));
      }
      return Promise.resolve();
    },
    clock: () => elapsedB
  });
  const promiseB = gateB.request({ verb: 'delete', target: 'accountB', summary: 's' });

  // Traced execution order (A suspended first, so its continuation is
  // queued first and microtasks drain FIFO): A resumes, its loop condition
  // is now false (25 < 25 is false), so it rejects and runs clear('A')
  // immediately — while decisionPath still holds B's untouched, unread
  // approval and pendingPath still holds B's untouched pending record.
  // Only AFTER that does B get to resume, poll, find its own approval
  // still intact, and clear it itself. This is the exact ordering Finding
  // 1a describes, not a coincidence of `await Promise.all`.
  const [decisionA, decisionB] = await Promise.all([promiseA, promiseB]);

  assert.equal(decisionA, 'reject', 'A never received an answer meant for it and must time out');
  assert.equal(decisionB, 'approve', "B's genuine human approval must survive A's end-of-request cleanup, even though A's clear() ran while B's decision was still on disk, unread and uncleared");

  rmSync(dir, { recursive: true, force: true });
});

// --- Fix round 3 -----------------------------------------------------------
//
// Finding A (Critical): the round-1 id binding broke the real approval path
// end to end, and no core test could catch it, because server.mjs and
// ui/approve.html sit outside core's test surface. ui/approve.html posted
// {decision} only; server.mjs's POST /gate/decide wrote {decision,
// decided_at} — no id — to gate-decision.json; and poll(expectedId) treats
// any decision whose id doesn't match (including a missing id, which never
// equals a real request's id) as no answer at all. So every real approval
// silently timed out and rejected. Fixed in server.mjs (POST /gate/decide
// now requires and persists id, refusing the request with 400 if it's
// missing) and ui/approve.html (now sends the id it read from GET
// /gate/pending). These two tests pin the file CONTRACT the server writes
// — the server itself is not started here, per the brief.

test('the file transport accepts a decision shaped exactly like what the server now writes (id, decision, decided_at)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-gate-'));
  const pendingPath = path.join(dir, 'pending.json');
  const decisionPath = path.join(dir, 'decision.json');
  const transport = createFileTransport({ pendingPath, decisionPath });

  transport.publish({ id: 'req-42', verb: 'send', target: 'a@b.test', requested_at: 'now' });

  // Exactly the shape POST /gate/decide writes after this fix: the id read
  // back from GET /gate/pending, plus decision and decided_at.
  writeFileSync(decisionPath, JSON.stringify({
    id: 'req-42', decision: 'approve', decided_at: new Date().toISOString()
  }));

  assert.equal(transport.poll('req-42'), 'approve');

  rmSync(dir, { recursive: true, force: true });
});

test('a server-shaped decision missing its id is not accepted — the exact shape that made the real approval path dead', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-gate-'));
  const pendingPath = path.join(dir, 'pending.json');
  const decisionPath = path.join(dir, 'decision.json');
  const transport = createFileTransport({ pendingPath, decisionPath });

  transport.publish({ id: 'req-42', verb: 'send', target: 'a@b.test', requested_at: 'now' });

  // Before this fix, this was literally what server.mjs wrote for every
  // single approval a human clicked: {decision, decided_at}, no id at all.
  // poll(id) must not treat this as an answer to a real, id-bearing request.
  writeFileSync(decisionPath, JSON.stringify({
    decision: 'approve', decided_at: new Date().toISOString()
  }));

  assert.equal(transport.poll('req-42'), null);

  rmSync(dir, { recursive: true, force: true });
});
