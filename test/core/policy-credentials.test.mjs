import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../../src/core/policy.mjs';

const policy = createPolicy({ allowHosts: ['localhost'] });

test('an ordinary field accepts an ordinary value', () => {
  const r = policy.canFill({ type: 'text', name: 'search', label: 'Search' }, 'cast iron skillet');
  assert.equal(r.allowed, true);
});

test('a password input is always refused', () => {
  const r = policy.canFill({ type: 'password', name: 'anything' }, 'hunter2');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /password/i);
});

test('credential-shaped field names are refused', () => {
  const names = [
    'password', 'passwd', 'pass', 'pin', 'cvv', 'cvc', 'otp', 'mfa', 'totp',
    'secret', 'token', 'api_key', 'apiKey', 'access_token', 'card_number',
    'cardnumber', 'ssn', 'social_security', 'passport'
  ];
  for (const name of names) {
    const r = policy.canFill({ type: 'text', name }, 'whatever');
    assert.equal(r.allowed, false, `field named "${name}" must be refused`);
  }
});

test('the label and placeholder are checked, not just the name', () => {
  assert.equal(policy.canFill({ type: 'text', name: 'f1', label: 'Card number' }, '1').allowed, false);
  assert.equal(policy.canFill({ type: 'text', name: 'f2', placeholder: 'One-time code' }, '1').allowed, false);
  assert.equal(policy.canFill({ type: 'text', id: 'user-pin' }, '1').allowed, false);
});

test('a card-number-shaped value is refused whatever the field is called', () => {
  // 4111 1111 1111 1111 is the standard Visa test number and passes Luhn.
  assert.equal(policy.canFill({ type: 'text', name: 'notes' }, '4111111111111111').allowed, false);
  assert.equal(policy.canFill({ type: 'text', name: 'notes' }, '4111 1111 1111 1111').allowed, false);
  assert.equal(policy.canFill({ type: 'text', name: 'notes' }, '4111-1111-1111-1111').allowed, false);
});

test('a number that fails Luhn is not treated as a card', () => {
  assert.equal(policy.canFill({ type: 'text', name: 'notes' }, '1234567812345678').allowed, true);
});

test('key-prefixed secrets are refused whatever the field is called', () => {
  const secrets = [
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'sk_live_abcdefghijklmnopqrstuvwx',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx'
  ];
  for (const s of secrets) {
    assert.equal(policy.canFill({ type: 'text', name: 'comment' }, s).allowed, false, `${s} must be refused`);
  }
});

test('long high-entropy values are refused', () => {
  const blob = 'aZ9kQ2mX7pL4vT8nR1sW6yB3cF5gH0jD2kM9nP4qS7tV1wY6zA8bC3eG5hJ0lN2p';
  assert.equal(policy.canFill({ type: 'text', name: 'comment' }, blob).allowed, false);
});

test('ordinary prose of the same length is not refused', () => {
  const prose = 'I have owned three cast iron pans and this is the first one where the surface arrived smooth';
  assert.equal(policy.canFill({ type: 'text', name: 'review' }, prose).allowed, true);
});

test('refusal cannot be configured away', () => {
  // No option, however spelled, may disable credential refusal.
  const attempts = [
    { allowHosts: ['localhost'], allowCredentials: true },
    { allowHosts: ['localhost'], allowPasswords: true },
    { allowHosts: ['localhost'], credentials: 'allow' },
    { allowHosts: ['localhost'], unsafe: true }
  ];
  for (const opts of attempts) {
    const p = createPolicy(opts);
    assert.equal(p.canFill({ type: 'password' }, 'x').allowed, false,
      `options ${JSON.stringify(opts)} must not enable credential filling`);
  }
});

test('canFill handles missing fields without throwing', () => {
  assert.equal(policy.canFill({}, '').allowed, true);
  assert.equal(policy.canFill(undefined, undefined).allowed, true);
});
