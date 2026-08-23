// COMPATIBILITY SHIM. Classification moved to src/core/outcome.mjs.
// loadManifest and findEntry stay here: they read this project's corpus, and
// core must not know the corpus exists.
// Plan 2 rewires the consumers and deletes this file.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export { classify, explain, STATES, MEANING } from '../src/core/outcome.mjs';

export function loadManifest(corpusDir) {
  return JSON.parse(readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'));
}

export function findEntry(manifest, urlOrFileOrId) {
  const name = String(urlOrFileOrId).split('/').pop().split('?')[0];
  return manifest.find(e => e.file === name || e.id === name || e.id === urlOrFileOrId) || null;
}
