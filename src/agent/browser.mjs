// WATCHER agent — the browser layer.
//
// Owns the webcmd subprocess and turns intentions into Playwright calls. It
// decides NOTHING about what is permitted: every allow/refuse question belongs
// to src/core/policy.mjs, and this module never imports it. Keeping the two
// apart is what lets the policy be audited without reading browser code, and
// what stops a "convenience" allowance being added down here where no test for
// invariants is looking.
//
// FOUR RULES, EACH WITH A TEST
//
// 1. Refs only. click/fill/submit accept a ref matching /^w\d+$/ that is
//    present in the most recent inventory. Nothing else reaches a snippet.
//
// 2. No interpolation, ever. Every value crossing into a Playwright program is
//    JSON.stringify'd. Page text reaches the model, the model produces a
//    target, and the target becomes JavaScript that runs INSIDE the page — if
//    that target were pasted in raw, a page that talks the model into emitting
//    a selector has achieved code execution one layer past everything core
//    defends. A validated ref plus JSON.stringify cannot carry a payload.
//
// 3. The inventory carries real DOM attributes. webcmd's `act` snapshot does
//    NOT expose type="password" — verified 2026-09-10 against webcmd 0.7.4,
//    where a password input and a quantity input both render as
//    <textbox placeholder="...">. policy.canFill's first rule (§5.3) can
//    therefore never fire from snapshot data. inventory() reads the attributes
//    off the DOM instead, so the field's real type reaches policy.
//
// 4. The redirect chain is returned, not swallowed. Spec §5.1 requires the
//    allowlist to be re-checked after resolution; the caller cannot do that
//    without being told where it actually landed.

import { spawn } from 'node:child_process';

export const MODES = ['read', 'tree', 'act'];

// Refs are minted by us, in inventory(), and never by a page or a model. The
// pattern is deliberately narrow: two characters of vocabulary means there is
// nothing to escape and nothing to smuggle.
const REF = /^w\d+$/;

// Deterministic challenge markers (spec §5.4). No solving, ever, and nothing
// in this project makes the agent harder to identify as an agent.
const CHALLENGE_MARKERS = [
  [/\brecaptcha\b/i, 'reCAPTCHA'],
  [/\bhcaptcha\b/i, 'hCaptcha'],
  [/\bcf-turnstile\b|\bturnstile\b/i, 'Cloudflare Turnstile'],
  [/\bcaptcha\b/i, 'a CAPTCHA'],
  [/verify (that )?you(?:'re| are)? ?(a )?human/i, 'a human-verification prompt'],
  [/\bare you a robot\b/i, 'a bot challenge'],
  [/\bunusual traffic\b/i, 'an unusual-traffic block'],
  [/\bchecking your browser\b/i, 'a browser check'],
  [/complete the security check/i, 'a security check']
];

// Tags every actionable element with data-watcher-ref and reports its real
// attributes. Sent to page.evaluate as a string, JSON.stringify'd at the call
// site so no quoting of ours can ever be broken by page content.
const DOM_INVENTORY = `(() => {
  const SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const ref = 'w' + (i++);
    el.setAttribute('data-watcher-ref', ref);
    const r = el.getBoundingClientRect();
    out.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id || null,
      placeholder: el.getAttribute('placeholder'),
      label: el.getAttribute('aria-label'),
      text: String(el.innerText || el.value || '').trim().slice(0, 120),
      href: el.getAttribute('href'),
      formAction: el.form ? el.form.getAttribute('action') : null,
      visible: !!(r.width || r.height)
    });
  }
  return out;
})()`;

function selectorFor(ref) {
  return '[data-watcher-ref="' + ref + '"]';
}

function defaultRunner(profile) {
  return (args, input) => new Promise((resolve, reject) => {
    const ps = spawn('webcmd', ['--profile', profile, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', reject);
    ps.on('close', code => resolve({ code, out, err }));
    if (input !== undefined) ps.stdin.write(input);
    ps.stdin.end();
  });
}

/**
 * @param {{profile?:string, runner?:Function, maxOutput?:number}} [options]
 */
export function createBrowser(options = {}) {
  const profile = options.profile || process.env.WATCHER_PROFILE || 'demo';
  const maxOutput = Number(options.maxOutput || process.env.WATCHER_MAX_OUTPUT || 200000);
  const runner = options.runner || defaultRunner(profile);

  let sessionId = null;
  let lastInventory = new Map();

  function parseJson(text, what) {
    try { return JSON.parse(text); }
    catch { throw new Error(`webcmd returned something that is not JSON for ${what}:\n${String(text).slice(0, 400)}`); }
  }

  async function openSession() {
    if (sessionId) return sessionId;
    const r = await runner(['session', 'create', '-f', 'json']);
    if (r.code !== 0) throw new Error(`could not create a webcmd session:\n${r.err || r.out}`);
    const id = parseJson(r.out, 'session create').id;
    if (!id) throw new Error(`webcmd did not return a session id:\n${r.out}`);
    sessionId = id;
    return sessionId;
  }

  // Run one Playwright program in the page and return its `result`.
  async function run(program, what) {
    const id = await openSession();
    const r = await runner(['--session', id, 'browser', 'run', '--stdin', '--no-snapshot-diff'], program);
    if (r.code !== 0) throw new Error(`${what} failed:\n${r.err || r.out}`);
    const json = parseJson(r.out, what);
    if (!json.ok) throw new Error(`${what} failed:\n${JSON.stringify(json.error || json)}`);
    return json.result;
  }

  /**
   * Go to a URL. Returns where it actually LANDED and every hop on the way,
   * so the caller can re-run its allowlist check on the final host (§5.1).
   * This module does not perform that check and must not start.
   */
  async function navigate(url) {
    const program =
      `const res = await page.goto(${JSON.stringify(String(url))}, { waitUntil: "domcontentloaded", timeout: 30000 });\n` +
      `const chain = [];\n` +
      `let req = res ? res.request() : null;\n` +
      `while (req) { chain.unshift(req.url()); req = req.redirectedFrom(); }\n` +
      `return { url: page.url(), title: await page.title(), status: res ? res.status() : null, chain };\n`;
    const result = await run(program, `navigating to ${url}`);
    lastInventory = new Map();   // a new page invalidates every ref we held
    const chain = Array.isArray(result.chain) ? result.chain : [];
    return {
      url: result.url,
      title: result.title,
      status: result.status,
      chain,
      redirected: chain.length > 1 || (chain.length === 1 && chain[0] !== result.url)
    };
  }

  /**
   * Page text for detect() and for the model. Use 'read' or 'tree' — NOT
   * 'act', which truncates aggressively. `truncated` is passed through rather
   * than hidden: a finding that was cut off is not the same as no finding, and
   * the caller is expected to record that distinction.
   */
  async function text(mode = 'read') {
    if (!MODES.includes(mode)) {
      throw new Error(`unknown mode "${mode}". Use one of: ${MODES.join(', ')}`);
    }
    const id = await openSession();
    const r = await runner(['--session', id, 'browser', 'snapshot',
      '--snapshot-mode', mode, '--max-output', String(maxOutput)]);
    if (r.code !== 0) throw new Error(`snapshot failed:\n${r.err || r.out}`);
    const json = parseJson(r.out, `snapshot --snapshot-mode ${mode}`);
    if (!json.ok) throw new Error(`snapshot failed:\n${JSON.stringify(json.error || json)}`);
    return {
      text: String(json.tree ?? ''),
      mode,
      url: json.page?.url ?? null,
      title: json.page?.title ?? null,
      truncated: !!(json.limits && json.limits.snapshotTruncated)
    };
  }

  /** Tag every actionable element and report its real DOM attributes. */
  async function inventory() {
    const program =
      `const inv = await page.evaluate(${JSON.stringify(DOM_INVENTORY)});\n` +
      `return inv;\n`;
    const items = await run(program, 'building the element inventory');
    const list = Array.isArray(items) ? items : [];
    lastInventory = new Map(list.map(el => [el.ref, el]));
    return list;
  }

  /**
   * The element behind a ref, as the DOM actually describes it. This is what
   * gets handed to policy.canFill — see rule 3 at the top of this file.
   */
  function describe(ref) {
    const el = lastInventory.get(ref);
    if (!el) throw new Error(`unknown ref "${ref}" — call inventory() first, or re-snapshot after the page changed`);
    return el;
  }

  // Rule 1 and rule 2 live here, and every action goes through it.
  function checkedSelector(ref) {
    if (!REF.test(String(ref))) {
      throw new Error(`"${ref}" is not a valid element ref (expected w0, w1, ...)`);
    }
    if (!lastInventory.has(ref)) {
      throw new Error(`ref "${ref}" is not in the current inventory — the page changed, re-snapshot before acting`);
    }
    return selectorFor(ref);
  }

  async function click(ref) {
    const sel = checkedSelector(ref);
    const program =
      `await page.click(${JSON.stringify(sel)}, { timeout: 15000 });\n` +
      `return { clicked: ${JSON.stringify(ref)}, url: page.url() };\n`;
    const result = await run(program, `clicking ${ref}`);
    lastInventory = new Map();
    return result;
  }

  async function fill(ref, value) {
    const sel = checkedSelector(ref);
    const program =
      `await page.fill(${JSON.stringify(sel)}, ${JSON.stringify(String(value ?? ''))}, { timeout: 15000 });\n` +
      `return { filled: ${JSON.stringify(ref)} };\n`;
    return run(program, `filling ${ref}`);
  }

  async function submit(ref) {
    const sel = checkedSelector(ref);
    const script =
      `(() => { const el = document.querySelector(${JSON.stringify(sel)});\n` +
      `  if (!el) return { ok: false, reason: "element vanished" };\n` +
      `  const form = el.form || el.closest("form");\n` +
      `  if (!form) return { ok: false, reason: "no enclosing form" };\n` +
      `  if (typeof form.requestSubmit === "function") form.requestSubmit(el.type === "submit" ? el : undefined);\n` +
      `  else form.submit();\n` +
      `  return { ok: true }; })()`;
    const program =
      `const r = await page.evaluate(${JSON.stringify(script)});\n` +
      `return r;\n`;
    const result = await run(program, `submitting ${ref}`);
    lastInventory = new Map();
    return result;
  }

  /**
   * Deterministic challenge check (§5.4). Reports; never solves. The caller
   * halts the run and hands control to the human.
   */
  function challenge(pageText) {
    const t = String(pageText || '');
    for (const [re, name] of CHALLENGE_MARKERS) {
      const m = re.exec(t);
      if (m) return { challenged: true, marker: name, offset: m.index };
    }
    return { challenged: false, marker: null, offset: -1 };
  }

  async function close() {
    if (!sessionId) return;
    const id = sessionId;
    sessionId = null;
    lastInventory = new Map();
    await runner(['session', 'close', id]);
  }

  return {
    openSession, navigate, text, inventory, describe,
    click, fill, submit, challenge, close,
    currentSession: () => sessionId
  };
}
