// WATCHER core — the public surface of the defence library.
//
// This file is the ONLY thing a consumer imports. Everything else in
// src/core is an implementation detail and may change.
//
// Core is pure: no browser, no network, no CLI, no npm dependencies. It
// takes text and intentions and returns findings, envelopes and verdicts.
// A test walks this directory's import graph and fails the build if that
// stops being true.

export const VERSION = '0.1.0';

export { createAudit } from './audit.mjs';
export { createPolicy } from './policy.mjs';
export { detect } from './detect.mjs';
export { envelope } from './envelope.mjs';
export { createGate, createFileTransport } from './gate.mjs';
