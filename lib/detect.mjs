// COMPATIBILITY SHIM. The implementation moved to src/core/detect.mjs.
// Plan 2 rewires the consumers onto core and deletes this file.
//
// quarantine() is preserved here, not in core: core writes nothing, and the
// audit log replaces this. Consumers still calling it get the old behaviour.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export { detect } from '../src/core/detect.mjs';

export function quarantine(rootDir, { url, findings }) {
  const dir = path.join(rootDir, 'results');
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, 'quarantine.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), url, count: findings.length, findings }) + '\n');
}
