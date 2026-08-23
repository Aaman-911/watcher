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

// --- Fix round 1: snake_case/camelCase compounds, SSN values, PEM keys ---
//
// \b in a JS regex treats `_` as a word character, so a bare CREDENTIAL_FIELD
// term like \bsecret\b never matched inside `client_secret` — the whole
// compound read as one "word". Only the alternatives that were hand-given an
// explicit [-_ ]? separator (api_key, access_token, card_number,
// social_security, sort_code) survived contact with real-world field naming
// conventions. Everything else — snake_case OR camelCase — sailed through.

test('snake_case and camelCase compound field names are refused', () => {
  const names = [
    'client_secret', 'private_key', 'secret_key', 'session_token',
    'auth_code', 'pin_code', 'credential_id', 'otp_code',
    'mfaToken', 'totp_secret', 'ssn_number', 'routing_number',
    'iban_number', 'passport_number', 'cvv_code', 'pwd_hash'
  ];
  for (const name of names) {
    const r = policy.canFill({ type: 'text', name }, 'whatever');
    assert.equal(r.allowed, false, `field named "${name}" must be refused`);
  }
});

test('an SSN-shaped value is refused whatever the field is called', () => {
  assert.equal(policy.canFill({ type: 'text', name: 'notes' }, '123-45-6789').allowed, false);
  assert.equal(policy.canFill({ type: 'text', name: 'notes' }, '123456789').allowed, false);
});

test('a PEM private key block is refused', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA1c7YQ8f3n9examplekeymaterialexamplekeymaterial',
    '-----END RSA PRIVATE KEY-----'
  ].join('\n');
  assert.equal(policy.canFill({ type: 'text', name: 'notes' }, pem).allowed, false);
});

// The compound-name fix must not start catching ordinary fields that merely
// happen to share a substring or a naming style with a credential term.
test('the widened credential-field check does not catch ordinary fields', () => {
  const names = ['username', 'email', 'search', 'comment', 'review', 'address', 'firstname'];
  for (const name of names) {
    const r = policy.canFill({ type: 'text', name }, 'an ordinary value');
    assert.equal(r.allowed, true, `field named "${name}" must not be refused`);
  }
});
