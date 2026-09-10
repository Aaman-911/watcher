// WATCHER Shield — the content script.
//
// Runs on every page you open. Collects what an AI reading the page would be
// given (which is more than you can see), scans it for instructions aimed at
// an assistant, and reports the count to the extension.
//
// It sends nothing to any server. The only message it emits goes to this
// extension's own service worker, in your browser. There is no fetch, no
// XMLHttpRequest, and no WebSocket in this file, and a check script enforces
// that rather than trusting this comment.
//
// This is a classic content script, not a module, so the two shared modules
// are pulled in with dynamic import() from web_accessible_resources. That
// keeps `detect.mjs` byte-identical to `src/core/detect.mjs` with no bundler
// and no build step.

(async () => {
  'use strict';

  // Re-scan when the page rewrites itself, but never faster than this, and
  // never more than a handful of times. A page that mutates continuously
  // (a feed, a ticker) must not turn the scanner into a CPU heater.
  const RESCAN_DEBOUNCE_MS = 1200;
  const MAX_SCANS = 8;

  let detect, collectPageText, segmentAt;
  try {
    ({ detect } = await import(chrome.runtime.getURL('core/detect.mjs')));
    ({ collectPageText, segmentAt } = await import(chrome.runtime.getURL('core/extract.mjs')));
  } catch (err) {
    // A page with a strict CSP can block the import. Fail quietly and
    // visibly-in-the-log rather than throwing into the page's console.
    console.debug('[WATCHER Shield] could not load its scanner on this page:', err && err.message);
    return;
  }

  let scans = 0;
  let lastSignature = '';

  function scan() {
    if (scans >= MAX_SCANS) return;
    scans += 1;

    let collected;
    try {
      collected = collectPageText(document, window);
    } catch (err) {
      console.debug('[WATCHER Shield] scan failed:', err && err.message);
      return;
    }

    const findings = detect(collected.text).map(f => {
      const segment = segmentAt(collected.segments, f.offset);
      return {
        pattern: f.pattern,
        text: f.text,
        // Where the instruction actually lived, and why you could not see it.
        // This is the part that makes the warning actionable rather than
        // merely alarming.
        where: segment ? segment.why : 'somewhere on this page',
        // concealed = someone deliberately hid it with CSS.
        // undisplayed = it never appears as page text (attributes included).
        concealed: segment ? !!segment.concealed : false,
        undisplayed: segment ? !!segment.undisplayed : false,
        tag: segment ? segment.tag || null : null
      };
    });

    // Only report when something changed, so a re-scan on a mutating page
    // does not spam the service worker.
    const signature = JSON.stringify(findings.map(f => f.pattern + f.text));
    if (signature === lastSignature) return;
    lastSignature = signature;

    const concealed = findings.filter(f => f.concealed).length;
    const undisplayed = findings.filter(f => f.undisplayed).length;

    try {
      chrome.runtime.sendMessage({
        type: 'watcher:findings',
        url: location.href,
        title: document.title,
        findings,
        concealed,
        undisplayed,
        scannedChars: collected.text.length,
        at: Date.now()
      });
    } catch {
      // The service worker may be asleep or the extension reloading. Losing a
      // report is acceptable; throwing into the page is not.
    }
  }

  scan();

  let timer = null;
  const observer = new MutationObserver(() => {
    if (scans >= MAX_SCANS) { observer.disconnect(); return; }
    clearTimeout(timer);
    timer = setTimeout(scan, RESCAN_DEBOUNCE_MS);
  });

  try {
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['aria-label', 'alt', 'title', 'style', 'class']
    });
  } catch { /* a document that cannot be observed is simply scanned once */ }
})();
