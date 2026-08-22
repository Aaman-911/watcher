// WATCHER core — policy. The decision authority.
//
// Policy answers three questions: may we go there, may we do that, and may
// we type this. It answers them with JavaScript comparisons on data fixed at
// construction time.
//
// Nothing here consults a model, and nothing here can be widened at runtime.
// A page can say whatever it likes; it cannot reach these functions, and
// these functions do not read anything a page wrote.

export const DEFAULT_BLOCKED_VERBS = [
  'send', 'submit', 'pay', 'buy', 'delete', 'message', 'post', 'transfer'
];

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
  [/\bconfirm\b/i, 'submit'],
  [/\bremove\b/i, 'delete'],
  [/\bunsubscribe\b/i, 'submit'],
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

  const policy = { canVisit, canAct, verbOfControl, limits: () => limits, allowHosts, blockedVerbs };
  return Object.freeze(policy);
}
