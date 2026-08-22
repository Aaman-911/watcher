import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
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

// Every import-like specifier in a file, covering four distinct forms.
// Kept as separate named regexes (rather than one alternation) so each
// form's intent and edge cases stay legible on their own.
function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];

  // 1. Static import with bindings: `import x from 'y'`, `import {a,b} from
  //    'y'`, `import * as ns from 'y'`, `import x, {a} from 'y'`. Anchored
  //    to the start of a line (after only whitespace) so a commented-out
  //    `// import x from 'y'` can never match — the `//` breaks the anchor.
  const STATIC_IMPORT_FROM = /(?:^|\n)[ \t]*import\s[^'"]*from\s*['"]([^'"]+)['"]/g;

  // 2. Bare side-effect import: `import 'y';` — no bindings, no `from`.
  //    Same start-of-line anchor. Requires the quote to follow `import`
  //    with only whitespace in between, so it can never also match form 1
  //    (which requires `from`) or a dynamic `import(...)` (which has `(`
  //    right after `import`, not a quote). (Finding 1.)
  const BARE_IMPORT = /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;

  // 3. Re-export forms: `export { a } from 'y'`, `export * from 'y'`,
  //    `export * as ns from 'y'`. This is how src/core/index.mjs, the
  //    barrel file, will re-export every module added by later tasks —
  //    `export { detect } from './detect.mjs'` — so it must be caught.
  //    Same start-of-line anchor as form 1. (Finding 2.)
  const EXPORT_FROM = /(?:^|\n)[ \t]*export\s[^'"]*from\s*['"]([^'"]+)['"]/g;

  // 4. Dynamic import: `import('y')`. This can legally appear mid-statement
  //    (`const m = await import('y')`), so it can't use the same
  //    start-of-line anchor as the forms above. That means a fully
  //    commented-out line — `// import('y') is dangerous` — would
  //    otherwise false-positive. Guard against exactly that by skipping
  //    lines whose trimmed text starts with `//` before scanning them.
  //    Anything subtler (e.g. a trailing `// comment` after real code on
  //    the same line) is deliberately left as a false positive: failing
  //    safe here means never risking a missed real import just to keep a
  //    comment from being flagged. (Finding 4.)
  const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const re of [STATIC_IMPORT_FROM, BARE_IMPORT, EXPORT_FROM]) {
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }

  for (const line of src.split('\n')) {
    if (line.trim().startsWith('//')) continue;
    DYNAMIC_IMPORT.lastIndex = 0;
    let m;
    while ((m = DYNAMIC_IMPORT.exec(line)) !== null) out.push(m[1]);
  }

  return out;
}

// The two rules the guard enforces, factored out so the red-path test
// below ("the guard actually rejects...") can invoke the exact same
// checking logic as the two tests that run it over the real core files.
function isAllowedSpecifier(spec) {
  return spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
}

// Callers must only pass specs that are already known to be relative
// (spec.startsWith('.')) — mirrors how both call sites below use it.
function resolvesInsideCore(file, spec) {
  const resolved = path.resolve(path.dirname(file), spec);
  return resolved.startsWith(CORE + path.sep) || resolved === CORE;
}

test('core imports only node: builtins and its own relative files', () => {
  const files = coreFiles();
  assert.ok(files.length > 0, 'expected at least one file in src/core');

  for (const file of files) {
    for (const spec of importsOf(file)) {
      assert.ok(
        isAllowedSpecifier(spec),
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
      assert.ok(
        resolvesInsideCore(file, spec),
        `${path.relative(ROOT, file)} imports "${spec}" which resolves outside src/core`
      );
    }
  }
});

// Findings 1-4 fix: the two tests above pass vacuously today because the
// only committed file in src/core (index.mjs) has no imports at all — the
// per-import loops never run a single assertion. That proves the harness
// runs, not that the guard rejects anything. This test proves the guard
// actually goes red: it writes a real file into src/core containing one
// example of each disallowed form (plus a commented-out dynamic import,
// which must NOT be flagged), runs the same extraction and checking logic
// against it, and asserts the violations are caught — then removes the
// file in a `finally` so it's cleaned up even if an assertion throws.
test('the guard actually rejects a disallowed import (temp fixture)', () => {
  const badFile = path.join(CORE, `__boundary_violation_${process.pid}.mjs`);
  const violatingSource = [
    "import fs from 'node:fs';",
    "import bad from 'left-pad';",
    "import 'chalk';",
    "export { helper } from '../../lib/helper.mjs';",
    "const dyn = await import('lodash');",
    "// import('should-not-be-flagged') this is just a comment",
  ].join('\n') + '\n';

  writeFileSync(badFile, violatingSource);
  try {
    const specs = importsOf(badFile);

    // Sanity: extraction must have actually found each form, otherwise
    // the assertions below would pass for the wrong reason.
    assert.ok(specs.includes('node:fs'), 'expected the static-with-from control case to be detected');
    assert.ok(specs.includes('left-pad'), 'expected a static npm import to be detected');
    assert.ok(specs.includes('chalk'), 'expected a bare side-effect import to be detected (finding 1)');
    assert.ok(specs.includes('../../lib/helper.mjs'), 'expected a re-export-from to be detected (finding 2)');
    assert.ok(specs.includes('lodash'), 'expected a dynamic import to be detected');
    assert.ok(
      !specs.includes('should-not-be-flagged'),
      'expected a commented-out dynamic import to NOT be detected (finding 4)'
    );

    // Now prove the actual checking logic — the same predicates the two
    // tests above use — flags the bad ones and only the bad ones.
    const disallowed = specs.filter((spec) => !isAllowedSpecifier(spec));
    assert.deepEqual(
      disallowed.slice().sort(),
      ['chalk', 'left-pad', 'lodash'].sort(),
      'expected the disallowed-specifier check to flag exactly the three npm-style imports'
    );

    const escapesCore = specs
      .filter((spec) => spec.startsWith('.'))
      .filter((spec) => !resolvesInsideCore(badFile, spec));
    assert.deepEqual(
      escapesCore,
      ['../../lib/helper.mjs'],
      'expected the re-export path reaching outside src/core to be flagged'
    );
  } finally {
    rmSync(badFile, { force: true });
  }
});
