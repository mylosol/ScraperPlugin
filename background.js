// background.js — Service worker (minimal; state lives in storage)
chrome.runtime.onInstalled.addListener(() => {
  console.log('[QA Update Scraper] Extension installed.');
});
