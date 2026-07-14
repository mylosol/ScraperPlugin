// background.js — Service worker
//
// Holds the Personal Access Token in memory ONLY, by design — it is never
// written to chrome.storage or any other disk-backed location. Chrome can
// terminate an idle service worker at any time (typically after ~30s of
// inactivity) and always does on browser restart or extension reload; when
// that happens this module re-executes from scratch and inMemoryPat resets
// to '', so the user has to paste their PAT again in Settings. That's the
// deliberate tradeoff for never persisting it.
let inMemoryPat = '';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[QA Update Scraper] Extension installed.');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'setInMemoryPat') {
    inMemoryPat = message.pat || '';
    sendResponse({ success: true });
    return true;
  }
  if (message.action === 'getInMemoryPat') {
    sendResponse({ pat: inMemoryPat });
    return true;
  }
});
