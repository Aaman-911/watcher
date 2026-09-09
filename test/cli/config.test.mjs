// src/cli/config.mjs — config is data, and it cannot reach a safety switch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, findConfigFile, DEFAULTS, KNOWN_KEYS, CONFIG_NAME } from '../../src/cli/config.mjs';

function tempTree(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'watcher-cfg-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('with no config file, the defaults apply and nothing is fetchable', () => {
  const { root, cleanup } = tempTree();
  try {
    const c = loadConfig({ cwd: root, file: null });
    assert.deepEqual([...c.allowHosts], []);
    assert.equal(c.maxSteps, 8);
    assert.equal(c.maxCostUsd, 2.0);
    assert.equal(c.snapshotMode, 'read');
    // An empty allowlist means nothing is fetchable. That is the safe default,
    // not an oversight.
    assert.equal(DEFAULTS.allowHosts.length, 0);
  } finally { cleanup(); }
});

test('the config file is found by walking up from the working directory', () => {
  const { root, cleanup } = tempTree({
    [CONFIG_NAME]: { allowHosts: ['localhost'] },
    'a/b/c/.keep': ''
  });
  try {
    const found = findConfigFile(path.join(root, 'a', 'b', 'c'));
    assert.equal(found, path.join(root, CONFIG_NAME));
    const c = loadConfig({ cwd: path.join(root, 'a', 'b', 'c') });
    assert.deepEqual([...c.allowHosts], ['localhost']);
  } finally { cleanup(); }
});

test('command-line values override file values', () => {
  const { root, cleanup } = tempTree({ [CONFIG_NAME]: { allowHosts: ['localhost'], maxSteps: 5, model: 'sonnet' } });
  try {
    const c = loadConfig({ cwd: root, overrides: { maxSteps: 2, model: 'opus' } });
    assert.equal(c.maxSteps, 2);
    assert.equal(c.model, 'opus');
    assert.deepEqual([...c.allowHosts], ['localhost']);
  } finally { cleanup(); }
});

test('a key that tries to disable a safety property is refused, and says why', () => {
  const attempts = [
    ['allowCredentials', /credential refusal is not configurable/],
    ['allowPasswords', /credential refusal is not configurable/],
    ['fillCredentials', /credential refusal is not configurable/],
    ['skipGate', /gate is not configurable/],
    ['disableGate', /gate is not configurable/],
    ['autoApprove', /gate is not configurable/],
    ['disableDetection', /detection is not configurable/],
    ['skipDetect', /detection is not configurable/],
    ['solveCaptcha', /never attempts a CAPTCHA/],
    ['allowAllHosts', /no wildcard-everything form/]
  ];
  for (const [key, expected] of attempts) {
    const { root, cleanup } = tempTree({ [CONFIG_NAME]: { allowHosts: ['localhost'], [key]: true } });
    try {
      assert.throws(() => loadConfig({ cwd: root }), expected, `"${key}" was accepted`);
    } finally { cleanup(); }
  }
});

test('the same refusal applies to a command-line override, not just the file', () => {
  const { root, cleanup } = tempTree();
  try {
    assert.throws(() => loadConfig({ cwd: root, file: null, overrides: { skipGate: true } }),
      /gate is not configurable/);
  } finally { cleanup(); }
});

test('an unknown key is an error, never silently ignored', () => {
  // Ignoring it is the dangerous behaviour: somebody writes a setting, sees no
  // error, and believes it took effect.
  const { root, cleanup } = tempTree({ [CONFIG_NAME]: { allowHosts: ['localhost'], maxTokens: 500 } });
  try {
    assert.throws(() => loadConfig({ cwd: root }), /"maxTokens" is not a known setting/);
  } finally { cleanup(); }
});

test('blockedVerbs from config can only ADD to the standard eight', async () => {
  const { createPolicy } = await import('../../src/core/policy.mjs');
  const { root, cleanup } = tempTree({ [CONFIG_NAME]: { allowHosts: ['localhost'], blockedVerbs: [] } });
  try {
    const c = loadConfig({ cwd: root });
    const p = createPolicy({ allowHosts: [...c.allowHosts], blockedVerbs: [...c.blockedVerbs] });
    // An empty list in config does not empty the gate.
    for (const verb of ['send', 'submit', 'pay', 'buy', 'delete', 'message', 'post', 'transfer']) {
      assert.equal(p.canAct(verb).needsApproval, true, `${verb} stopped needing approval`);
    }
  } finally { cleanup(); }

  const t2 = tempTree({ [CONFIG_NAME]: { allowHosts: ['localhost'], blockedVerbs: ['archive'] } });
  try {
    const c = loadConfig({ cwd: t2.root });
    const p = createPolicy({ allowHosts: [...c.allowHosts], blockedVerbs: [...c.blockedVerbs] });
    assert.equal(p.canAct('archive').needsApproval, true);
    assert.equal(p.canAct('send').needsApproval, true);
  } finally { t2.cleanup(); }
});

test('bad values are rejected with a readable message', () => {
  const cases = [
    [{ snapshotMode: 'screenshot' }, /snapshotMode must be read, tree or act/],
    [{ maxSteps: 0 }, /maxSteps must be a positive number/],
    [{ maxSteps: -1 }, /maxSteps must be a positive number/],
    [{ maxCostUsd: 'lots' }, /maxCostUsd must be a positive number/],
    [{ allowHosts: 'localhost' }, /allowHosts must be an array/]
  ];
  for (const [obj, expected] of cases) {
    const { root, cleanup } = tempTree({ [CONFIG_NAME]: obj });
    try { assert.throws(() => loadConfig({ cwd: root }), expected); }
    finally { cleanup(); }
  }
});

test('a malformed config file is reported, not skipped', () => {
  const { root, cleanup } = tempTree({ [CONFIG_NAME]: '{ not json' });
  try { assert.throws(() => loadConfig({ cwd: root }), /is not valid JSON/); }
  finally { cleanup(); }
});

test('a config file that is not an object is refused', () => {
  const { root, cleanup } = tempTree({ [CONFIG_NAME]: '["localhost"]' });
  try { assert.throws(() => loadConfig({ cwd: root }), /must contain a JSON object/); }
  finally { cleanup(); }
});

test('the known-key list has no safety switch hiding in it', () => {
  for (const key of KNOWN_KEYS) {
    assert.ok(!/credential|password|gate|approve|detect|captcha|bypass|disable|skip/i.test(key),
      `"${key}" looks like a safety switch`);
  }
});

test('the loaded config cannot be mutated afterwards', () => {
  const { root, cleanup } = tempTree({ [CONFIG_NAME]: { allowHosts: ['localhost'] } });
  try {
    const c = loadConfig({ cwd: root });
    assert.throws(() => { c.allowHosts.push('evil.test'); }, TypeError);
    assert.throws(() => { 'use strict'; c.maxSteps = 999; }, TypeError);
  } finally { cleanup(); }
});
