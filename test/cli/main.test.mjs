// src/cli/main.mjs — argument parsing, the empty-allowlist refusal, and the
// terminal gate transport. Nothing here launches a browser or calls a model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, createTerminalTransport, main } from '../../src/cli/main.mjs';

function capture() {
  const chunks = [];
  return { write: s => chunks.push(String(s)), text: () => chunks.join('') };
}

test('the url and the task are picked out of the argv', () => {
  const a = parseArgs(['http://localhost:8080/p1.html', '--task', 'summarise the reviews']);
  assert.equal(a.url, 'http://localhost:8080/p1.html');
  assert.equal(a.task, 'summarise the reviews');
  assert.equal(a.dryRun, false);
});

test('--allow is repeatable and builds the allowlist', () => {
  const a = parseArgs(['http://x/', '--task', 't', '--allow', 'localhost', '--allow', '*.corp.test']);
  assert.deepEqual(a.overrides.allowHosts, ['localhost', '*.corp.test']);
});

test('limits and options land in the overrides', () => {
  const a = parseArgs(['http://x/', '--task', 't', '--max-steps', '3', '--max-cost', '0.5',
                       '--model', 'opus', '--mode', 'tree', '--timeout', '1000', '--profile', 'p']);
  assert.equal(a.overrides.maxSteps, 3);
  assert.equal(a.overrides.maxCostUsd, 0.5);
  assert.equal(a.overrides.model, 'opus');
  assert.equal(a.overrides.snapshotMode, 'tree');
  assert.equal(a.overrides.approvalTimeoutMs, 1000);
  assert.equal(a.overrides.profile, 'p');
});

test('--dry-run and --json are flags', () => {
  const a = parseArgs(['http://x/', '--task', 't', '--dry-run', '--json']);
  assert.equal(a.dryRun, true);
  assert.equal(a.json, true);
});

test('an unknown option is an error, not something to ignore', () => {
  assert.throws(() => parseArgs(['http://x/', '--task', 't', '--yolo']), /unknown option "--yolo"/);
  assert.throws(() => parseArgs(['http://x/', '--task', 't', '--allow-credentials']), /unknown option/);
});

test('an option missing its value is an error', () => {
  assert.throws(() => parseArgs(['http://x/', '--task']), /--task needs a value/);
  assert.throws(() => parseArgs(['http://x/', '--allow']), /--allow needs a value/);
});

test('a second bare argument is an error rather than a silently dropped one', () => {
  assert.throws(() => parseArgs(['http://a/', 'http://b/', '--task', 't']), /unexpected argument/);
});

test('an empty allowlist stops the run before anything is fetched', async () => {
  const out = capture();
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-cli-'));
  try {
    const code = await main(['http://localhost:8080/p1.html', '--task', 'summarise'],
      { stdout: out, cwd: dir });
    assert.equal(code, 1);
    assert.match(out.text(), /allowlist is empty/);
    assert.match(out.text(), /nothing can be fetched/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a config error is reported and nothing runs', async () => {
  const out = capture();
  const dir = mkdtempSync(path.join(tmpdir(), 'watcher-cli-'));
  try {
    const code = await main(['http://localhost:8080/', '--task', 't', '--mode', 'screenshot'],
      { stdout: out, cwd: dir });
    assert.equal(code, 1);
    assert.match(out.text(), /snapshotMode must be read, tree or act/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing task or url prints usage rather than guessing', async () => {
  const out = capture();
  assert.equal(await main(['--help'], { stdout: out }), 0);
  assert.match(out.text(), /watcher <url> --task/);

  const out2 = capture();
  assert.equal(await main(['http://localhost:8080/'], { stdout: out2 }), 1);
  assert.match(out2.text(), /Give me a task/);
});

test('the help text does not advertise a switch that does not exist', async () => {
  const out = capture();
  await main(['--help'], { stdout: out });
  const help = out.text();
  assert.match(help, /no setting that disables the gate/);
  assert.ok(!/--no-gate|--skip-approval|--allow-credentials|--solve-captcha/.test(help));
});

// --- the terminal gate transport -------------------------------------------

test('the terminal transport reports only what a human actually typed', () => {
  const input = new EventEmitter();
  input.setEncoding = () => {};
  const out = capture();
  const t = createTerminalTransport({ input, output: out });

  t.publish({ id: 'r1', verb: 'buy', target: 'Place order', summary: 'a purchase', values: {} });
  assert.match(out.text(), /BLOCKED — this action needs a human/);

  // Nothing typed yet is not a yes.
  assert.equal(t.poll('r1'), null);

  input.emit('data', 'maybe\n');
  assert.equal(t.poll('r1'), null, 'a non-answer was read as an answer');

  input.emit('data', 'y\n');
  assert.equal(t.poll('r1'), 'approve');
});

test('an approval for one request is not an answer to another', () => {
  const input = new EventEmitter();
  input.setEncoding = () => {};
  const t = createTerminalTransport({ input, output: capture() });

  t.publish({ id: 'r1', verb: 'buy', target: 'x', summary: 's', values: {} });
  input.emit('data', 'y\n');
  assert.equal(t.poll('r1'), 'approve');
  // A different request in flight must not inherit it.
  assert.equal(t.poll('r2'), null);

  // And a new request starts from silence, not from the last answer.
  t.publish({ id: 'r3', verb: 'send', target: 'y', summary: 's', values: {} });
  assert.equal(t.poll('r3'), null);
});

test('"n" is a rejection and clear() forgets the answer', () => {
  const input = new EventEmitter();
  input.setEncoding = () => {};
  const t = createTerminalTransport({ input, output: capture() });
  t.publish({ id: 'r1', verb: 'send', target: 'x', summary: 's', values: {} });
  input.emit('data', 'no\n');
  assert.equal(t.poll('r1'), 'reject');
  t.clear('r1');
  assert.equal(t.poll('r1'), null);
});
