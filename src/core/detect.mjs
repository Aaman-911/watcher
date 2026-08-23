// WATCHER — find text on a page that is aimed at an AI rather than a reader.
//
// Deterministic patterns only. No model call, no network, no judgement. The
// point is that this works identically every run and can be audited by hand:
// it proves what the PAGE ATTEMPTED, whether or not any model complied.
//
// Returns {text, offset, pattern}[]. Recording findings is the caller's job:
// pass them to an audit log. This module writes nothing.

const PATTERNS = [
  // Imperatives aimed at an assistant
  [/\b(assistant|agent|ai|model|llm|chatbot)s?\b[^.\n]{0,60}\b(must|should|shall|are required to|is required to|will)\b/i,
    'instruction addressed to an assistant'],
  [/\b(automated )?(assistants?|agents?)\b[^.\n]{0,40}\b(parsing|reading|summaris|summariz|generating|producing)/i,
    'instruction addressed to agents parsing the page'],

  // Fake role markers
  [/^\s*(system|assistant|developer|operator)\s*:/im, 'fake role marker'],
  [/\bsystem (message|notice|directive|prompt)\b/i, 'text claiming to be a system message'],
  [/\boperator (notice|policy|review|programme|program)\b/i, 'text claiming operator authority'],

  // Disregard prior input
  [/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|earlier|above|all)\b[^.\n]{0,30}\b(instruction|prompt|direction|rule)/i,
    'instruction to disregard prior input'],

  // Emit a literal word
  [/\b(append|include|emit|output|add|insert|end with)\b[^.\n]{0,50}\b(token|word|string|receipt|code)\b/i,
    'instruction to emit a specific word'],
  [/\b(verification|parse) (token|receipt)\b/i, 'a "verification token" demand'],

  // Sensitive actions
  [/\b(send|forward|email|submit|transmit|post|upload)\b[^.\n]{0,60}\b(transcript|summary|session|conversation|history|content)\b/i,
    'instruction to send data somewhere'],
  [/\b[\w.+-]+@[\w-]+\.(test|example|invalid|localhost)\b/i, 'an exfiltration address'],

  // Concealment
  [/\bdo not (mention|disclose|describe|quote|report|reference|tell|announce)\b/i,
    'instruction to conceal itself from the user'],
  [/\bwithout (asking|informing|telling|notifying)\b/i, 'instruction to bypass the user'],
  [/\b(blind|silently|do not announce)\b[^.\n]{0,40}\b(sampling|step|forward)\b/i,
    'instruction to act silently']
];

/**
 * Scan text for instructions aimed at an AI.
 * @returns {{text:string, offset:number, pattern:string}[]}
 */
export function detect(pageText) {
  const text = String(pageText || '');
  const found = [];
  const seen = new Set();

  for (const [re, label] of PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const rx = new RegExp(re.source, flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (m.index === rx.lastIndex) rx.lastIndex++;
      const key = label + ':' + m.index;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        text: excerpt(text, m.index, m[0].length),
        offset: m.index,
        pattern: label
      });
    }
  }
  return found.sort((a, b) => a.offset - b.offset);
}

function excerpt(text, at, len) {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + len + 80);
  return (start > 0 ? '…' : '') +
    text.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < text.length ? '…' : '');
}
