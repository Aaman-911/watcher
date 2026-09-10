// WATCHER Shield — the service worker.
//
// Holds what each tab reported and paints the badge. Nothing here talks to a
// network, and nothing is persisted beyond the session: findings are about the
// page you are looking at now, and keeping a durable record of every page a
// person visits would be a worse thing to build than the problem it solves.

const perTab = new Map();

// Amber, not red. This is a "look at this" signal, not "you have been
// attacked" — a page can carry text aimed at an AI for dull reasons, and a
// badge that cries wolf gets ignored.
const BADGE_COLOUR = '#b45309';

function paint(tabId, count) {
  const text = count === 0 ? '' : (count > 99 ? '99+' : String(count));
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOUR }).catch(() => {});
  }
  chrome.action.setTitle({
    tabId,
    title: count > 0
      ? `WATCHER Shield — ${count} instruction${count === 1 ? '' : 's'} aimed at an AI on this page`
      : 'WATCHER Shield — nothing aimed at an AI on this page'
  }).catch(() => {});
}

function clear(tabId) {
  perTab.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  // The popup asking what the active tab reported.
  if (message.type === 'watcher:get') {
    sendResponse(perTab.get(message.tabId) || null);
    return false;
  }

  if (message.type !== 'watcher:findings') return false;

  // Must have come from a page we injected into. Everything inside the
  // message is page-derived data and is never treated as an instruction; the
  // fields are copied out by name and coerced, so an unexpected key cannot
  // ride along into storage or the popup.
  if (!sender.tab || typeof sender.tab.id !== 'number') return false;

  const findings = (Array.isArray(message.findings) ? message.findings : [])
    .slice(0, 200)
    .map(f => ({
      pattern: String(f.pattern || ''),
      text: String(f.text || '').slice(0, 500),
      where: String(f.where || ''),
      concealed: !!f.concealed,
      undisplayed: !!f.undisplayed,
      tag: f.tag ? String(f.tag).slice(0, 20) : null
    }));

  perTab.set(sender.tab.id, {
    url: String(message.url || ''),
    title: String(message.title || ''),
    findings,
    concealed: findings.filter(f => f.concealed).length,
    undisplayed: findings.filter(f => f.undisplayed).length,
    scannedChars: Number(message.scannedChars) || 0,
    at: Number(message.at) || Date.now()
  });

  paint(sender.tab.id, findings.length);
  return false;
});

// A tab that goes away takes its findings with it.
chrome.tabs.onRemoved.addListener(clear);

// A new page in the same tab starts clean, so a warning about the previous
// page can never appear to belong to this one.
//
// This keys on `status`, NOT on `changeInfo.url`. Without the "tabs"
// permission — which this extension deliberately does not request — Chrome
// strips `url` from changeInfo, so a condition requiring it would never fire
// and a stale badge would sit over the next page you visited.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') clear(tabId);
});
