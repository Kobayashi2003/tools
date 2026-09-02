// Seed defaults on install so the popup and content script agree from the start.
const DEFAULTS = {
  enabled: true,
  trigger: { type: 'modifier', value: 'alt', label: 'Alt' },
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    chrome.storage.sync.set({ ...DEFAULTS, ...stored });
  });
});
