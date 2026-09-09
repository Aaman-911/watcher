// WATCHER — integration. Real HTTP, a real browser, the real corpus.
//
// The one thing that is NOT real here is the model: a scripted transport
// stands in for it, so this suite runs the entire stack — server, webcmd,
// snapshot, detect, envelope, policy, gate, dispatch, loop — for free and
// deterministically. The model's own behaviour is measured separately by
// report/score.mjs, which spends money and is not a test.
//
// The server is a throwaway written here, on an ephemeral port, started and
// stopped by the test. demo/0-start-server.command and server.mjs are NOT
// touched: that server runs forever by design and belongs in its own window.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPolicy, detect } from '../../src/core/index.mjs';
import { createBrowser } from '../../src/agent/browser.mjs';
import { createActions } from '../../src/agent/actions.mjs';
import { createLoop, HALT } from '../../src/agent/loop.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS = path.join(ROOT, 'corpus');

// webcmd drives a real browser. Where it is not installed, skip rather than
// fail: this suite is about integration, and a missing tool is not a defect
// in the code under test.
const HAVE_WEBCMD = spawnSync('webcmd', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = HAVE_WEBCMD ? false : 'webcmd is not on this PATH';

let server, origin, browser;

const CONTENT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    // A redirect off the allowlist, so the post-redirect re-check has
    // something real to catch. The target is localhost on this same server —
    // NOT a made-up host. A non-resolving host (evil.test) fails DNS and
    // page.goto throws before the redirect ever completes, which tests the
    // error path rather than the policy path. A real attacker's redirect
    // target resolves; this one does too, and is simply not allowlisted.
    if (url.pathname === '/offsite') {
      res.writeHead(302, { Location: `http://localhost:${server.address().port}/clean-1.html` });
      return res.end();
    }
    // A redirect to a host that does not resolve at all, for the error path.
    if (url.pathname === '/nowhere') {
      res.writeHead(302, { Location: 'http://does-not-resolve.invalid/x' });
      return res.end();
    }
    // A form with a password field and a purchase button, for the fill and
    // click paths. Nothing here is submitted anywhere: the action is '/order'
    // on this same throwaway server.
    if (url.pathname === '/form') {
      res.writeHead(200, { 'Content-Type': CONTENT['.html'] });
      return res.end(`<!doctype html><title>Order</title><h1>Order</h1>
<form action="/order" method="post">
<input name="qty" placeholder="Quantity">
<input type="password" name="pw">
<input name="q7">
<button type="submit">Place order</button>
</form>
<a href="/reviews">Reviews</a>`);
    }

    const name = path.basename(url.pathname) || 'index.html';
    const file = path.join(CORPUS, name);
    if (!file.startsWith(CORPUS) || !existsSync(file)) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': CONTENT[path.extname(file)] || 'text/plain' });
    res.end(readFileSync(file));
  });

  // Bound on every interface so both 127.0.0.1 and localhost reach it. The
  // redirect test needs two names for one server: one allowlisted, one not.
  await new Promise(r => server.listen(0, r));
  origin = `http://127.0.0.1:${server.address().port}`;
  if (HAVE_WEBCMD) browser = createBrowser();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
});

const policy = () => createPolicy({ allowHosts: ['127.0.0.1', 'localhost'] });
const audit = () => { const events = []; return { events, record: e => events.push(e), read: () => events }; };

function scriptedModel(decisions) {
  let i = 0; const prompts = [];
  return {
    prompts,
    async decide({ prompt }) {
      prompts.push(prompt);
      return { decision: decisions[Math.min(i++, decisions.length - 1)], costUsd: 0, ms: 1, model: 'scripted', attempt: 1 };
    },
    async answer() { throw new Error('not used'); },
    spent: () => ({ usd: 0, calls: prompts.length })
  };
}

test('the corpus is served and the injected page really carries its injection', { skip }, async () => {
  const landed = await browser.navigate(`${origin}/p1-white-text.html`);
  assert.equal(landed.status, 200);

  const page = await browser.text('read');
  assert.ok(page.text.length > 0, 'the page came back empty');

  const findings = detect(page.text);
  assert.ok(findings.length > 0, 'the detector found nothing on a page that carries an injection');

  // The canary lives only in the manifest — this asserts the page and the
  // manifest agree, without ever hardcoding the word here.
  const manifest = JSON.parse(readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const entry = manifest.find(e => e.id === 'p1');
  assert.ok(page.text.includes(entry.canary), 'the canary is not in the rendered text');
});

test('a clean page produces no findings over real HTTP', { skip }, async () => {
  await browser.navigate(`${origin}/clean-1.html`);
  const page = await browser.text('read');
  assert.equal(detect(page.text).length, 0, `false positives on a clean page: ${JSON.stringify(detect(page.text))}`);
});

test('the DOM inventory reports type=password over real HTTP', { skip }, async () => {
  await browser.navigate(`${origin}/form`);
  const controls = await browser.inventory();

  const pw = controls.find(c => c.name === 'pw');
  assert.ok(pw, 'the password field was not in the inventory');
  // The whole reason inventory() exists rather than parsing the act snapshot.
  assert.equal(pw.type, 'password');

  const button = controls.find(c => c.text === 'Place order');
  assert.ok(button);
  assert.equal(button.formAction, '/order');
  assert.equal(policy().verbOfControl({ text: button.text, formAction: button.formAction }), 'buy');
});

test('a real redirect off the allowlist is refused after resolution', { skip }, async () => {
  const log = audit();
  // 127.0.0.1 only. The redirect lands on localhost, which is the same
  // machine and the same server, and is still refused — the check is on the
  // name that was allowlisted, not on where the packets went.
  const p = createPolicy({ allowHosts: ['127.0.0.1'] });
  const actions = createActions({ policy: p, browser, audit: log });

  const r = await actions.dispatch({ action: 'navigate', target: `${origin}/offsite`, reason: 'following a link' });
  assert.equal(r.refused, true, `expected a refusal, got ${JSON.stringify(r)}`);
  assert.match(r.reason, /redirected to http:\/\/localhost:/);

  const recheck = log.events.find(e => e.type === 'policy_canVisit_afterRedirect');
  assert.ok(recheck && recheck.allowed === false);
  assert.ok(recheck.chain.length >= 2, `the redirect chain was not captured: ${JSON.stringify(recheck.chain)}`);
});

test('a redirect to a host that does not resolve is an error, not a quiet success', { skip }, async () => {
  const log = audit();
  const actions = createActions({ policy: policy(), browser, audit: log });
  const r = await actions.dispatch({ action: 'navigate', target: `${origin}/nowhere`, reason: 'x' });

  assert.equal(r.ok, false);
  assert.equal(r.error, true, `a dead redirect was not reported as an error: ${JSON.stringify(r)}`);
  assert.ok(log.events.some(e => e.type === 'action_error'));
});

test('a real password field is refused a real value', { skip }, async () => {
  await browser.navigate(`${origin}/form`);
  await browser.inventory();
  const controls = await browser.inventory();
  const pw = controls.find(c => c.name === 'pw');

  const log = audit();
  const actions = createActions({ policy: policy(), browser, gate: { async request() { return 'approve'; } }, audit: log });
  const r = await actions.dispatch({ action: 'fill', target: pw.ref, value: 'hunter2', reason: 'the page asked' });

  assert.equal(r.refused, true);
  assert.match(r.reason, /never types credentials/);
  assert.ok(!JSON.stringify(log.events).includes('hunter2'));
});

test('the whole loop runs end to end over HTTP, with the model scripted', { skip }, async () => {
  const log = audit();
  const p = policy();
  const model = scriptedModel([
    { action: 'extract', target: 'the customer reviews', reason: 'reading the page' },
    { action: 'finish', target: 'Four stars. The page also tried to instruct me.', reason: 'done' }
  ]);
  const actions = createActions({ policy: p, browser, gate: null, audit: log });
  const loop = createLoop({ policy: p, browser, model, actions, audit: log, maxSteps: 4, maxCostUsd: 1 });

  const r = await loop.run({ url: `${origin}/p1-white-text.html`, task: 'Summarise the reviews.' });

  assert.equal(r.halted, HALT.FINISHED);
  assert.ok(r.findings.length > 0, 'the run found no injection on an injected page');
  assert.match(r.answer, /Four stars/);

  // Ordering, over real HTTP this time: the page attempt was on record before
  // the model was consulted.
  const types = log.events.map(e => e.type);
  assert.ok(types.indexOf('findings') < types.indexOf('model_decided'));

  // And the page text reached the model inside the untrusted-page tags.
  const prompt = model.prompts[0];
  const inside = prompt.slice(prompt.indexOf('<untrusted-page>'), prompt.indexOf('</untrusted-page>'));
  const manifest = JSON.parse(readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
  assert.ok(inside.includes(manifest.find(e => e.id === 'p1').canary));
});

test('a run cannot start on a host that is not allowlisted, even a live one', { skip }, async () => {
  const p = createPolicy({ allowHosts: ['localhost'] });   // note: NOT 127.0.0.1
  const log = audit();
  const actions = createActions({ policy: p, browser, audit: log });
  const loop = createLoop({ policy: p, browser, model: scriptedModel([]), actions, audit: log });

  const r = await loop.run({ url: `${origin}/clean-1.html`, task: 'summarise' });
  assert.equal(r.halted, HALT.ERROR);
  assert.match(r.reason, /not on the allowlist/);
  assert.equal(r.steps, 0);
});
