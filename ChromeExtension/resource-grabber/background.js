chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'grabResources') return;

  const { mode, pattern, tabId } = msg;

  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: scanFrame,
    args: [mode, pattern],
  })
  .then(results => {
    const allUrls = new Set();
    for (const frameResult of results) {
      if (frameResult.result) {
        frameResult.result.forEach(u => allUrls.add(u));
      }
    }
    sendResponse({ urls: [...allUrls] });
  })
  .catch(err => {
    sendResponse({ urls: [], error: err.message });
  });

  return true;
});

function scanFrame(mode, pattern) {
  const results = new Set();

  function resolveUrl(url) {
    try { return new URL(url, document.baseURI).href; }
    catch { return url; }
  }

  const urlAttrs = ['src', 'href', 'data-src', 'action'];
  document.querySelectorAll('*').forEach(el => {
    urlAttrs.forEach(attr => {
      const val = el.getAttribute(attr);
      if (val) results.add(resolveUrl(val));
    });

    const srcset = el.getAttribute('srcset');
    if (srcset) {
      srcset.split(',').forEach(s => {
        const u = s.trim().split(/\s+/)[0];
        if (u) results.add(resolveUrl(u));
      });
    }

    const style = el.getAttribute('style') || '';
    for (const m of style.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g)) {
      results.add(resolveUrl(m[1]));
    }
  });

  document.querySelectorAll('style').forEach(s => {
    for (const m of s.textContent.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g)) {
      results.add(resolveUrl(m[1]));
    }
  });

  const arr = [...results].filter(u => {
    if (!u.startsWith('http')) return false;
    if (mode === 'regex') {
      try { return new RegExp(pattern).test(u); }
      catch { return false; }
    } else {
      const exts = pattern.split(',').map(s => s.trim().toLowerCase().replace(/^\./, ''));
      try {
        const path = new URL(u).pathname.toLowerCase();
        return exts.some(ext => path.endsWith('.' + ext));
      } catch { return false; }
    }
  });

  return arr;
}