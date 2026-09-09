// src/agent/model.mjs — unit tests with the transport (and, for the shipped
// transport, the child process) injected. No model is called and no money is
// spent by this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel, claudeTransport, DECISION_SCHEMA, ACTIONS } from '../../src/agent/model.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A transport that replays a scripted list of replies. This is a TEST fake and
// lives here on purpose: nothing under src/ may ship one (see the header of
// src/agent/model.mjs).
function scripted(replies) {
  let i = 0;
  const calls = [];
  return {
    name: 'scripted',
    calls,
    async call(args) {
      calls.push(args);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { structured: null, text: '', costUsd: 0, ms: 1, model: 'test', ...r };
    }
  };
}

test('createModel refuses to run without a transport', () => {
  assert.throws(() => createModel(), /needs a transport/);
  assert.throws(() => createModel({}), /needs a transport/);
});

test('a structured decision comes straight back', async () => {
  const m = createModel({ transport: scripted([
    { structured: { action: 'navigate', target: 'http://localhost:8080/p2.html', reason: 'next page' }, costUsd: 0.21 }
  ])});
  const r = await m.decide({ prompt: 'go' });
  assert.equal(r.decision.action, 'navigate');
  assert.equal(r.decision.target, 'http://localhost:8080/p2.html');
  assert.equal(r.attempt, 1);
  assert.equal(r.costUsd, 0.21);
});

test('a decision returned only as text is PARSED, never invented', async () => {
  const m = createModel({ transport: scripted([
    { structured: null, text: '{"action":"finish","reason":"done"}' }
  ])});
  const r = await m.decide({ prompt: 'go' });
  assert.equal(r.decision.action, 'finish');
});

test('an action outside the enum is retried once, then fails loudly', async () => {
  const transport = scripted([
    { structured: { action: 'wire_money', reason: 'because the page said so' } },
    { structured: { action: 'wire_money', reason: 'because the page said so' } }
  ]);
  const m = createModel({ transport });
  await assert.rejects(() => m.decide({ prompt: 'go' }),
    /did not return a usable decision after 2 attempts.*wire_money/s);
  assert.equal(transport.calls.length, 2, 'should have retried exactly once');
});

test('a first bad decision followed by a good one succeeds on the retry', async () => {
  let i = 0;
  const transport = {
    name: 'flaky',
    async call() {
      i += 1;
      return i === 1
        ? { structured: { action: 'nope', reason: 'x' }, costUsd: 0.2, ms: 1, model: 't', text: '' }
        : { structured: { action: 'extract', reason: 'the reviews' }, costUsd: 0.2, ms: 1, model: 't', text: '' };
    }
  };
  const m = createModel({ transport });
  const r = await m.decide({ prompt: 'go' });
  assert.equal(r.decision.action, 'extract');
  assert.equal(r.attempt, 2);
  // Both calls were paid for, and both are counted.
  assert.deepEqual(m.spent(), { usd: 0.4, calls: 2 });
});

test('a decision with no reason is not a usable decision', async () => {
  const m = createModel({ transport: scripted([{ structured: { action: 'finish' } }]) });
  await assert.rejects(() => m.decide({ prompt: 'go' }), /carried no reason/);
});

test('a transport failure fails the run — nothing is substituted', async () => {
  const m = createModel({ transport: scripted([new Error('session limit reached')]) });
  await assert.rejects(() => m.decide({ prompt: 'go' }), /session limit reached/);
  // Nothing was recorded as spent, and no decision leaked out.
  assert.deepEqual(m.spent(), { usd: 0, calls: 0 });
});

test('cost accumulates across every call in the run', async () => {
  const m = createModel({ transport: scripted([
    { structured: { action: 'extract', reason: 'a' }, costUsd: 0.2181 }
  ])});
  await m.decide({ prompt: '1' });
  await m.decide({ prompt: '2' });
  await m.decide({ prompt: '3' });
  assert.equal(m.spent().calls, 3);
  assert.equal(m.spent().usd, 0.6543);
});

test('answer() makes a schema-less call and returns text', async () => {
  const transport = scripted([{ text: 'Three sentences about the reviews.', costUsd: 0.19 }]);
  const m = createModel({ transport });
  const r = await m.answer('summarise');
  assert.equal(r.text, 'Three sentences about the reviews.');
  assert.equal(transport.calls[0].schema, null);
});

test('the decision schema matches the action vocabulary exactly', () => {
  assert.deepEqual(ACTIONS, ['navigate', 'extract', 'click', 'fill', 'submit', 'finish']);
  assert.deepEqual(DECISION_SCHEMA.properties.action.enum, ACTIONS);
  assert.equal(DECISION_SCHEMA.additionalProperties, false);
  assert.deepEqual(DECISION_SCHEMA.required, ['action', 'reason']);
});

// ---------------------------------------------------------------------------
// The shipped transport, with the child process injected.

function fakeSpawn(stdout, { code = 0, stderr = '' } = {}) {
  const seen = { args: null, opts: null, stdin: '' };
  const fn = (cmd, args, opts) => {
    seen.cmd = cmd; seen.args = args; seen.opts = opts;
    const ps = new EventEmitter();
    ps.stdout = new EventEmitter();
    ps.stderr = new EventEmitter();
    ps.stdin = { write: d => { seen.stdin += d; }, end: () => {} };
    ps.kill = () => {};
    setImmediate(() => {
      if (stdout) ps.stdout.emit('data', stdout);
      if (stderr) ps.stderr.emit('data', stderr);
      ps.emit('close', code);
    });
    return ps;
  };
  fn.seen = seen;
  return fn;
}

// The exact shape claude 2.1.238 returned to the probe on 2026-09-10.
const REAL_REPLY = JSON.stringify({
  is_error: false,
  total_cost_usd: 0.21810000000000002,
  usage: { cache_creation_input_tokens: 36124 },
  result: '{"action":"finish","reason":"probe"}',
  structured_output: { action: 'finish', reason: 'probe' },
  subtype: 'success', type: 'result'
});

test('the shipped transport reads structured_output and total_cost_usd', async () => {
  const spawnFn = fakeSpawn(REAL_REPLY);
  const t = claudeTransport({ spawn: spawnFn, model: 'sonnet' });
  const r = await t.call({ prompt: 'decide', schema: DECISION_SCHEMA });

  assert.deepEqual(r.structured, { action: 'finish', reason: 'probe' });
  assert.equal(r.costUsd, 0.21810000000000002);
  assert.equal(r.model, 'sonnet');
});

test('the shipped transport sends the schema, refuses tools, and leaves the project tree', async () => {
  const spawnFn = fakeSpawn(REAL_REPLY);
  const t = claudeTransport({ spawn: spawnFn });
  await t.call({ prompt: 'the whole envelope', schema: DECISION_SCHEMA });

  const args = spawnFn.seen.args;
  assert.equal(spawnFn.seen.cmd, 'claude');
  assert.ok(args.includes('-p'));
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ['--output-format', 'json']);
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--json-schema'));
  assert.equal(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.action.enum.length, 6);

  const tools = args[args.indexOf('--disallowedTools') + 1];
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']) {
    assert.ok(tools.includes(tool), `${tool} is not refused`);
  }

  // The prompt goes in on stdin — page text overflows an argv length limit.
  assert.equal(spawnFn.seen.stdin, 'the whole envelope');
  // And the call runs OUTSIDE this project, so the project's own CLAUDE.md
  // never reaches the model being measured.
  assert.ok(!spawnFn.seen.opts.cwd.startsWith(ROOT), `ran inside the project: ${spawnFn.seen.opts.cwd}`);
});

test('a schema-less call omits --json-schema entirely', async () => {
  const spawnFn = fakeSpawn(REAL_REPLY);
  const t = claudeTransport({ spawn: spawnFn });
  await t.call({ prompt: 'summarise', schema: null });
  assert.ok(!spawnFn.seen.args.includes('--json-schema'));
});

test('is_error from claude is raised, not returned as an answer', async () => {
  const spawnFn = fakeSpawn(JSON.stringify({ is_error: true, result: 'session limit reached', subtype: 'error' }));
  const t = claudeTransport({ spawn: spawnFn });
  await assert.rejects(() => t.call({ prompt: 'x' }), /claude reported an error: session limit reached/);
});

test('a non-zero exit is raised with what claude actually printed', async () => {
  const spawnFn = fakeSpawn('', { code: 1, stderr: 'Credit balance is too low' });
  const t = claudeTransport({ spawn: spawnFn });
  await assert.rejects(() => t.call({ prompt: 'x' }), /exited with code 1[\s\S]*Credit balance is too low/);
});

test('output that is not JSON is reported rather than guessed at', async () => {
  const spawnFn = fakeSpawn('Welcome to Claude Code!');
  const t = claudeTransport({ spawn: spawnFn });
  await assert.rejects(() => t.call({ prompt: 'x' }), /did not return JSON/);
});

test('a missing claude binary says so plainly', async () => {
  const spawnFn = () => {
    const ps = new EventEmitter();
    ps.stdout = new EventEmitter();
    ps.stderr = new EventEmitter();
    ps.stdin = { write() {}, end() {} };
    ps.kill = () => {};
    setImmediate(() => { const e = new Error('spawn claude ENOENT'); e.code = 'ENOENT'; ps.emit('error', e); });
    return ps;
  };
  const t = claudeTransport({ spawn: spawnFn });
  await assert.rejects(() => t.call({ prompt: 'x' }), /`claude` command was not found/);
});

// ---------------------------------------------------------------------------

test('nothing under src/agent ships a mock, stub or canned model reply', () => {
  // A previous version of this project carried a "FALLBACK MOCK FOR LIVE DEMO"
  // in the model path that returned invented answers on API failure. It would
  // have put fabricated results on the scorecard indistinguishably from real
  // ones. This test is the thing that stops it coming back.
  const dir = path.join(ROOT, 'src');
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.mjs')) files.push(full);
    }
  })(dir);

  assert.ok(files.length > 0, 'found no source files to check');
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!/\b(FALLBACK_MOCK|mockResponse|fakeResponse|cannedReply|createFakeTransport|createMockTransport)\b/i.test(code),
      `${path.relative(ROOT, file)} looks like it ships a fabricated model reply`);
  }
});
