// src/agent/browser.mjs — unit tests with the webcmd runner injected.
//
// No browser is launched and no network is touched. The runner is a function
// that records the argv and stdin it was handed, which is exactly what these
// tests need to assert: that nothing a page or a model can influence is ever
// pasted into a Playwright program unescaped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowser, MODES } from '../../src/agent/browser.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Strip every double-quoted string literal from a Playwright program. What is
// left is the program's actual CODE. This is the honest way to ask "did the
// payload become an instruction?": an escaped payload still contains the
// characters "await page.goto" INSIDE a string literal, and a naive substring
// search cannot tell that apart from a real call. Removing the literals can.
function codeOutsideStrings(program) {
  return program.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

// Strip line and block comments. A source-level assertion about what a module
// DOES must not be defeated, or satisfied, by what its comments SAY.
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}


const PROBE_INVENTORY = [
  { ref: 'w0', tag: 'a', type: null, name: null, id: null, placeholder: null,
    label: null, text: 'Next page', href: '/next', formAction: null, visible: true },
  { ref: 'w1', tag: 'input', type: null, name: 'qty', id: null, placeholder: 'Quantity',
    label: null, text: '', href: null, formAction: '/order', visible: true },
  { ref: 'w2', tag: 'input', type: 'password', name: 'pw', id: null, placeholder: 'Password',
    label: null, text: '', href: null, formAction: '/order', visible: true },
  { ref: 'w3', tag: 'button', type: 'submit', name: null, id: null, placeholder: null,
    label: null, text: 'Place order', href: null, formAction: '/order', visible: true }
];

// A runner that answers like webcmd 0.7.4 and records every call.
function fakeRunner(overrides = {}) {
  const calls = [];
  const runner = async (args, input) => {
    calls.push({ args, input });
    const joined = args.join(' ');

    if (joined.includes('session create')) {
      return { code: 0, out: JSON.stringify({ id: 'session_test' }), err: '' };
    }
    if (joined.includes('session close')) return { code: 0, out: '', err: '' };

    if (joined.includes('browser snapshot')) {
      return {
        code: 0,
        out: JSON.stringify({
          ok: true,
          tree: overrides.tree ?? '<page><document>hello</document></page>',
          page: { url: 'http://localhost:8080/p1.html', title: 'Probe' },
          limits: { snapshotTruncated: overrides.truncated ?? false }
        }),
        err: ''
      };
    }

    if (joined.includes('browser run')) {
      // Answer according to what the program asked for.
      let result;
      if (input.includes('page.goto')) {
        result = overrides.nav ?? {
          url: 'http://localhost:8080/p1.html',
          title: 'Probe',
          status: 200,
          chain: ['http://localhost:8080/p1.html']
        };
      } else if (input.includes('page.evaluate') && input.includes('data-watcher-ref')
                 && input.includes('querySelectorAll')) {
        result = overrides.inventory ?? PROBE_INVENTORY;
      } else if (input.includes('page.click')) {
        result = { clicked: true, url: 'http://localhost:8080/p1.html' };
      } else if (input.includes('page.fill')) {
        result = { filled: true };
      } else {
        result = { ok: true };
      }
      return { code: 0, out: JSON.stringify({ ok: true, result }), err: '' };
    }
    return { code: 1, out: '', err: `unexpected call: ${joined}` };
  };
  runner.calls = calls;
  runner.programs = () => calls.filter(c => typeof c.input === 'string').map(c => c.input);
  return runner;
}

test('inventory carries the real DOM type, which the act snapshot does not', async () => {
  const runner = fakeRunner();
  const b = createBrowser({ runner });
  await b.navigate('http://localhost:8080/p1.html');
  await b.inventory();

  // This is the whole reason inventory() exists rather than parsing `act`.
  assert.equal(b.describe('w2').type, 'password');
  assert.equal(b.describe('w2').name, 'pw');
  assert.equal(b.describe('w1').type, null);
  assert.equal(b.describe('w3').text, 'Place order');
  assert.equal(b.describe('w3').formAction, '/order');
});

test('describe() on an unknown ref throws rather than guessing', async () => {
  const b = createBrowser({ runner: fakeRunner() });
  assert.throws(() => b.describe('w9'), /unknown ref/);
});

test('a ref that is not w<digits> never reaches a Playwright program', async () => {
  const runner = fakeRunner();
  const b = createBrowser({ runner });
  await b.navigate('http://localhost:8080/p1.html');
  await b.inventory();

  const hostile = [
    'w0"], [data-x="',
    '"); await page.goto("http://evil.test"); //',
    'a[href]',
    '*',
    'w0 w1',
    '',
    null,
    undefined,
    'W0'
  ];
  for (const ref of hostile) {
    await assert.rejects(() => b.click(ref), /not a valid element ref|not in the current inventory/,
      `click accepted a hostile ref: ${JSON.stringify(ref)}`);
  }

  // Nothing hostile made it into any program that was actually sent.
  for (const program of runner.programs()) {
    assert.ok(!program.includes('evil.test'), 'a hostile ref reached a Playwright program');
  }
});

test('a well-formed ref that is not in the inventory is refused', async () => {
  const runner = fakeRunner();
  const b = createBrowser({ runner });
  await b.navigate('http://localhost:8080/p1.html');
  await b.inventory();
  await assert.rejects(() => b.click('w99'), /not in the current inventory/);
});

test('a hostile fill value is JSON-escaped, never interpolated raw', async () => {
  const runner = fakeRunner();
  const b = createBrowser({ runner });
  await b.navigate('http://localhost:8080/p1.html');
  await b.inventory();

  const payload = '"); await page.goto("http://evil.test"); //';
  await b.fill('w1', payload);

  const program = runner.programs().at(-1);
  // The payload is present, but only inside a JSON string literal: the quote
  // that would have broken out is backslash-escaped.
  assert.ok(program.includes('\\"); await page.goto(\\"http://evil.test\\");'),
    `payload was not escaped:\n${program}`);

  // Outside the string literals there is exactly one call — the fill — and no
  // goto at all. The payload is data, not an instruction.
  const code = codeOutsideStrings(program);
  assert.equal((code.match(/page\.goto/g) || []).length, 0, `payload became code:\n${code}`);
  assert.equal((code.match(/page\.fill/g) || []).length, 1);
  assert.ok(!code.includes('evil.test'));
});

test('a URL containing a quote cannot break out of navigate', async () => {
  const runner = fakeRunner();
  const b = createBrowser({ runner });
  await b.navigate('http://localhost:8080/a"); await page.goto("http://evil.test');
  const code = codeOutsideStrings(runner.programs().at(-1));
  assert.equal((code.match(/page\.goto/g) || []).length, 1, `the URL broke out:\n${code}`);
  assert.ok(!code.includes('evil.test'));
});

test('navigate reports the redirect chain and where it landed', async () => {
  const runner = fakeRunner({
    nav: {
      url: 'http://elsewhere.test/final',
      title: 'Elsewhere',
      status: 200,
      chain: ['http://localhost:8080/start', 'http://elsewhere.test/final']
    }
  });
  const b = createBrowser({ runner });
  const r = await b.navigate('http://localhost:8080/start');

  assert.equal(r.url, 'http://elsewhere.test/final');
  assert.equal(r.redirected, true);
  assert.deepEqual(r.chain, ['http://localhost:8080/start', 'http://elsewhere.test/final']);
});

test('a single-hop navigation is not reported as a redirect', async () => {
  const b = createBrowser({ runner: fakeRunner() });
  const r = await b.navigate('http://localhost:8080/p1.html');
  assert.equal(r.redirected, false);
});

test('navigating invalidates every ref held from the previous page', async () => {
  const runner = fakeRunner();
  const b = createBrowser({ runner });
  await b.navigate('http://localhost:8080/p1.html');
  await b.inventory();
  assert.equal(b.describe('w0').text, 'Next page');

  await b.navigate('http://localhost:8080/p2.html');
  assert.throws(() => b.describe('w0'), /unknown ref/);
  await assert.rejects(() => b.click('w0'), /not in the current inventory/);
});

test('clicking invalidates the inventory too — the page may have changed', async () => {
  const b = createBrowser({ runner: fakeRunner() });
  await b.navigate('http://localhost:8080/p1.html');
  await b.inventory();
  await b.click('w0');
  await assert.rejects(() => b.click('w0'), /not in the current inventory/);
});

test('text() passes snapshot truncation through instead of hiding it', async () => {
  const plain = createBrowser({ runner: fakeRunner({ truncated: false }) });
  assert.equal((await plain.text('read')).truncated, false);

  const cut = createBrowser({ runner: fakeRunner({ truncated: true }) });
  const r = await cut.text('read');
  assert.equal(r.truncated, true);
  assert.equal(r.mode, 'read');
});

test('text() refuses an unknown snapshot mode', async () => {
  const b = createBrowser({ runner: fakeRunner() });
  await assert.rejects(() => b.text('nonsense'), /unknown mode/);
  assert.deepEqual(MODES, ['read', 'tree', 'act']);
});

test('challenge() reports CAPTCHAs and never claims to solve one', async () => {
  const b = createBrowser({ runner: fakeRunner() });
  const hits = [
    ['Please complete the reCAPTCHA to continue', 'reCAPTCHA'],
    ['<div class="cf-turnstile"></div>', 'Cloudflare Turnstile'],
    ['Verify you are human', 'a human-verification prompt'],
    ['Our systems have detected unusual traffic', 'an unusual-traffic block'],
    ['Checking your browser before accessing', 'a browser check']
  ];
  for (const [text, marker] of hits) {
    const r = b.challenge(text);
    assert.equal(r.challenged, true, `missed: ${text}`);
    assert.equal(r.marker, marker);
  }
  assert.equal(b.challenge('Three sentences about customer reviews.').challenged, false);
});

test('a failing webcmd call throws rather than returning an empty page', async () => {
  const b = createBrowser({ runner: async () => ({ code: 1, out: '', err: 'boom' }) });
  await assert.rejects(() => b.navigate('http://localhost:8080/'), /could not create a webcmd session/);
});

test('a webcmd reply that is not JSON is reported, not silently swallowed', async () => {
  const b = createBrowser({
    runner: async (args) => args.join(' ').includes('session create')
      ? { code: 0, out: JSON.stringify({ id: 'session_test' }), err: '' }
      : { code: 0, out: 'not json at all', err: '' }
  });
  await assert.rejects(() => b.navigate('http://localhost:8080/'), /not JSON/);
});

test('the browser layer decides nothing about what is permitted', () => {
  const src = codeOnly(readFileSync(path.join(ROOT, 'src', 'agent', 'browser.mjs'), 'utf8'));
  // It must not import policy, and must not carry its own allow/deny vocabulary.
  // Comments are stripped first: this asserts what the module DOES, and the
  // file's header legitimately explains policy's role in prose.
  assert.ok(!/from\s+['"].*core\/policy/.test(src), 'browser.mjs imports policy');
  assert.ok(!/\bcanVisit\b|\bcanFill\b|\bcanAct\b|\ballowHosts\b|\bBLOCKED_VERBS\b/.test(src),
    'browser.mjs has started making policy decisions');
});
