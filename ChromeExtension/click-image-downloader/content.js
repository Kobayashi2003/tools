// Click Image Downloader — content script.
//
// Behaviour (only while the extension is enabled):
//   * Hold the configured modifier key (Alt by default) and move the mouse:
//     the image under the cursor is outlined and a badge shows its size.
//   * If several images overlap under the cursor, scroll the mouse wheel
//     (while holding the modifier) to cycle the highlight between them.
//   * Left-click while the modifier is held to download the highlighted image.

(() => {
  const MODIFIER_PROP = {
    alt: 'altKey',
    ctrl: 'ctrlKey',
    shift: 'shiftKey',
    meta: 'metaKey',
  };

  const cfg = { enabled: true, modifier: 'alt' };

  // Live state for the current overlapping-image stack under the cursor.
  let candidates = [];
  let activeIndex = 0;
  let lastSignature = '';
  let lastPointer = { x: 0, y: 0 };

  // --- settings -------------------------------------------------------------

  chrome.storage.sync.get(cfg, (stored) => Object.assign(cfg, stored));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled) cfg.enabled = changes.enabled.newValue;
    if (changes.modifier) cfg.modifier = changes.modifier.newValue;
    if (!cfg.enabled) clearHighlight();
  });

  function modifierActive(e) {
    const prop = MODIFIER_PROP[cfg.modifier] || 'altKey';
    return e[prop] === true;
  }

  // --- image detection ------------------------------------------------------

  function resolveUrl(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }

  function bgUrls(el) {
    const urls = [];
    const style = getComputedStyle(el);
    const bg = style.backgroundImage;
    if (bg && bg !== 'none') {
      for (const m of bg.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
        urls.push(resolveUrl(m[2]));
      }
    }
    return urls;
  }

  // Extract every image-like resource exposed by a single element.
  function imagesFromElement(el) {
    const out = [];
    const rect = el.getBoundingClientRect();
    const tag = el.tagName;

    if (tag === 'IMG') {
      const url = el.currentSrc || el.src;
      if (url) {
        out.push({
          url,
          element: el,
          rect,
          width: el.naturalWidth || Math.round(rect.width),
          height: el.naturalHeight || Math.round(rect.height),
          kind: 'img',
        });
      }
    } else if (tag === 'CANVAS') {
      try {
        const url = el.toDataURL('image/png');
        out.push({ url, element: el, rect, width: el.width, height: el.height, kind: 'canvas' });
      } catch {
        /* tainted canvas — cannot export */
      }
    } else if (el instanceof SVGSVGElement) {
      try {
        const xml = new XMLSerializer().serializeToString(el);
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
        out.push({
          url,
          element: el,
          rect,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          kind: 'svg',
        });
      } catch {
        /* ignore */
      }
    } else if (tag === 'VIDEO' && el.poster) {
      const url = resolveUrl(el.poster);
      out.push({ url, element: el, rect, width: el.videoWidth, height: el.videoHeight, kind: 'poster' });
    }

    // Any element may also carry a CSS background image.
    for (const url of bgUrls(el)) {
      out.push({
        url,
        element: el,
        rect,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        kind: 'background',
      });
    }

    return out;
  }

  // Collect, top-to-bottom, all unique images stacked under a point.
  function collectImages(x, y) {
    const els = document.elementsFromPoint(x, y);
    const found = [];
    const seen = new Set();
    for (const el of els) {
      if (el.dataset && el.dataset.cidOverlay) continue; // skip our own UI
      for (const item of imagesFromElement(el)) {
        if (item.url && !seen.has(item.url)) {
          seen.add(item.url);
          found.push(item);
        }
      }
    }
    return found;
  }

  function signatureOf(list) {
    return list.map((c) => c.url).join('\n');
  }

  // --- overlay UI -----------------------------------------------------------

  let box, badge;

  function ensureOverlay() {
    if (box) return;
    box = document.createElement('div');
    box.className = 'cid-highlight';
    box.dataset.cidOverlay = '1';
    badge = document.createElement('div');
    badge.className = 'cid-badge';
    badge.dataset.cidOverlay = '1';
    box.appendChild(badge);
    document.documentElement.appendChild(box);
  }

  function clearHighlight() {
    candidates = [];
    activeIndex = 0;
    lastSignature = '';
    if (box) box.style.display = 'none';
  }

  function shortName(url) {
    if (url.startsWith('data:')) return url.slice(5, url.indexOf(';') > 0 ? url.indexOf(';') : 20);
    try {
      const u = new URL(url);
      const base = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      return decodeURIComponent(base).slice(0, 40);
    } catch {
      return url.slice(0, 40);
    }
  }

  function renderHighlight() {
    if (!candidates.length) {
      clearHighlight();
      return;
    }
    ensureOverlay();
    const c = candidates[activeIndex];
    const r = c.element.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';

    const dims = c.width && c.height ? `${c.width}×${c.height}` : '';
    const counter = candidates.length > 1 ? `${activeIndex + 1}/${candidates.length} · scroll to switch · ` : '';
    badge.textContent = `${counter}${dims ? dims + ' · ' : ''}${shortName(c.url)}`;

    // Flip the badge below the box if there is no room above.
    badge.style.top = r.top < 24 ? '100%' : '';
    badge.style.bottom = r.top < 24 ? '' : '100%';
  }

  // --- download -------------------------------------------------------------

  function filenameFor(item) {
    if (item.kind === 'canvas') return `canvas-${Date.now()}.png`;
    if (item.kind === 'svg') return `image-${Date.now()}.svg`;
    try {
      const u = new URL(item.url);
      let name = u.pathname.split('/').filter(Boolean).pop();
      if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return decodeURIComponent(name);
    } catch {
      /* fall through */
    }
    return `image-${Date.now()}.${item.kind === 'svg' ? 'svg' : 'jpg'}`;
  }

  async function download(item) {
    let url = item.url;

    // blob: URLs created by the page are not reachable from the service
    // worker, so inline them as a data URL first.
    if (url.startsWith('blob:')) {
      try {
        const blob = await fetch(url).then((r) => r.blob());
        url = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      } catch (err) {
        flashBadge('✗ could not read blob image');
        return;
      }
    }

    chrome.runtime.sendMessage(
      { action: 'downloadImage', url, filename: filenameFor(item) },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          flashBadge('✗ ' + ((res && res.error) || chrome.runtime.lastError?.message || 'failed'));
        } else {
          flashBadge('✓ downloading');
        }
      }
    );
  }

  function flashBadge(text) {
    if (!badge) return;
    const prev = badge.textContent;
    badge.textContent = text;
    setTimeout(() => {
      if (badge.textContent === text) badge.textContent = prev;
    }, 1200);
  }

  // --- event wiring ---------------------------------------------------------

  function refreshAt(x, y) {
    lastPointer = { x, y };
    const next = collectImages(x, y);
    const sig = signatureOf(next);
    if (sig !== lastSignature) {
      // Different stack of images — reset selection to the top-most one.
      candidates = next;
      activeIndex = 0;
      lastSignature = sig;
    } else {
      candidates = next; // keep activeIndex; refresh rects/positions
    }
    renderHighlight();
  }

  document.addEventListener(
    'mousemove',
    (e) => {
      if (!cfg.enabled) return;
      if (!modifierActive(e)) {
        clearHighlight();
        return;
      }
      refreshAt(e.clientX, e.clientY);
    },
    true
  );

  // Cycle through overlapping images with the wheel while the modifier is held.
  document.addEventListener(
    'wheel',
    (e) => {
      if (!cfg.enabled || !modifierActive(e) || candidates.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY > 0 ? 1 : -1;
      activeIndex = (activeIndex + dir + candidates.length) % candidates.length;
      renderHighlight();
    },
    { capture: true, passive: false }
  );

  // Modifier + left click downloads the currently highlighted image.
  document.addEventListener(
    'click',
    (e) => {
      if (!cfg.enabled || e.button !== 0 || !modifierActive(e)) return;
      // Make sure the stack reflects the exact click point.
      refreshAt(e.clientX, e.clientY);
      if (!candidates.length) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      download(candidates[activeIndex]);
    },
    true
  );

  // Suppress the default mousedown action (e.g. image drag / link focus)
  // so the click feels like a clean capture.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!cfg.enabled || e.button !== 0 || !modifierActive(e)) return;
      if (collectImages(e.clientX, e.clientY).length) {
        e.preventDefault();
      }
    },
    true
  );

  // Keep the highlight glued to the image while the page scrolls.
  window.addEventListener(
    'scroll',
    () => {
      if (candidates.length) renderHighlight();
    },
    true
  );

  window.addEventListener('blur', clearHighlight);
})();
