import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = path.join(ROOT, 'src', 'core');

function coreFiles(dir = CORE, found = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) coreFiles(full, found);
    else if (full.endsWith('.mjs')) found.push(full);
  }
  return found;
}

// Every `import ... from '<specifier>'` and `import('<specifier>')`.
function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  const re = /(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1] || m[2]);
  return out;
}

test('core imports only node: builtins and its own relative files', () => {
  const files = coreFiles();
  assert.ok(files.length > 0, 'expected at least one file in src/core');

  for (const file of files) {
    for (const spec of importsOf(file)) {
      const isBuiltin = spec.startsWith('node:');
      const isRelative = spec.startsWith('./') || spec.startsWith('../');
      assert.ok(
        isBuiltin || isRelative,
        `${path.relative(ROOT, file)} imports "${spec}" — core may only import node: builtins or relative files`
      );
    }
  }
});

test('core never reaches outside src/core', () => {
  const files = coreFiles();
  for (const file of files) {
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      assert.ok(
        resolved.startsWith(CORE + path.sep) || resolved === CORE,
        `${path.relative(ROOT, file)} imports "${spec}" which resolves outside src/core`
      );
    }
  }
});
