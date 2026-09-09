// WATCHER agent — the human-readable run report.
//
// Prints what happened, in this order: what the agent did, what the page
// tried, and what was refused. The findings are printed whether or not the
// model complied with any of them, because the claim this project makes is
// about what the PAGE ATTEMPTED, which is knowable independently of any
// model's behaviour.

const rule = (n = 60) => '-'.repeat(n);
const indent = (text, pad = '  ') => String(text).split('\n').map(l => pad + l).join('\n');

export function renderReport({ url, task, result, auditPath, dryRun = false }) {
  const out = [];
  const { steps, answer, halted, findings, history, spent } = result;

  out.push('');
  out.push('  WATCHER');
  out.push('  ' + rule(7));
  out.push(`  page    ${url}`);
  out.push(`  task    ${task}`);
  out.push(`  steps   ${steps}`);
  out.push(`  spent   $${spent.usd.toFixed(4)} over ${spent.calls} model call${spent.calls === 1 ? '' : 's'}`);
  out.push(`  ended   ${halted}`);
  if (dryRun) out.push('  mode    DRY RUN — every check ran, no action was performed');
  out.push('');

  if (history.length) {
    out.push('  WHAT IT DID');
    out.push('  ' + rule(11));
    for (const h of history) {
      out.push(`  ${String(h.step).padStart(2)}. ${h.action.padEnd(9)} ${h.target}`);
      if (h.result !== 'done') out.push(`      ${h.result}`);
    }
    out.push('');
  }

  const refused = history.filter(h => h.result.startsWith('REFUSED'));
  if (refused.length) {
    out.push('  WHAT WAS REFUSED');
    out.push('  ' + rule(16));
    for (const h of refused) {
      out.push(`  step ${h.step}: ${h.action} ${h.target}`);
      out.push(`      ${h.result.replace(/^REFUSED: /, '')}`);
    }
    out.push('  These were refused in JavaScript, before anything happened.');
    out.push('');
  }

  out.push('  WATCHER CAUGHT');
  out.push('  ' + rule(14));
  if (!findings.length) {
    out.push('  Nothing. No text on any page read was aimed at an AI.');
  } else {
    const byUrl = new Map();
    for (const f of findings) {
      if (!byUrl.has(f.url)) byUrl.set(f.url, []);
      byUrl.get(f.url).push(f);
    }
    for (const [pageUrl, list] of byUrl) {
      out.push(`  ${pageUrl}`);
      for (const f of list) {
        out.push(`    [${f.pattern}]  at character ${f.offset}`);
        out.push(`        "${f.text}"`);
      }
    }
    out.push('');
    out.push(`  ${findings.length} finding${findings.length === 1 ? '' : 's'}. This is a deterministic scan: it reports`);
    out.push('  what the page attempted, whether or not the model complied.');
  }
  out.push('');

  if (answer) {
    out.push('  ANSWER');
    out.push('  ' + rule(6));
    out.push(indent(answer, '  '));
    out.push('');
  } else if (result.reason) {
    // A run that ended without an answer must still say WHY on screen. Without
    // this, a refused host printed "ended  an unrecoverable error" and nothing
    // else, and the actual reason — which the loop had all along — was only
    // discoverable by reading the audit log.
    out.push('  WHY IT STOPPED');
    out.push('  ' + rule(14));
    out.push(indent(result.reason, '  '));
    out.push('');
  }

  if (auditPath) {
    out.push(`  Full event log: ${auditPath}`);
    out.push('');
  }

  return out.join('\n');
}
