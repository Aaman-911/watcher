// WATCHER agent — the model layer.
//
// Two things live here: a transport seam, and the one transport we ship.
//
// THE SEAM. createModel({ transport }) takes its transport by injection, so
// the step loop can be tested against a scripted decision sequence — free,
// instant, deterministic — without spawning a model. It also means a future
// API-backed transport slots in without touching the loop.
//
// NO FAKE TRANSPORT IS SHIPPED FROM THIS FILE, deliberately. A previous
// version of this project carried a "FALLBACK MOCK FOR LIVE DEMO" in the model
// path that returned invented answers when the real call failed. It
// manufactured exactly the result the project could not reproduce honestly,
// and it would have been indistinguishable from a real run on the scorecard.
// Tests construct their own fakes in test/. Nothing under src/ may.
//
// Spec §7: if the model call fails, the run fails and says so. There is no
// branch in this file that returns text the model did not produce.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ACTIONS = ['navigate', 'extract', 'click', 'fill', 'submit', 'finish'];

// Spec §4.2. The model chooses WHAT TO ATTEMPT from a fixed enum. It never
// decides what is permitted — policy does, in JavaScript, after this returns.
export const DECISION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    target: { type: 'string' },
    value: { type: 'string' },
    // `finish` puts the final answer HERE, not in `target`. Measured on a
    // real run: with the answer expected in `target`, the model returned the
    // label "summary of customer reviews" instead of the summary. For every
    // other action `target` is a ref or a URL — an identifier — so a model
    // reading the schema treats it as one. Giving the answer its own field
    // removes the ambiguity rather than asking the prompt to fight it.
    answer: { type: 'string' },
    reason: { type: 'string' },
    injection_noticed: { type: 'string' }
  },
  required: ['action', 'reason'],
  additionalProperties: false
});

// Built-in tools refused on every call. A model that can run Bash or Read
// could reach the project's own files, or take real action outside the gate.
const NO_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'TodoWrite'
].join(' ');

let neutralDir = null;
// `claude -p` discovers CLAUDE.md by walking up from the working directory.
// Run from inside this project and the model is handed a document explaining
// that WATCHER is a prompt-injection experiment with a defence, which
// contaminates every measurement taken with it. --safe-mode does NOT fix
// this: its help text claims it disables CLAUDE.md, but on 2.1.238 the
// project CLAUDE.md still loaded. Running from a neutral directory does.
function neutralCwd() {
  if (!neutralDir) neutralDir = mkdtempSync(join(tmpdir(), 'watcher-model-'));
  return neutralDir;
}

/**
 * The transport we ship: `claude -p` with structured output.
 *
 * Verified 2026-09-10 against claude 2.1.238 — a call with --json-schema and
 * --output-format json returns an object carrying `structured_output` (the
 * decision), `result` (the same thing as a string), `total_cost_usd`, and
 * `is_error`. Real numbers from that probe: total_cost_usd 0.2181 on
 * 36,124 cache-creation tokens, almost all of it system-prompt overhead.
 */
export function claudeTransport(options = {}) {
  const model = options.model || process.env.WATCHER_MODEL || 'sonnet';
  const timeoutMs = options.timeoutMs ?? 180000;
  const spawnFn = options.spawn || spawn;

  return {
    name: `claude -p (${model})`,
    async call({ prompt, schema }) {
      const args = [
        '-p',
        '--model', model,
        '--output-format', 'json',
        '--no-session-persistence',
        '--disallowedTools', NO_TOOLS
      ];
      if (schema) args.push('--json-schema', JSON.stringify(schema));

      const started = Date.now();
      const raw = await new Promise((resolve, reject) => {
        const ps = spawnFn('claude', args, { cwd: neutralCwd(), stdio: ['pipe', 'pipe', 'pipe'] });
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
          resolve(out.trim());
        });

        ps.stdin.write(prompt);
        ps.stdin.end();
      });

      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error(`claude did not return JSON:\n${raw.slice(0, 600)}`); }

      if (parsed.is_error) {
        throw new Error(`claude reported an error: ${parsed.result || parsed.subtype || 'unknown'}`);
      }

      return {
        structured: parsed.structured_output ?? null,
        // `result` is the decision as a string. Kept so a schema-less call
        // (a plain summary, as agents/watcher.mjs makes) still has text.
        text: typeof parsed.result === 'string' ? parsed.result : '',
        costUsd: Number(parsed.total_cost_usd || 0),
        ms: Date.now() - started,
        model
      };
    }
  };
}

function validateDecision(d) {
  if (!d || typeof d !== 'object') return 'the model returned no decision object';
  if (!ACTIONS.includes(d.action)) return `"${d.action}" is not one of: ${ACTIONS.join(', ')}`;
  if (typeof d.reason !== 'string' || !d.reason.trim()) return 'the decision carried no reason';
  return null;
}

/**
 * @param {{transport: object}} options
 */
export function createModel({ transport } = {}) {
  if (!transport) throw new Error('createModel needs a transport');

  let spentUsd = 0;
  let calls = 0;

  /** One structured decision. Spec §7: one retry on invalid output, then fail. */
  async function decide({ prompt, schema = DECISION_SCHEMA, attempts = 2 } = {}) {
    let lastProblem = null;
    let lastRaw = '';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const reply = await transport.call({ prompt, schema });
      spentUsd += Number(reply.costUsd || 0);
      calls += 1;

      // Prefer the structured object. Fall back to PARSING the result string —
      // a parse, never an invention. If neither yields a valid decision the
      // run fails with the raw output shown.
      let decision = reply.structured;
      if (!decision && reply.text) {
        try { decision = JSON.parse(reply.text); } catch { decision = null; }
      }

      const problem = validateDecision(decision);
      if (!problem) {
        return {
          decision,
          costUsd: Number(reply.costUsd || 0),
          ms: reply.ms,
          model: reply.model,
          attempt
        };
      }
      lastProblem = problem;
      lastRaw = reply.text || JSON.stringify(reply.structured ?? null);
    }

    throw new Error(
      `the model did not return a usable decision after ${attempts} attempts: ${lastProblem}\n` +
      `raw output:\n${String(lastRaw).slice(0, 600)}`
    );
  }

  /** A schema-less call, for a plain text answer. Same no-fabrication rule. */
  async function answer(prompt) {
    const reply = await transport.call({ prompt, schema: null });
    spentUsd += Number(reply.costUsd || 0);
    calls += 1;
    return { text: reply.text, costUsd: Number(reply.costUsd || 0), ms: reply.ms, model: reply.model };
  }

  return {
    decide,
    answer,
    spent: () => ({ usd: Number(spentUsd.toFixed(6)), calls }),
    transportName: transport.name || 'unnamed transport'
  };
}
