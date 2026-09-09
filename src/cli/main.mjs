// WATCHER CLI — argument parsing, wiring, output.
//
// This file constructs the object graph and nothing else. Every rule lives in
// src/core (what is permitted) or src/agent (how a page is reached). If a
// safety decision ever appears in here, it is in the wrong place.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createAudit, createPolicy, createGate, createFileTransport } from '../core/index.mjs';
import { createBrowser } from '../agent/browser.mjs';
import { createModel, claudeTransport } from '../agent/model.mjs';
import { createActions } from '../agent/actions.mjs';
import { createLoop } from '../agent/loop.mjs';
import { renderReport } from '../agent/report.mjs';
import { loadConfig, KNOWN_KEYS } from './config.mjs';

const USAGE = `
  watcher <url> --task "what you want done" [options]

  A browsing agent that treats every page as untrusted.

  Required
    <url>                  the page to start from; its host must be allowed
    --task <text>          what you want done

  Allowlist  (nothing is fetched unless its host is on it)
    --allow <host>         add a host. Repeatable. Accepts *.example.com

  Safety
    --dry-run              run every check, perform no action. Use this first.

  Limits
    --max-steps <n>        default 8
    --max-cost <usd>       default 2.00, across the whole run
    --timeout <ms>         how long the gate waits for a human; default 300000

  Other
    --model <alias>        sonnet | opus | fable; default sonnet
    --mode <m>             read | tree | act; default read
    --audit <path>         event log; default results/audit.jsonl
    --config <path>        use this config file instead of searching upward
    --profile <name>       webcmd profile; default demo
    --json                 print the run as JSON instead of a report
    -h, --help             this message

  Config file: watcher.config.json, searched from the working directory
  upward. Known keys: ${KNOWN_KEYS.join(', ')}.

  There is no setting that disables the gate, the credential refusal or the
  detector. Those switches do not exist.
`;

export function parseArgs(argv) {
  const args = { url: null, task: null, dryRun: false, json: false, help: false, overrides: {}, configFile: undefined };
  const allow = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '-h': case '--help': args.help = true; break;
      case '--task': args.task = next(); break;
      case '--allow': allow.push(next()); break;
      case '--dry-run': args.dryRun = true; break;
      case '--json': args.json = true; break;
      case '--max-steps': args.overrides.maxSteps = Number(next()); break;
      case '--max-cost': args.overrides.maxCostUsd = Number(next()); break;
      case '--timeout': args.overrides.approvalTimeoutMs = Number(next()); break;
      case '--model': args.overrides.model = next(); break;
      case '--mode': args.overrides.snapshotMode = next(); break;
      case '--audit': args.overrides.auditPath = next(); break;
      case '--profile': args.overrides.profile = next(); break;
      case '--config': args.configFile = next(); break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option "${a}". Run watcher --help.`);
        else if (!args.url) args.url = a;
        else throw new Error(`unexpected argument "${a}"`);
    }
  }
  if (allow.length) args.overrides.allowHosts = allow;
  return args;
}

/**
 * A gate transport that asks on the terminal. Core ships a filesystem
 * transport and deliberately no more; serving or prompting is a consumer's
 * job, which is what this is. It answers the same three-method interface.
 *
 * Silence still fails closed: this only ever REPORTS an answer a human typed.
 * If nobody types one, poll keeps returning null and the gate times out into
 * a reject exactly as it would with no transport at all.
 */
export function createTerminalTransport({ input = process.stdin, output = process.stdout } = {}) {
  let answer = null;
  let currentId = null;
  let listening = false;

  function listen() {
    if (listening) return;
    listening = true;
    input.setEncoding('utf8');
    input.on('data', chunk => {
      const said = String(chunk).trim().toLowerCase();
      if (said === 'y' || said === 'yes' || said === 'approve') answer = 'approve';
      else if (said === 'n' || said === 'no' || said === 'reject') answer = 'reject';
      // Anything else is not an answer. Keep waiting.
    });
  }

  return {
    publish(pending) {
      currentId = pending.id;
      answer = null;
      listen();
      output.write('\n');
      output.write('  ############################################################\n');
      output.write('  #  BLOCKED — this action needs a human                     #\n');
      output.write('  ############################################################\n');
      output.write(`  verb     ${pending.verb}\n`);
      output.write(`  target   ${pending.target}\n`);
      output.write(`  summary  ${pending.summary}\n`);
      for (const [k, v] of Object.entries(pending.values || {})) {
        output.write(`  ${String(k).padEnd(8)} ${v}\n`);
      }
      output.write('\n  Approve? type y or n, then Enter. Nothing happens until you do.\n');
      output.write('  No answer within the timeout is a refusal.\n\n');
    },
    poll(expectedId) {
      if (expectedId !== currentId) return null;
      return answer;
    },
    clear(expectedId) {
      if (expectedId === currentId) { answer = null; currentId = null; }
    }
  };
}

export async function main(argv, { stdout = process.stdout, cwd = process.cwd() } = {}) {
  let args;
  try { args = parseArgs(argv); }
  catch (err) { stdout.write(`\n  ${err.message}\n`); return 1; }

  if (args.help || (!args.url && !args.task)) { stdout.write(USAGE); return args.help ? 0 : 1; }
  if (!args.url) { stdout.write('\n  Give me a URL to start from. Run watcher --help.\n'); return 1; }
  if (!args.task) { stdout.write('\n  Give me a task with --task. Run watcher --help.\n'); return 1; }

  let config;
  try { config = loadConfig({ cwd, overrides: args.overrides, file: args.configFile }); }
  catch (err) { stdout.write(`\n  ${err.message}\n`); return 1; }

  if (config.allowHosts.length === 0) {
    stdout.write('\n  The allowlist is empty, so nothing can be fetched.\n');
    stdout.write('  Add a host with --allow, or put allowHosts in watcher.config.json.\n');
    stdout.write('  This is deliberate: an agent with a default-open allowlist is an\n');
    stdout.write('  agent that will eventually read something you did not choose.\n\n');
    return 1;
  }

  const runId = randomUUID();
  const auditPath = path.resolve(cwd, config.auditPath);

  const audit = createAudit({ path: auditPath, runId });
  const policy = createPolicy({
    allowHosts: [...config.allowHosts],
    blockedVerbs: [...config.blockedVerbs],
    maxSteps: config.maxSteps,
    maxCostUsd: config.maxCostUsd,
    approvalTimeoutMs: config.approvalTimeoutMs
  });

  // A terminal prompt when someone is watching; files when nothing is. The
  // file paths are the ones server.mjs already reads and writes, so the
  // existing approval screen keeps working unchanged.
  const transport = process.stdin.isTTY
    ? createTerminalTransport({ output: stdout })
    : createFileTransport({
        pendingPath: path.resolve(cwd, 'results/gate-pending.json'),
        decisionPath: path.resolve(cwd, 'results/gate-decision.json')
      });

  const gate = createGate({ transport, timeoutMs: config.approvalTimeoutMs, audit });
  const browser = createBrowser({ profile: config.profile });
  const model = createModel({ transport: claudeTransport({ model: config.model }) });
  const actions = createActions({ policy, browser, gate, audit, dryRun: args.dryRun });
  const loop = createLoop({
    policy, browser, model, actions, audit,
    maxSteps: config.maxSteps,
    maxCostUsd: config.maxCostUsd,
    snapshotMode: config.snapshotMode
  });

  audit.record({ type: 'config', allowHosts: [...config.allowHosts], model: config.model,
    maxSteps: config.maxSteps, maxCostUsd: config.maxCostUsd, dryRun: args.dryRun,
    configPath: config.configPath });

  stdout.write(`\n  WATCHER — ${args.dryRun ? 'DRY RUN, ' : ''}allowlist: ${config.allowHosts.join(', ')}\n`);
  stdout.write(`  run ${runId}\n\n`);

  let result;
  try {
    result = await loop.run({ url: args.url, task: args.task });
  } catch (err) {
    stdout.write(`\n  WATCHER stopped: ${err.message}\n\n`);
    audit.record({ type: 'run_crashed', message: String(err.message || err) });
    await browser.close();
    return 1;
  } finally {
    if (process.stdin.isTTY) process.stdin.pause();
  }

  await browser.close();

  if (args.json) {
    stdout.write(JSON.stringify({ runId, url: args.url, task: args.task, dryRun: args.dryRun, ...result }, null, 2) + '\n');
  } else {
    stdout.write(renderReport({ url: args.url, task: args.task, result, auditPath, dryRun: args.dryRun }));
  }

  // 0 finished, 2 stopped on a challenge or the budget, 1 an error.
  if (result.halted === 'an unrecoverable error') return 1;
  if (result.halted === 'finished') return 0;
  return 2;
}
