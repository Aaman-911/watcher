// WATCHER core — policy. The decision authority.
//
// Policy answers three questions: may we go there, may we do that, and may
// we type this. It answers them with JavaScript comparisons on data fixed at
// construction time.
//
// Nothing here consults a model, and nothing here can be widened at runtime.
// A page can say whatever it likes; it cannot reach these functions, and
// these functions do not read anything a page wrote.

export const DEFAULT_BLOCKED_VERBS = Object.freeze([
  'send', 'submit', 'pay', 'buy', 'delete', 'message', 'post', 'transfer'
]);

const DEFAULTS = {
  maxSteps: 20,
  maxCostUsd: 2,
  approvalTimeoutMs: 300000
};

// Only these schemes are ever fetched. file: is excluded deliberately: an
// agent that can read file:// can read the whole disk, and the allowlist is
// expressed in hostnames, which file: URLs do not meaningfully have.
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Words that name a blocked verb without using the verb itself. A control
// reading "Place order" performs a purchase; one reading "Checkout" is the
// last step before one. Mapped to the verb they effectively perform.
const CONTROL_SYNONYMS = [
  [/\b(place|confirm)\s+(the\s+)?order\b/i, 'buy'],
  [/\bcheckout\b/i, 'buy'],
  [/\badd\s+to\s+(basket|cart|bag)\b/i, 'buy'],
  [/\bplace\s+bid\b/i, 'buy'],
  [/\bcomplete\s+(the\s+)?purchase\b/i, 'buy'],
  [/\bproceed\s+to\s+payment\b/i, 'buy'],
  [/\bconfirm\b/i, 'submit'],
  [/\bremove\b/i, 'delete'],
  [/\bunsubscribe\b/i, 'submit'],
  // \bsubscribe\b requires a word boundary immediately before "subscribe",
  // which "unsubscribe" never has (the "un" prefix is all word chars, so
  // there is no boundary between "un" and "subscribe") — this pattern
  // cannot fire on "unsubscribe", which is caught by the entry above.
  [/\bsubscribe\b/i, 'submit'],
  [/\bauthori(s|z)e\b/i, 'submit'],
  [/\bpublish\b/i, 'post'],
  [/\bshare\b/i, 'post'],
  [/\breply\b/i, 'message'],
  [/\bwithdraw\b/i, 'transfer'],
  [/\bdeposit\b/i, 'transfer']
];

function normaliseHost(host) {
  return String(host || '').toLowerCase().replace(/\.$/, '');
}

function hostMatches(host, pattern) {
  const h = normaliseHost(host);
  const p = normaliseHost(pattern);
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);            // '*.example.com' -> '.example.com'
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

// Field identifiers that mean "this is a secret". Matched against type,
// name, id, label and placeholder.
const CREDENTIAL_FIELD = /\b(pass(word|wd)?|pwd|pin|cvv|cvc|otp|one[-_ ]?time|mfa|totp|secret|token|api[-_ ]?key|access[-_ ]?token|auth|credential|card[-_ ]?number|cardnum|ccnum|ssn|social[-_ ]?security|passport|routing|iban|sort[-_ ]?code)\b/i;

// Values that are secrets regardless of where they are being typed.
const SECRET_VALUE = [
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^sk_(live|test)_[A-Za-z0-9]{16,}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^xox[baprs]-[A-Za-z0-9-]{20,}$/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./   // JWT
];

function looksLikeCardNumber(value) {
  const digits = String(value).replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  // Luhn
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Shannon entropy per character, in bits.
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeSecretBlob(value) {
  const v = String(value);
  // Prose has spaces. A long unbroken high-entropy run does not.
  if (v.length < 32 || /\s/.test(v)) return false;
  return entropy(v) > 3.5;
}

export function createPolicy(options = {}) {
  const allowHosts = Object.freeze([...(options.allowHosts || [])]);
  const blockedVerbs = Object.freeze(
    [...(options.blockedVerbs || DEFAULT_BLOCKED_VERBS)].map(v => String(v).toLowerCase())
  );
  const limits = Object.freeze({
    maxSteps: options.maxSteps ?? DEFAULTS.maxSteps,
    maxCostUsd: options.maxCostUsd ?? DEFAULTS.maxCostUsd,
    approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULTS.approvalTimeoutMs
  });

  function canVisit(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return { allowed: false, reason: `"${url}" could not be parsed as a URL` };
    }

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return { allowed: false, reason: `scheme ${parsed.protocol} is not fetchable; only http and https are` };
    }

    // parsed.hostname excludes userinfo, port, path, query and fragment, so
    // https://localhost@evil.test/ correctly yields evil.test.
    const host = parsed.hostname;
    const ok = allowHosts.some(p => hostMatches(host, p));
    return ok
      ? { allowed: true, reason: `${host} is on the allowlist` }
      : { allowed: false, reason: `${host} is not on the allowlist (${allowHosts.join(', ') || 'empty'})` };
  }

  function canAct(verb) {
    const v = String(verb || '').trim().toLowerCase();
    const needsApproval = blockedVerbs.includes(v);
    return {
      allowed: true,
      needsApproval,
      reason: needsApproval
        ? `"${v}" is a blocked verb and always needs a human`
        : `"${v}" is not a blocked verb`
    };
  }

  // What does this control actually DO? A click is not inherently safe: a
  // click on "Place order" is a purchase. Everything the control says about
  // itself is scanned, and an ambiguous control is treated as sensitive.
  function verbOfControl({ name, text, formAction } = {}) {
    const haystack = [text, name, formAction].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.trim()) return null;

    for (const verb of blockedVerbs) {
      if (new RegExp(`\\b${verb}\\b`, 'i').test(haystack)) return verb;
    }
    for (const [re, verb] of CONTROL_SYNONYMS) {
      if (re.test(haystack)) return verb;
    }
    return null;
  }

  // Credential refusal. THIS IS NOT CONFIGURABLE. There is deliberately no
  // option consulted here — not from `options`, not from config, not from
  // anywhere. An agent that can type a password can be made to leak one, and
  // no task this agent performs is worth that.
  function canFill(field = {}, value = '') {
    const f = field || {};
    if (String(f.type || '').toLowerCase() === 'password') {
      return { allowed: false, reason: 'this is a password input; WATCHER never types credentials' };
    }

    const identifiers = [f.type, f.name, f.id, f.label, f.placeholder]
      .filter(Boolean).join(' ');
    if (CREDENTIAL_FIELD.test(identifiers)) {
      return { allowed: false, reason: `field "${identifiers.trim()}" looks like a credential field; WATCHER never types credentials` };
    }

    const v = String(value ?? '');
    if (looksLikeCardNumber(v)) {
      return { allowed: false, reason: 'that value looks like a card number' };
    }
    if (SECRET_VALUE.some(re => re.test(v))) {
      return { allowed: false, reason: 'that value looks like an API key or token' };
    }
    if (looksLikeSecretBlob(v)) {
      return { allowed: false, reason: 'that value looks like a secret (long, unbroken, high entropy)' };
    }

    return { allowed: true, reason: 'not a credential field or value' };
  }

  const policy = { canVisit, canAct, canFill, verbOfControl, limits: () => limits, allowHosts, blockedVerbs };
  return Object.freeze(policy);
}
