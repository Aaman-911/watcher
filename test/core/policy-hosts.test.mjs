import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../../src/core/policy.mjs';

const policy = createPolicy({ allowHosts: ['localhost', '127.0.0.1', '*.example.com'] });

test('exact hostname on the list is allowed', () => {
  assert.equal(policy.canVisit('http://localhost:8080/p1.html').allowed, true);
  assert.equal(policy.canVisit('http://127.0.0.1:8080/').allowed, true);
});

test('hostname not on the list is refused, with a reason', () => {
  const r = policy.canVisit('https://evil.test/page');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /evil\.test/);
  assert.match(r.reason, /allowlist/i);
});

test('wildcard matches subdomains but not the bare domain', () => {
  assert.equal(policy.canVisit('https://docs.example.com/x').allowed, true);
  assert.equal(policy.canVisit('https://a.b.example.com/x').allowed, true);
  assert.equal(policy.canVisit('https://example.com/x').allowed, false);
});

test('a lookalike host that merely contains an allowed name is refused', () => {
  // The classic mistake is substring matching. These must all fail.
  assert.equal(policy.canVisit('https://example.com.evil.test/x').allowed, false);
  assert.equal(policy.canVisit('https://notlocalhost/x').allowed, false);
  assert.equal(policy.canVisit('https://localhost.evil.test/x').allowed, false);
});

test('an allowed host appearing in the path or query does not grant access', () => {
  assert.equal(policy.canVisit('https://evil.test/?next=localhost').allowed, false);
  assert.equal(policy.canVisit('https://evil.test/localhost/x').allowed, false);
  assert.equal(policy.canVisit('https://evil.test/#https://localhost').allowed, false);
});

test('credentials embedded in the url do not spoof the host', () => {
  // https://localhost@evil.test/ has hostname evil.test, not localhost.
  assert.equal(policy.canVisit('https://localhost@evil.test/').allowed, false);
});

test('host comparison ignores case and trailing dot', () => {
  assert.equal(policy.canVisit('http://LOCALHOST:8080/').allowed, true);
  assert.equal(policy.canVisit('http://localhost./').allowed, true);
});

test('a malformed url is refused rather than throwing', () => {
  const r = policy.canVisit('not a url');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /could not be parsed/i);
});

test('non-http schemes are refused', () => {
  assert.equal(policy.canVisit('file:///etc/passwd').allowed, false);
  assert.equal(policy.canVisit('javascript:alert(1)').allowed, false);
  assert.equal(policy.canVisit('data:text/html,<h1>x</h1>').allowed, false);
});

test('the policy is immutable — its allowlist cannot be widened at runtime', () => {
  const p = createPolicy({ allowHosts: ['localhost'] });
  assert.equal(typeof p.allow, 'undefined');
  assert.throws(() => { p.allowHosts = ['evil.test']; }, /read only|readonly|not extensible|Cannot add|Cannot assign/i);
  assert.equal(p.canVisit('https://evil.test/').allowed, false);
});

test('limits are reported with defaults applied', () => {
  const p = createPolicy({ allowHosts: ['localhost'] });
  const l = p.limits();
  assert.equal(l.maxSteps, 20);
  assert.equal(l.maxCostUsd, 2);
  assert.equal(l.approvalTimeoutMs, 300000);
});
