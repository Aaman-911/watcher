// The conformance suite, run against this project's own core.
//
// If WATCHER's own integration cannot pass the suite it publishes, the suite
// is either wrong or the claim is. Either way it must not ship green.
//
// This file also proves the suite CAN fail: it is run a second time against a
// deliberately broken integration, and every relevant check has to catch it.
// A conformance suite that passes everything is worth nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, createGate, detect, envelope } from '../../src/core/index.mjs';
import { runConformance, CHECK_IDS } from './suite.mjs';

const integration = {
  policy: createPolicy({ allowHosts: ['allowed.example', '*.corp.test'] }),
  makePolicy: (options = {}) => createPolicy({ allowHosts: ['allowed.example'], ...options }),
  makeGate: (options) => createGate(options),
  detect,
  envelope,
  allowedHost: 'allowed.example',
  wildcardHost: '*.corp.test'
};

test('WATCHER core passes its own conformance suite', async () => {
  const { passed, failed, skipped, results } = await runConformance(integration);
  const problems = results.filter(r => r.status === 'failed')
    .map(r => `  ${r.id} ${r.title}\n      ${r.message}`).join('\n');
  assert.equal(failed, 0, `conformance failures:\n${problems}`);
  assert.equal(skipped, 0, 'a check was skipped against our own integration');
  assert.equal(passed, CHECK_IDS.length);
});

test('the suite covers every invariant the spec names', () => {
  // Section 5 of the design: allowlist, verb gate, credentials. Plus the
  // envelope and the detector, which are what the other two protect.
  for (const prefix of ['HOST-', 'VERB-', 'CRED-', 'ENV-', 'DET-', 'GATE-']) {
    assert.ok(CHECK_IDS.some(id => id.startsWith(prefix)), `nothing checks ${prefix}`);
  }
  assert.ok(CHECK_IDS.length >= 20, `only ${CHECK_IDS.length} checks`);
});

test('the suite actually fails a broken integration', async () => {
  const broken = {
    // A policy that says yes to everything — the shape a careless consumer
    // ends up with when they wire the interface but not the rules.
    policy: {
      canVisit: () => ({ allowed: true, reason: 'sure' }),
      canAct: () => ({ allowed: true, needsApproval: false, reason: 'sure' }),
      canFill: () => ({ allowed: true, reason: 'sure' }),
      verbOfControl: () => null,
      limits: () => ({}),
      allowHosts: [],
      blockedVerbs: []
    },
    makePolicy: () => ({
      canVisit: () => ({ allowed: true }),
      canAct: () => ({ allowed: true, needsApproval: false }),
      canFill: () => ({ allowed: true }),
      verbOfControl: () => null
    }),
    makeGate: () => ({ request: async () => 'approve' }),   // fails OPEN
    // An envelope that just concatenates, which is the naive approach.
    envelope: ({ pageText, task }) => `${pageText}\n\n${task}`,
    detect: () => [],
    allowedHost: 'allowed.example',
    wildcardHost: '*.corp.test'
  };

  const { failed, results } = await runConformance(broken);
  assert.ok(failed >= 15, `a wide-open integration only failed ${failed} checks`);

  const failedIds = results.filter(r => r.status === 'failed').map(r => r.id);
  // The ones that matter most must be among them.
  for (const id of ['HOST-1', 'HOST-5', 'VERB-1', 'VERB-3', 'CRED-1', 'CRED-3',
                    'ENV-2', 'ENV-3', 'DET-1', 'GATE-1', 'GATE-2']) {
    assert.ok(failedIds.includes(id), `${id} passed a deliberately broken integration`);
  }

  // And a check that SHOULD still pass on a broken integration does: a
  // no-op detector produces no false positives, which is not a defence.
  assert.equal(results.find(r => r.id === 'DET-3').status, 'passed');
});

test('a partial integration is reported as skipped, never as passed', async () => {
  const partial = {
    policy: integration.policy,
    detect,
    envelope
    // no makePolicy, no makeGate, no wildcardHost
  };
  const { skipped, failed, results } = await runConformance(partial);
  assert.ok(skipped >= 5, `expected the factory-dependent checks to skip, got ${skipped}`);
  assert.equal(failed, 0);
  for (const r of results.filter(x => x.status === 'skipped')) {
    assert.ok(r.reason, `${r.id} skipped without saying why`);
  }
});
