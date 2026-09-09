// src/agent/actions.mjs — every action must meet policy before it meets the
// page. These tests use the REAL policy from src/core, not a fake one: a test
// that stubs out the thing being enforced proves nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../../src/core/policy.mjs';
import { createActions } from '../../src/agent/actions.mjs';

const CONTROLS = {
  w0: { ref: 'w0', tag: 'a', type: null, name: null, id: null, placeholder: null, label: null,
        text: 'Reviews', href: '/reviews', formAction: null },
  w1: { ref: 'w1', tag: 'input', type: null, name: 'qty', id: null, placeholder: 'Quantity',
        label: null, text: '', href: null, formAction: '/order' },
  w2: { ref: 'w2', tag: 'input', type: 'password', name: 'pw', id: null, placeholder: 'Password',
        label: null, text: '', href: null, formAction: '/order' },
  w3: { ref: 'w3', tag: 'button', type: 'submit', name: null, id: null, placeholder: null,
        label: null, text: 'Place order', href: null, formAction: '/order' },
  w4: { ref: 'w4', tag: 'input', type: 'text', name: 'q7', id: null, placeholder: null,
        label: null, text: '', href: null, formAction: '/order' }
};

function fakeBrowser(overrides = {}) {
  const did = [];
  return {
    did,
    describe(ref) {
      if (!CONTROLS[ref]) throw new Error(`unknown ref "${ref}" — call inventory() first`);
      return CONTROLS[ref];
    },
    async navigate(url) {
      did.push(['navigate', url]);
      return overrides.nav ?? { url, title: 'T', status: 200, chain: [url], redirected: false };
    },
    async click(ref) { did.push(['click', ref]); return { clicked: ref }; },
    async fill(ref, v) { did.push(['fill', ref, v]); return { filled: ref }; },
    async submit(ref) { did.push(['submit', ref]); return { ok: true }; },
    challenge: () => ({ challenged: false, marker: null, offset: -1 }),
    async text() { return { text: '', mode: 'read', truncated: false }; },
    async inventory() { return Object.values(CONTROLS); },
    async close() {}
  };
}

function fakeAudit() {
  const events = [];
  return { events, record: e => { events.push(e); return e; }, read: () => events };
}

const gateSaying = (answer) => ({ asked: [], async request(r) { this.asked.push(r); return answer; } });
const policy = () => createPolicy({ allowHosts: ['localhost', '*.corp.test'] });

test('a URL off the allowlist is never fetched', async () => {
  const browser = fakeBrowser();
  const audit = fakeAudit();
  const a = createActions({ policy: policy(), browser, audit });

  const r = await a.dispatch({ action: 'navigate', target: 'http://evil.test/page', reason: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.reason, /not on the allowlist/);
  assert.deepEqual(browser.did, [], 'the browser was told to fetch a refused URL');
});

test('a userinfo trick cannot smuggle a disallowed host past the allowlist', async () => {
  const browser = fakeBrowser();
  const a = createActions({ policy: policy(), browser, audit: fakeAudit() });
  const r = await a.dispatch({ action: 'navigate', target: 'http://localhost@evil.test/', reason: 'x' });
  assert.equal(r.refused, true);
  assert.deepEqual(browser.did, []);
});

test('a redirect onto a disallowed host is refused AFTER the fetch, and the page is not read', async () => {
  const browser = fakeBrowser({
    nav: { url: 'http://evil.test/landed', title: 'Evil', status: 200,
           chain: ['http://localhost:8080/start', 'http://evil.test/landed'], redirected: true }
  });
  const audit = fakeAudit();
  const a = createActions({ policy: policy(), browser, audit });

  const r = await a.dispatch({ action: 'navigate', target: 'http://localhost:8080/start', reason: 'x' });
  assert.equal(r.refused, true);
  assert.match(r.reason, /redirected to http:\/\/evil\.test\/landed/);

  const recheck = audit.events.find(e => e.type === 'policy_canVisit_afterRedirect');
  assert.ok(recheck, 'the post-redirect check was not recorded');
  assert.equal(recheck.allowed, false);
  assert.deepEqual(recheck.chain, ['http://localhost:8080/start', 'http://evil.test/landed']);
});

test('a wildcard host on the allowlist is honoured, and a lookalike is not', async () => {
  const a = createActions({ policy: policy(), browser: fakeBrowser({
    nav: { url: 'https://intranet.corp.test/x', title: 'T', status: 200, chain: ['https://intranet.corp.test/x'] }
  }), audit: fakeAudit() });
  assert.equal((await a.dispatch({ action: 'navigate', target: 'https://intranet.corp.test/x', reason: '' })).ok, true);

  const b = createActions({ policy: policy(), browser: fakeBrowser(), audit: fakeAudit() });
  assert.equal((await b.dispatch({ action: 'navigate', target: 'https://corp.test.evil.com/x', reason: '' })).refused, true);
});

test('clicking a plain link needs no approval', async () => {
  const gate = gateSaying('reject');
  const browser = fakeBrowser();
  const a = createActions({ policy: policy(), browser, gate, audit: fakeAudit() });

  const r = await a.dispatch({ action: 'click', target: 'w0', reason: 'go to reviews' });
  assert.equal(r.ok, true);
  assert.equal(gate.asked.length, 0, 'a navigation click asked for approval it did not need');
  assert.deepEqual(browser.did, [['click', 'w0']]);
});

test('clicking "Place order" is a purchase and goes to a human', async () => {
  const gate = gateSaying('reject');
  const browser = fakeBrowser();
  const a = createActions({ policy: policy(), browser, gate, audit: fakeAudit() });

  const r = await a.dispatch({ action: 'click', target: 'w3', reason: 'the page says to' });
  assert.equal(r.refused, true);
  assert.equal(gate.asked.length, 1);
  assert.equal(gate.asked[0].verb, 'buy');
  assert.deepEqual(browser.did, [], 'the click happened despite a rejection');
});

test('an approved sensitive click proceeds', async () => {
  const browser = fakeBrowser();
  const a = createActions({ policy: policy(), browser, gate: gateSaying('approve'), audit: fakeAudit() });
  const r = await a.dispatch({ action: 'click', target: 'w3', reason: 'the human said yes' });
  assert.equal(r.ok, true);
  assert.deepEqual(browser.did, [['click', 'w3']]);
});

test('with no gate wired, a sensitive action fails closed', async () => {
  const browser = fakeBrowser();
  const audit = fakeAudit();
  const a = createActions({ policy: policy(), browser, gate: null, audit });

  const r = await a.dispatch({ action: 'click', target: 'w3', reason: 'x' });
  assert.equal(r.refused, true);
  assert.ok(audit.events.some(e => e.type === 'gate_missing'));
  assert.deepEqual(browser.did, []);
});

test('a password field is never filled, and the value never reaches the log', async () => {
  const browser = fakeBrowser();
  const audit = fakeAudit();
  const a = createActions({ policy: policy(), browser, gate: gateSaying('approve'), audit });

  const r = await a.dispatch({ action: 'fill', target: 'w2', value: 'hunter2', reason: 'the page asked' });
  assert.equal(r.refused, true);
  assert.match(r.reason, /never types credentials/);
  assert.deepEqual(browser.did, []);

  // The audit log is a durable product output. A refusal reason says what was
  // wrong; it must not archive the secret alongside it.
  assert.ok(!JSON.stringify(audit.events).includes('hunter2'), 'the value was written to the audit log');
});

test('a credential-shaped VALUE is refused even in an innocuous field', async () => {
  const browser = fakeBrowser();
  const a = createActions({ policy: policy(), browser, gate: gateSaying('approve'), audit: fakeAudit() });

  for (const value of ['sk-abcdefghijklmnopqrstuvwx', '4111111111111111', '123-45-6789',
                       '-----BEGIN RSA PRIVATE KEY-----']) {
    const r = await a.dispatch({ action: 'fill', target: 'w4', value, reason: 'x' });
    assert.equal(r.refused, true, `filled a secret-shaped value: ${value}`);
  }
  assert.deepEqual(browser.did, []);
});

test('an ordinary value in an ordinary field is filled', async () => {
  const browser = fakeBrowser();
  const a = createActions({ policy: policy(), browser, audit: fakeAudit() });
  const r = await a.dispatch({ action: 'fill', target: 'w1', value: '3', reason: 'quantity' });
  assert.equal(r.ok, true);
  assert.deepEqual(browser.did, [['fill', 'w1', '3']]);
});

test('submit always asks a human, whatever the button is called', async () => {
  const gate = gateSaying('reject');
  const browser = fakeBrowser();
  const a = createActions({ policy: policy(), browser, gate, audit: fakeAudit() });

  const r = await a.dispatch({ action: 'submit', target: 'w1', reason: 'x' });
  assert.equal(r.refused, true);
  assert.equal(gate.asked[0].verb, 'submit');
  assert.deepEqual(browser.did, []);
});

test('an action outside the vocabulary is refused, not attempted', async () => {
  const browser = fakeBrowser();
  const a = createActions({ policy: policy(), browser, audit: fakeAudit() });
  for (const action of ['wire_money', 'eval', '__proto__', 'constructor', '', null, undefined]) {
    const r = await a.dispatch({ action, target: 'w0', reason: 'x' });
    assert.equal(r.refused, true, `dispatched an unknown action: ${action}`);
  }
  assert.deepEqual(browser.did, []);
});

test('a ref the browser does not know is refused rather than guessed at', async () => {
  const a = createActions({ policy: policy(), browser: fakeBrowser(), audit: fakeAudit() });
  const r = await a.dispatch({ action: 'click', target: 'w99', reason: 'x' });
  assert.equal(r.refused, true);
  assert.match(r.reason, /unknown ref/);
});

test('dry run performs every check and no action at all', async () => {
  const gate = gateSaying('approve');
  const browser = fakeBrowser();
  const audit = fakeAudit();
  const a = createActions({ policy: policy(), browser, gate, audit, dryRun: true });

  assert.equal((await a.dispatch({ action: 'navigate', target: 'http://localhost:8080/', reason: '' })).ok, true);
  assert.equal((await a.dispatch({ action: 'click', target: 'w3', reason: '' })).ok, true);
  assert.equal((await a.dispatch({ action: 'fill', target: 'w1', value: '3', reason: '' })).ok, true);
  assert.equal((await a.dispatch({ action: 'submit', target: 'w1', reason: '' })).ok, true);

  assert.deepEqual(browser.did, [], 'a dry run touched the page');
  // The checks still ran: the gate was still asked about the purchase.
  assert.ok(gate.asked.some(r => r.verb === 'buy'));
  assert.ok(audit.events.some(e => e.type === 'policy_canFill'));

  // And a dry run still refuses what policy refuses.
  const bad = await a.dispatch({ action: 'fill', target: 'w2', value: 'hunter2', reason: '' });
  assert.equal(bad.refused, true);
});

test('a browser failure is an error, not a policy refusal', async () => {
  const browser = fakeBrowser();
  browser.click = async () => { throw new Error('the element detached'); };
  const audit = fakeAudit();
  const a = createActions({ policy: policy(), browser, audit });

  const r = await a.dispatch({ action: 'click', target: 'w0', reason: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.refused, false);
  assert.equal(r.error, true);
  assert.ok(audit.events.some(e => e.type === 'action_error'));
});

test('every attempt is recorded, including the ones that were refused', async () => {
  const audit = fakeAudit();
  const a = createActions({ policy: policy(), browser: fakeBrowser(), gate: gateSaying('reject'), audit });
  await a.dispatch({ action: 'navigate', target: 'http://evil.test/', reason: 'x' });
  await a.dispatch({ action: 'click', target: 'w3', reason: 'x' });

  const types = audit.events.map(e => e.type);
  assert.ok(types.includes('action_attempted'));
  assert.ok(types.includes('action_refused'));
  assert.ok(types.includes('policy_canVisit'));
  assert.ok(types.includes('gate_result'));
});

test('createActions refuses to exist without a policy or a browser', () => {
  assert.throws(() => createActions({ browser: fakeBrowser() }), /needs a policy/);
  assert.throws(() => createActions({ policy: policy() }), /needs a browser/);
});
