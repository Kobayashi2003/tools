// Service worker: receives download requests from content scripts and
// performs the actual download via the chrome.downloads API.

const DEFAULTS = { enabled: true, modifier: 'alt' };

// Seed default settings on install so the popup and content scripts agree.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    chrome.storage.sync.set(cfg);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'downloadImage') return;

  chrome.downloads.download(
    {
      url: msg.url,
      filename: msg.filename || undefined,
      conflictAction: 'uniquify',
      saveAs: false,
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, downloadId });
      }
    }
  );

  return true; // keep the message channel open for the async response
});
