// WATCHER core — policy. The decision authority.
//
// Policy answers three questions: may we go there, may we do that, and may
// we type this. It answers them with JavaScript comparisons on data fixed at
// construction time.
//
// Nothing here consults a model, and nothing here can be widened at runtime.
// A page can say whatever it likes; it cannot reach these functions, and
// these functions do not read anything a page wrote.

// The eight verbs that always require a human. This list is a floor, not a
// default: `createPolicy({blockedVerbs})` extends it and can never shorten
// it — see effectiveBlockedVerbs below.
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
// name, id, label and placeholder — after normaliseIdentifier() below, so
// `\b` sees real word boundaries even where the source used snake_case,
// kebab-case, camelCase, or a letter/digit compound like "cvv2".
const CREDENTIAL_FIELD = /\b(pass(word|wd)?|pwd|pin|cvv|cvc|otp|one[-_ ]?time|mfa|totp|secret|token|key|api[-_ ]?key|access[-_ ]?token|auth|credential|card[-_ ]?number|cardnum|ccnum|ssn|social[-_ ]?security|passport|routing|iban|sort[-_ ]?code)\b/i;

// JavaScript's \b treats both `_` and digits as word characters, so
// `\bsecret\b` never matches inside `client_secret` (no boundary before
// "secret") and `\bcvv\b` never matches inside `cvv2` (no boundary after
// "cvv") — the whole compound reads as one "word" to the regex engine.
// Rather than hand-add separator handling to every alternative above (the
// gap that produced: client_secret, private_key, session_token, auth_code,
// ssn_number ... and separately cvv2, pin2, token1, password1 ... all
// returning allowed:true), normalise the identifier string first: split
// snake_case, kebab-case, camelCase AND letter/digit boundaries into real
// space-separated words, so `\b` lands where a human reader would put a
// word boundary. This can only make CREDENTIAL_FIELD match MORE identifiers
// than before, never fewer — every substring that matched pre-normalisation
// still appears in the normalised string, just with underscores, hyphens,
// case-boundaries and letter/digit boundaries turned into spaces.
function normaliseIdentifier(s) {
  return String(s || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // 'APIKey' -> 'API Key'
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // 'mfaToken' -> 'mfa Token'
    .replace(/([A-Za-z])(\d)/g, '$1 $2')         // 'cvv2' -> 'cvv 2', 'address2' -> 'address 2'
    .replace(/(\d)([A-Za-z])/g, '$1 $2')         // '2fa' -> '2 fa'
    .replace(/[_-]+/g, ' ')                      // 'client_secret' -> 'client secret'
    .toLowerCase();
}

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

// A US Social Security Number, dashed (123-45-6789) or bare (123456789).
// Unlike a card number there is no checksum to confirm against, so this is
// shape-only — refused regardless of what the field is named, same as
// looksLikeCardNumber.
function looksLikeSsn(value) {
  const v = String(value).trim();
  return /^\d{3}-\d{2}-\d{4}$/.test(v) || /^\d{9}$/.test(v);
}

// A PEM-encoded private key block, e.g. "-----BEGIN RSA PRIVATE KEY-----".
// These are typically many lines and contain whitespace/newlines, so they
// pass straight through looksLikeSecretBlob's no-whitespace gate — this
// check exists specifically to catch what that one cannot.
function looksLikePemKey(value) {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/i.test(String(value));
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

// The effective blocked-verb list for a policy. `extra` may only ADD verbs.
//
// This used to be `options.blockedVerbs || DEFAULT_BLOCKED_VERBS` — a
// REPLACEMENT — which meant `createPolicy({blockedVerbs: []})` produced a
// policy where canAct('send').needsApproval was false and
// verbOfControl({text:'Send'}) was null: the whole verb gate, clicks
// included, switched off by a config value, with no error and a green test
// board.
//
// §5.2 of the spec says those eight verbs ALWAYS require a human, and §6
// says "Config is data. It cannot enable a credential path, disable the
// gate, or disable detection." Those two safety clauses win over §3.1's
// looser wording. So the supplied list is UNIONED with the defaults: a
// consumer can add a verb its own product treats as sensitive ('archive',
// 'publish'), and it cannot remove one. The list only ever grows.
//
// Order is stable: the eight defaults in their documented order first, then
// any extras in the order supplied, deduplicated after lowercasing.
function effectiveBlockedVerbs(extra) {
  const verbs = [];
  for (const v of [...DEFAULT_BLOCKED_VERBS, ...(extra || [])]) {
    const lower = String(v).trim().toLowerCase();
    if (lower && !verbs.includes(lower)) verbs.push(lower);
  }
  return Object.freeze(verbs);
}

export function createPolicy(options = {}) {
  const allowHosts = Object.freeze([...(options.allowHosts || [])]);
  const blockedVerbs = effectiveBlockedVerbs(options.blockedVerbs);
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
    if (CREDENTIAL_FIELD.test(normaliseIdentifier(identifiers))) {
      return { allowed: false, reason: `field "${identifiers.trim()}" looks like a credential field; WATCHER never types credentials` };
    }

    const v = String(value ?? '');
    if (looksLikeCardNumber(v)) {
      return { allowed: false, reason: 'that value looks like a card number' };
    }
    if (looksLikeSsn(v)) {
      return { allowed: false, reason: 'that value looks like a social security number' };
    }
    if (looksLikePemKey(v)) {
      return { allowed: false, reason: 'that value looks like a PEM-encoded private key' };
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
