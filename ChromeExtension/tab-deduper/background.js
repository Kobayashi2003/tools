async function deduplicateTabs() {
  const tabs = await chrome.tabs.query({});
  const seen = new Map();
  const toClose = [];

  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl;
    if (!url || url.startsWith('chrome://')) continue;

    if (seen.has(url)) {
      toClose.push(tab.id);
    } else {
      seen.set(url, tab.id);
    }
  }

  if (toClose.length > 0) {
    await chrome.tabs.remove(toClose);
  }

  return { closed: toClose.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'deduplicate') {
    deduplicateTabs().then(sendResponse);
    return true;
  }
});