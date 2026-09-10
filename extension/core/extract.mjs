// WATCHER Shield — collect what an AI reading this page would see.
//
// This is the heart of the extension, and the reason it is worth having.
//
// A human reads `innerText`. A language model reading the same page is handed
// far more: attribute text it never renders, and elements the CSS hid. The
// whole class of attack this project is about lives in that gap — text that is
// present to the machine and absent to you.
//
// So this module deliberately collects MORE than a person can see, and labels
// each piece with WHY it was invisible. "We found something" is far less
// useful than "there is a paragraph here painted the same colour as the page
// behind it, and it is addressed to an assistant".
//
// Pure functions where the logic lives, so they can be tested without a
// browser. The single DOM-walking function is exercised in a real browser by
// the integration suite instead.

// Anything shorter than this is noise: an empty alt, a one-word label.
const MIN_SEGMENT = 12;

const ATTRIBUTES = ['aria-label', 'aria-description', 'aria-roledescription',
                    'alt', 'title', 'placeholder', 'data-tooltip'];

/**
 * Parse a CSS colour into {r,g,b,a}. Handles the forms getComputedStyle
 * actually returns — rgb(), rgba(), and the keyword `transparent`. Returns
 * null for anything it cannot read, and callers treat null as "unknown",
 * never as "fine".
 */
export function parseColour(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
  return { r: +m[1], g: +m[2], b: +m[3], a };
}

// WCAG relative luminance, used for the contrast ratio below.
function luminance({ r, g, b }) {
  const f = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two opaque colours: 1 (identical) to 21. */
export function contrastRatio(fg, bg) {
  if (!fg || !bg) return null;
  const l1 = luminance(fg), l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Why is this element invisible to a person? Returns a human-readable reason,
 * or null if it is plainly visible.
 *
 * `style` is a getComputedStyle result (or any object with the same keys).
 * `background` is the effective background colour behind the element, which
 * the caller resolves by walking ancestors — an element's own background is
 * usually `transparent`, so comparing text colour against it would find every
 * page on the web guilty.
 *
 * @param {object} style
 * @param {string} background   a CSS colour string
 * @param {{width:number,height:number,top:number,left:number}} [box]
 */
export function describeConcealment(style, background, box) {
  if (!style) return null;

  if (style.display === 'none') return 'hidden with display:none';
  if (style.visibility === 'hidden' || style.visibility === 'collapse') {
    return `hidden with visibility:${style.visibility}`;
  }

  const opacity = parseFloat(style.opacity);
  if (!Number.isNaN(opacity) && opacity <= 0.05) return `made transparent (opacity ${style.opacity})`;

  const fontSize = parseFloat(style.fontSize);
  if (!Number.isNaN(fontSize) && fontSize < 1) return `shrunk to nothing (font-size ${style.fontSize})`;

  // A large negative text-indent is the classic "push it off the page" trick.
  const indent = parseFloat(style.textIndent);
  if (!Number.isNaN(indent) && indent <= -999) return `pushed off-screen (text-indent ${style.textIndent})`;

  // clip / clip-path collapsing the element to a point.
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(String(style.clip || ''))) {
    return 'clipped to zero size';
  }
  if (/inset\(\s*(100%|50%\s+50%)/.test(String(style.clipPath || ''))) return 'clipped away with clip-path';

  if (box) {
    if (box.width === 0 || box.height === 0) return 'collapsed to zero size';
    // Positioned far outside the viewport in any direction.
    if (box.left <= -1000 || box.top <= -1000) return 'positioned off-screen';
  }

  // The one that started this project: text painted the colour of the page
  // behind it. A contrast ratio at or below 1.2 is not "low contrast design",
  // it is concealment — WCAG's minimum for body text is 4.5.
  const fg = parseColour(style.color);
  const bg = parseColour(background);
  if (fg && fg.a === 0) return 'text colour is fully transparent';
  if (fg && bg && fg.a > 0 && bg.a > 0) {
    const ratio = contrastRatio(fg, bg);
    if (ratio !== null && ratio <= 1.2) {
      return `painted the same colour as its background (contrast ratio ${ratio.toFixed(2)}:1)`;
    }
  }

  return null;
}

/**
 * Attribute text carried by one element. None of this is rendered as page
 * text, and all of it reaches a model reading the accessibility tree.
 *
 * These are marked `undisplayed`, NOT `concealed`, and the distinction is not
 * pedantry. An aria-label is ordinary, correct accessibility markup that
 * appears on almost every well-built page — calling it concealment would make
 * the extension shout "text you cannot see!" at clean sites and teach you to
 * ignore the warning. Found against a real corpus page, which had a perfectly
 * innocent aria-label and was being reported as hiding something.
 *
 * `concealed` means a deliberate act of hiding: CSS that removes text from
 * view. An attribute carrying an injection is still reported as a finding —
 * the `why` says exactly where it lived — it simply is not counted as
 * concealment.
 */
export function attributeText(getAttribute) {
  const out = [];
  for (const name of ATTRIBUTES) {
    const value = getAttribute(name);
    if (typeof value === 'string' && value.trim().length >= MIN_SEGMENT) {
      out.push({
        text: value.trim(),
        why: `carried in the ${name} attribute, which is never displayed`,
        undisplayed: true
      });
    }
  }
  return out;
}

/**
 * De-duplicate and join segments into one blob for detect() to scan, keeping
 * the offset of each segment so a finding can be traced back to where it came
 * from.
 */
export function assemble(segments) {
  const seen = new Set();
  const kept = [];
  let text = '';
  for (const seg of segments) {
    const clean = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < MIN_SEGMENT) continue;
    const key = seg.why + ' ' + clean;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...seg, text: clean, offset: text.length, length: clean.length });
    text += clean + '\n\n';
  }
  return { text, segments: kept };
}

/** Which segment does a character offset in the assembled text fall inside? */
export function segmentAt(segments, offset) {
  for (const s of segments) {
    if (offset >= s.offset && offset < s.offset + s.length) return s;
  }
  return null;
}

/**
 * Walk a live document and collect everything a model would be given.
 *
 * Runs only in a browser. The logic it depends on — describeConcealment,
 * attributeText, assemble — is pure and unit-tested; this function is
 * exercised against real pages in a real browser by the integration suite.
 *
 * @param {Document} doc
 * @param {Window} win
 */
export function collectPageText(doc, win) {
  const segments = [];

  // 1. What a person sees. Included so an injection written in plain sight
  //    is still caught — concealment is common, not required.
  const visible = String(doc.body ? doc.body.innerText || '' : '');
  if (visible.trim()) {
    segments.push({ text: visible, why: 'visible on the page', concealed: false, undisplayed: false });
  }

  // Resolve the background actually behind an element: its own is usually
  // transparent, and comparing against that would accuse every page on the web.
  function effectiveBackground(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = win.getComputedStyle(node).backgroundColor;
      const parsed = parseColour(bg);
      if (parsed && parsed.a > 0) return bg;
      node = node.parentElement;
    }
    return 'rgb(255, 255, 255)';   // the browser's own default
  }

  const all = doc.body ? doc.body.querySelectorAll('*') : [];
  for (const el of all) {
    // 2. Attribute text, from every element regardless of visibility.
    for (const seg of attributeText(name => el.getAttribute(name))) {
      segments.push({ ...seg, concealed: false, tag: el.tagName.toLowerCase() });
    }

    // 3. Text hidden from a person. Only elements holding their OWN text are
    //    considered, so a hidden wrapper does not report its children's text
    //    a second time under the same reason.
    const own = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.nodeValue)
      .join(' ')
      .trim();
    if (own.length < MIN_SEGMENT) continue;

    let style, box;
    try {
      style = win.getComputedStyle(el);
      box = el.getBoundingClientRect();
    } catch { continue; }

    const why = describeConcealment(style, effectiveBackground(el), box);
    if (why) {
      segments.push({ text: own, why, concealed: true, undisplayed: true, tag: el.tagName.toLowerCase() });
    }
  }

  return assemble(segments);
}
