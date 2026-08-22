// WATCHER — ask a model a question and get text back.
//
// Wraps `claude -p`. Flags below were checked against `claude -p --help` on
// claude 2.1.238 and tested, not guessed:
//
//   -p                        non-interactive, print and exit
//   --output-format text      plain text on stdout (default, stated anyway)
//   --model <alias>           opus / sonnet / fable, or a full model name
//   --no-session-persistence  do not save these throwaway runs to disk
//   --disallowedTools <list>  space-separated tool names to refuse
//
// The prompt goes in on stdin, never as an argument: page text runs to many
// thousands of characters and would blow past the command-line length limit.
//
// TWO THINGS THIS FILE DELIBERATELY GUARDS AGAINST
//
// 1. Working directory. `claude -p` discovers CLAUDE.md by walking up from the
//    current directory. Run from anywhere inside this project and the model is
//    handed a document explaining that WATCHER is a prompt-injection demo with
//    a defence — so the "naive" agent would already be forewarned and the whole
//    measurement would be worthless. Verified: run from the project root it
//    names the project unprompted; run from a neutral directory it does not.
//    Every call therefore runs from a fresh temp directory outside the project.
//
//    Note: --safe-mode does NOT fix this. Its help text claims it disables
//    CLAUDE.md, but tested on 2.1.238 the project CLAUDE.md still loaded.
//
// 2. Tools. A model that can run Bash or Read could reach the project files and
//    discover the answer, or take real action. Tools are refused by name.
//    Verified: with these flags, Read returns "Read is disabled for this
//    session".

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_MODEL = process.env.WATCHER_MODEL || 'sonnet';

// Built-in tools refused on every call. Anything not on this list is not a
// tool this project expects to exist; add to it rather than removing from it.
const NO_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'TodoWrite'
].join(' ');

let neutralDir = null;
function neutralCwd() {
  if (!neutralDir) neutralDir = mkdtempSync(join(tmpdir(), 'watcher-think-'));
  return neutralDir;
}

/**
 * Send one prompt to the model and return its reply as text.
 *
 * @param {string} prompt
 * @param {{model?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{text:string, model:string, ms:number}>}
 */
export async function think(prompt, options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 180000;

  const args = [
    '-p',
    '--model', model,
    '--output-format', 'text',
    '--no-session-persistence',
    '--disallowedTools', NO_TOOLS
  ];

  const started = Date.now();

  return new Promise((resolve, reject) => {
    const ps = spawn('claude', args, {
      cwd: neutralCwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let out = '', err = '', settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ps.kill('SIGKILL');
      reject(new Error(`the model did not reply within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });

    ps.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e.code === 'ENOENT'
        ? new Error('the `claude` command was not found on this PATH')
        : e);
    });

    ps.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited with code ${code}\n${err.trim() || out.trim()}`));
      }
      resolve({ text: out.trim(), model, ms: Date.now() - started });
    });

    ps.stdin.write(prompt);
    ps.stdin.end();
  });
}
