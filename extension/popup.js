// WATCHER Shield — the popup.
//
// Asks the service worker what the active tab reported and renders it.
//
// Every string it renders came from a web page, so all of it goes in through
// textContent. Nothing here builds HTML from page-derived text: an extension
// that renders attacker-controlled strings as markup has handed the page a
// foothold inside the extension, which is a considerably worse outcome than
// the one it was built to warn about.

'use strict';

const siteEl = document.getElementById('site');
const bodyEl = document.getElementById('body');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEmpty(message) {
  bodyEl.replaceChildren(el('div', 'empty', message));
}

function render(record) {
  if (!record) {
    siteEl.textContent = 'no report for this tab';
    renderEmpty('This page has not been scanned. Reload it, or it may be a page extensions are not allowed to read (a browser settings page, the Chrome Web Store, or a PDF).');
    return;
  }

  siteEl.textContent = record.url || '';

  const findings = record.findings || [];
  const verdict = el('div', 'verdict ' + (findings.length ? 'warn' : 'clean'));

  if (!findings.length) {
    verdict.appendChild(el('span', 'count', 'Nothing found'));
    verdict.appendChild(document.createTextNode(
      `Scanned ${record.scannedChars.toLocaleString()} characters, including text hidden from view.`));
    bodyEl.replaceChildren(verdict);
    return;
  }

  verdict.appendChild(el('span', 'count',
    `${findings.length} instruction${findings.length === 1 ? '' : 's'} aimed at an AI`));
  // Two different claims, kept apart. "Hidden with CSS" is someone taking a
  // deliberate step. "In an attribute" is ordinary markup that merely happens
  // never to be displayed. Blurring them makes the warning worthless.
  const parts = [];
  if (record.concealed > 0) {
    parts.push(`${record.concealed} deliberately hidden from view`);
  }
  const inAttributes = (record.undisplayed || 0) - (record.concealed || 0);
  if (inAttributes > 0) {
    parts.push(`${inAttributes} in attributes that are never displayed`);
  }
  verdict.appendChild(document.createTextNode(
    parts.length ? parts.join(', ') + '.' : 'All of them in text visible on the page.'));

  const list = el('ul');
  for (const f of findings) {
    const item = el('li');
    item.appendChild(el('div', 'pattern', f.pattern));
    if (f.where) item.appendChild(el('div', 'where', f.where));
    item.appendChild(el('div', 'quote', f.text));
    list.appendChild(item);
  }

  bodyEl.replaceChildren(verdict, list);
}

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const tab = tabs && tabs[0];
  if (!tab || typeof tab.id !== 'number') {
    render(null);
    return;
  }
  chrome.runtime.sendMessage({ type: 'watcher:get', tabId: tab.id }, record => {
    // A missing service worker reply is not the same as a clean page, and
    // must not be drawn as one.
    if (chrome.runtime.lastError) { render(null); return; }
    render(record);
  });
});
