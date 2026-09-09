// WATCHER CLI — configuration.
//
// watcher.config.json, discovered from the working directory upward, with CLI
// flags overriding file values.
//
// CONFIG IS DATA. It cannot enable a credential path, disable the gate, or
// disable detection — those keys do not exist, and this file refuses any key
// it does not recognise rather than ignoring it. Silently ignoring an unknown
// key is the dangerous behaviour: somebody writes "allowCredentials": true,
// sees no error, and believes it took effect. An explicit error says plainly
// that the switch they are reaching for is not there.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_NAME = 'watcher.config.json';

// The complete set of keys. Adding one here is a deliberate act; there is no
// pass-through.
export const KNOWN_KEYS = Object.freeze([
  'allowHosts',      // hostnames the agent may fetch. Empty means nothing.
  'blockedVerbs',    // EXTENDS the standard eight. It can never shorten them.
  'model',           // model alias passed to `claude -p`
  'maxSteps',
  'maxCostUsd',
  'approvalTimeoutMs',
  'snapshotMode',    // read | tree | act
  'auditPath',
  'profile'          // webcmd profile name
]);

// Keys somebody might reach for to turn a safety property off. Named
// explicitly so the error can say WHY, rather than just "unknown key".
const FORBIDDEN = new Map([
  ['allowCredentials', 'credential refusal is not configurable'],
  ['allowPasswords', 'credential refusal is not configurable'],
  ['fillCredentials', 'credential refusal is not configurable'],
  ['skipGate', 'the human gate is not configurable'],
  ['disableGate', 'the human gate is not configurable'],
  ['autoApprove', 'the human gate is not configurable'],
  ['requireApproval', 'the human gate is not configurable'],
  ['disableDetection', 'detection is not configurable'],
  ['skipDetect', 'detection is not configurable'],
  ['solveCaptcha', 'WATCHER never attempts a CAPTCHA'],
  ['allowAllHosts', 'the allowlist has no wildcard-everything form']
]);

export const DEFAULTS = Object.freeze({
  allowHosts: [],
  blockedVerbs: [],
  model: 'sonnet',
  // 8, not the spec's 20. Measured 2026-09-10: one `claude -p` call costs
  // $0.2181, almost all of it system-prompt overhead, so 20 steps is about
  // $4.40 — over the $2.00 default budget before the run even starts.
  maxSteps: 8,
  maxCostUsd: 2.0,
  approvalTimeoutMs: 300000,
  snapshotMode: 'read',
  auditPath: 'results/audit.jsonl',
  profile: 'demo'
});

/** Walk up from `startDir` looking for watcher.config.json. */
export function findConfigFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function validate(raw, source) {
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN.has(key)) {
      throw new Error(`${source}: "${key}" is not a setting — ${FORBIDDEN.get(key)}.`);
    }
    if (!KNOWN_KEYS.includes(key)) {
      throw new Error(`${source}: "${key}" is not a known setting. Known settings are: ${KNOWN_KEYS.join(', ')}`);
    }
  }

  if (raw.snapshotMode !== undefined && !['read', 'tree', 'act'].includes(raw.snapshotMode)) {
    throw new Error(`${source}: snapshotMode must be read, tree or act (got "${raw.snapshotMode}")`);
  }
  for (const key of ['maxSteps', 'maxCostUsd', 'approvalTimeoutMs']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !(raw[key] > 0))) {
      throw new Error(`${source}: ${key} must be a positive number (got ${JSON.stringify(raw[key])})`);
    }
  }
  for (const key of ['allowHosts', 'blockedVerbs']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      throw new Error(`${source}: ${key} must be an array of strings`);
    }
  }
  return raw;
}

/**
 * Load config: defaults, then the file, then CLI overrides.
 * @param {{cwd?:string, overrides?:object, file?:string|null}} [options]
 */
export function loadConfig({ cwd = process.cwd(), overrides = {}, file } = {}) {
  const configPath = file === undefined ? findConfigFile(cwd) : file;

  let fromFile = {};
  if (configPath) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`${configPath} is not valid JSON: ${err.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${configPath} must contain a JSON object`);
    }
    fromFile = validate(parsed, configPath);
  }

  const clean = validate({ ...overrides }, 'command line');
  const merged = { ...DEFAULTS, ...fromFile, ...clean };

  return Object.freeze({
    ...merged,
    allowHosts: Object.freeze([...merged.allowHosts]),
    blockedVerbs: Object.freeze([...merged.blockedVerbs]),
    configPath
  });
}
