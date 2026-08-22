// WATCHER — read a page through webcmd.
//
// All page reading in this project goes through here. One browser session is
// created lazily on first use and reused for every later call, because
// creating a session costs a second or two and the agents read many pages in
// a row. Call close() when finished.
//
// Modes are webcmd's own snapshot modes:
//   read  readable article text, via readability   (markdown)
//   tree  fuller accessibility tree                (element tree)
//   act   actionable controls only                 (element tree)
//
// Verified 2026-08-22 against webcmd 0.7.4: every mode returns JSON with the
// snapshot in a top-level "tree" string.

import { spawn } from 'node:child_process';

const PROFILE = process.env.WATCHER_PROFILE || 'demo';
const MAX_OUTPUT = Number(process.env.WATCHER_MAX_OUTPUT || 200000);

export const MODES = ['read', 'tree', 'act'];

let sessionId = null;

function webcmd(args, input) {
  return new Promise((resolve, reject) => {
    const ps = spawn('webcmd', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', reject);
    ps.on('close', code => resolve({ code, out, err }));
    if (input !== undefined) ps.stdin.write(input);
    ps.stdin.end();
  });
}

function parseJson(text, what) {
  try { return JSON.parse(text); }
  catch { throw new Error(`webcmd returned something that is not JSON for ${what}:\n${text.slice(0, 400)}`); }
}

/** Create the shared browser session, or return the existing one. */
export async function openSession() {
  if (sessionId) return sessionId;
  const r = await webcmd(['--profile', PROFILE, 'session', 'create', '-f', 'json']);
  if (r.code !== 0) throw new Error(`could not create a webcmd session:\n${r.err || r.out}`);
  const id = parseJson(r.out, 'session create').id;
  if (!id) throw new Error(`webcmd did not return a session id:\n${r.out}`);
  sessionId = id;
  return sessionId;
}

/**
 * Fetch one page and return its text.
 * @returns {Promise<{url:string,title:string,mode:string,text:string}>}
 */
export async function readPage(url, mode = 'read') {
  if (!MODES.includes(mode)) {
    throw new Error(`unknown mode "${mode}". Use one of: ${MODES.join(', ')}`);
  }
  const id = await openSession();
  const base = ['--profile', PROFILE, '--session', id];

  const nav = await webcmd(
    [...base, 'browser', 'run', '--stdin', '--no-snapshot-diff'],
    `await page.goto(${JSON.stringify(url)});\n` +
    `return { url: page.url(), title: await page.title() };\n`
  );
  if (nav.code !== 0) throw new Error(`could not open ${url}:\n${nav.err || nav.out}`);
  const navJson = parseJson(nav.out, 'page navigation');
  if (!navJson.ok) throw new Error(`could not open ${url}:\n${JSON.stringify(navJson.error || navJson)}`);

  const snap = await webcmd([...base, 'browser', 'snapshot',
    '--snapshot-mode', mode, '--max-output', String(MAX_OUTPUT)]);
  if (snap.code !== 0) throw new Error(`snapshot failed for ${url}:\n${snap.err || snap.out}`);
  const snapJson = parseJson(snap.out, `snapshot --snapshot-mode ${mode}`);
  if (!snapJson.ok) throw new Error(`snapshot failed for ${url}:\n${JSON.stringify(snapJson.error || snapJson)}`);

  return {
    url: navJson.result.url,
    title: navJson.result.title,
    mode,
    text: String(snapJson.tree ?? '')
  };
}

/** Close the shared session. Safe to call more than once. */
export async function close() {
  if (!sessionId) return;
  const id = sessionId;
  sessionId = null;
  await webcmd(['--profile', PROFILE, 'session', 'close', id]);
}

/** The current session id, or null if none is open. Useful in error messages. */
export function currentSession() {
  return sessionId;
}
