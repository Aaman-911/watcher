// COMPATIBILITY SHIM. Implementation moved to src/core/gate.mjs, which takes
// its transport by injection. This reproduces the old API on top of it.
// Plan 2 rewires agents/watcher.mjs onto core and deletes this file.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGate, createFileTransport } from '../src/core/gate.mjs';
import { createPolicy } from '../src/core/policy.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = path.join(ROOT, 'results');

const policy = createPolicy({ allowHosts: [] });
export const BLOCKED_VERBS = [...policy.blockedVerbs];
export function isBlocked(verb) { return policy.canAct(verb).needsApproval; }

export async function requestApproval({ verb, target, summary, values = {}, timeoutMs = 300000 }) {
  const gate = createGate({
    transport: createFileTransport({
      pendingPath: path.join(RESULTS, 'gate-pending.json'),
      decisionPath: path.join(RESULTS, 'gate-decision.json')
    }),
    timeoutMs
  });
  console.log('');
  console.log('  ############################################################');
  console.log('  #  BLOCKED — this action needs a human                     #');
  console.log('  ############################################################');
  console.log(`  verb     ${verb}`);
  console.log(`  target   ${target}`);
  console.log(`  summary  ${summary}`);
  for (const [k, v] of Object.entries(values)) console.log(`  ${k.padEnd(8)} ${v}`);
  console.log('');
  console.log('  Approve or reject at  http://localhost:8080/approve');
  console.log('  Nothing happens until you decide. Waiting...');
  console.log('');
  return gate.request({ verb, target, summary, values });
}
