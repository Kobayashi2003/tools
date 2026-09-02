// Page Screenshot — service worker.
//
// Two capture modes:
//  - visible: a single chrome.tabs.captureVisibleTab call, downloaded as-is.
//  - full page: find what actually scrolls (the document, or an inner
//    app-shell container if the document itself doesn't) -> hide fixed/sticky
//    elements that would duplicate -> step-scroll it, capturing each frame ->
//    stitch on an OffscreenCanvas -> restore the page -> download the PNG.

// chrome.tabs.captureVisibleTab is capped at ~2 calls/sec; this interval also
// doubles as the settle time for scroll/repaint/lazy-loaded images.
const CAPTURE_INTERVAL_MS = 550;
// Conservative ceiling shared by Chromium's 2D canvas backend.
const MAX_CANVAS_DIMENSION = 32000;
const MAX_CANVAS_AREA = 268000000;

const RESTRICTED_URL = /^(chrome|edge|about|chrome-extension):|^https:\/\/chrome\.google\.com\/webstore/;

let capturing = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'capture') return;
  const run = msg.mode === 'visible' ? captureVisibleOnly : captureFullPage;
  run(msg.tabId)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // async response
});

// Single-frame capture of just what's currently on screen — no scrolling.
async function captureVisibleOnly(tabId) {
  if (capturing) return { ok: false, error: 'A capture is already running.' };
  const tab = await chrome.tabs.get(tabId);
  if (!tab || RESTRICTED_URL.test(tab.url || '')) {
    return { ok: false, error: 'This page cannot be captured.' };
  }

  capturing = true;
  try {
    const dataUrl = await captureWithRetry(tab.windowId);
    const filename = suggestFilename(tab, 'screenshot');
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    notify('Screenshot saved', filename);
    return { ok: true, downloadId };
  } catch (err) {
    notify('Screenshot failed', String(err && err.message ? err.message : err));
    throw err;
  } finally {
    capturing = false;
  }
}

async function captureFullPage(tabId) {
  if (capturing) return { ok: false, error: 'A capture is already running.' };
  const tab = await chrome.tabs.get(tabId);
  if (!tab || RESTRICTED_URL.test(tab.url || '')) {
    return { ok: false, error: 'This page cannot be captured.' };
  }

  capturing = true;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });

  try {
    const metrics = await execIn(tabId, prepare);
    const targets = planScrollTargets(metrics);
    const shots = [];
    let lastY = -1;

    for (let i = 0; i < targets.length; i++) {
      const started = Date.now();
      const actualY = await execIn(tabId, scrollTo, [targets[i]]);
      if (actualY === lastY && shots.length > 0) break; // already at the bottom, nothing new to capture
      await sleep(Math.max(0, CAPTURE_INTERVAL_MS - (Date.now() - started)));

      const dataUrl = await captureWithRetry(tab.windowId);
      shots.push({ y: actualY, dataUrl });
      lastY = actualY;

      chrome.action.setBadgeText({ tabId, text: `${i + 1}/${targets.length}` });
      pushProgress(tabId, i + 1, targets.length);
    }

    await execIn(tabId, restore);

    const blob = await stitch(shots, metrics);
    const filename = suggestFilename(tab, 'fullpage');
    const downloadId = await downloadBlob(blob, filename);

    notify('Full-page screenshot saved', filename);
    return { ok: true, downloadId };
  } catch (err) {
    await execIn(tabId, restore).catch(() => {});
    notify('Screenshot failed', String(err && err.message ? err.message : err));
    throw err;
  } finally {
    capturing = false;
    chrome.action.setBadgeText({ tabId, text: '' });
  }
}

async function captureWithRetry(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    // Most likely the per-second capture quota; back off once and retry.
    await sleep(1000);
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execIn(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

function pushProgress(tabId, current, total) {
  chrome.runtime.sendMessage({ action: 'progress', tabId, current, total }).catch(() => {});
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title,
    message,
  });
}

// --- functions injected into the page (must be self-contained) ------------

function prepare() {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const docHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);

  // Default: the document itself scrolls (captureRect = the whole viewport).
  let root = document.scrollingElement || document.documentElement;
  let rect = { top: 0, left: 0, width: viewportWidth, height: viewportHeight };
  let contentHeight = docHeight;
  let mode = 'document';

  // Many app-shell layouts (Element UI's <el-main>, antd's Layout Content, ...)
  // keep <html>/<body> pinned to the viewport and scroll an inner container
  // instead. Detect that and fall back to the largest such container.
  if (docHeight - viewportHeight < 2) {
    let best = null;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      if (el.scrollHeight - el.clientHeight < 20) continue;
      if (el.clientHeight < viewportHeight * 0.4) continue; // ignore small widgets
      if (!best || el.clientHeight > best.clientHeight) best = el;
    }
    if (best) {
      const r = best.getBoundingClientRect();
      root = best;
      rect = { top: r.top, left: r.left, width: r.width, height: r.height };
      contentHeight = best.scrollHeight;
      mode = 'element';
    }
  }

  window.__fpsOriginal = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollBehavior: document.documentElement.style.scrollBehavior,
    rootScrollTop: mode === 'element' ? root.scrollTop : null,
  };
  document.documentElement.style.scrollBehavior = 'auto';
  window.__fpsScrollRoot = root;
  window.__fpsScrollMode = mode;

  // Fixed/sticky elements would otherwise be re-captured in every stacked
  // frame; hide them (visibility keeps their layout box, so nothing reflows).
  // In element-scroll mode only descendants of the scroll root duplicate —
  // chrome outside it (nav/sidebar) is captured once and left untouched.
  const hidden = [];
  for (const el of document.querySelectorAll('body *')) {
    if (mode === 'element' && !root.contains(el)) continue;
    const cs = getComputedStyle(el);
    if ((cs.position === 'fixed' || cs.position === 'sticky') && cs.visibility !== 'hidden') {
      hidden.push({ el, prevVisibility: el.style.visibility });
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }
  window.__fpsHidden = hidden;

  return { rect, contentHeight, step: rect.height, viewportWidth, viewportHeight, dpr: window.devicePixelRatio || 1 };
}

function scrollTo(y) {
  if (window.__fpsScrollMode === 'element' && window.__fpsScrollRoot) {
    window.__fpsScrollRoot.scrollTop = y;
    return window.__fpsScrollRoot.scrollTop;
  }
  window.scrollTo(0, y);
  return window.scrollY;
}

function restore() {
  if (window.__fpsHidden) {
    for (const { el, prevVisibility } of window.__fpsHidden) {
      if (prevVisibility) el.style.visibility = prevVisibility;
      else el.style.removeProperty('visibility');
    }
    delete window.__fpsHidden;
  }
  const o = window.__fpsOriginal;
  if (o) {
    if (window.__fpsScrollMode === 'element' && window.__fpsScrollRoot && o.rootScrollTop != null) {
      window.__fpsScrollRoot.scrollTop = o.rootScrollTop;
    }
    document.documentElement.style.scrollBehavior = o.scrollBehavior;
    window.scrollTo(o.scrollX, o.scrollY);
    delete window.__fpsOriginal;
  }
  delete window.__fpsScrollRoot;
  delete window.__fpsScrollMode;
}

// --- planning & stitching (run in the service worker) ----------------------

function planScrollTargets(metrics) {
  const maxY = Math.max(0, metrics.contentHeight - metrics.step);
  const targets = [];
  for (let y = 0; y < maxY; y += metrics.step) targets.push(Math.round(y));
  targets.push(maxY); // always end on an exact, clamped final frame
  return targets;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

// Stitches shots into one image. `metrics.rect` is the region of each frame
// that actually changes as the page/container scrolls (the full viewport in
// plain document-scroll mode, or just the inner container's box otherwise);
// everything outside it is static chrome and is only drawn once, from shot 0.
async function stitch(shots, metrics) {
  const bitmaps = await Promise.all(shots.map((s) => dataUrlToBitmap(s.dataUrl)));
  const dpr = metrics.dpr;
  const vw = bitmaps[0].width;
  const vh = bitmaps[0].height;

  const rectLeft = clamp(Math.round(metrics.rect.left * dpr), 0, vw - 1);
  const rectWidth = clamp(Math.round(metrics.rect.width * dpr), 1, vw - rectLeft);
  const rectTop = clamp(Math.round(metrics.rect.top * dpr), 0, vh - 1);
  const rectHeight = clamp(Math.round(metrics.rect.height * dpr), 1, vh - rectTop);
  const chromeBelowHeight = Math.max(0, vh - rectTop - rectHeight);

  const last = bitmaps.length - 1;
  // Later frames are drawn at their true (post-clamp) offset, so the overlap
  // with the previous frame near the bottom of the page is overwritten cleanly.
  const contentBandHeight = Math.round(shots[last].y * dpr) + rectHeight;

  const canvasHeight = rectTop + contentBandHeight + chromeBelowHeight;
  if (canvasHeight > MAX_CANVAS_DIMENSION || vw * canvasHeight > MAX_CANVAS_AREA) {
    throw new Error(`Page too tall to stitch (${vw}x${canvasHeight}px).`);
  }

  const canvas = new OffscreenCanvas(vw, canvasHeight);
  const ctx = canvas.getContext('2d');

  if (rectTop > 0) ctx.drawImage(bitmaps[0], 0, 0, vw, rectTop, 0, 0, vw, rectTop);

  shots.forEach((s, i) => {
    ctx.drawImage(
      bitmaps[i],
      rectLeft, rectTop, rectWidth, rectHeight,
      rectLeft, rectTop + Math.round(s.y * dpr), rectWidth, rectHeight
    );
  });

  if (chromeBelowHeight > 0) {
    ctx.drawImage(
      bitmaps[0],
      0, rectTop + rectHeight, vw, chromeBelowHeight,
      0, rectTop + contentBandHeight, vw, chromeBelowHeight
    );
  }

  return canvas.convertToBlob({ type: 'image/png' });
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function downloadBlob(blob, filename) {
  // URL.createObjectURL is unreliable in extension service workers, so encode
  // the PNG as a data URL by hand instead (chunked to stay under btoa's arg limit).
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const url = `data:image/png;base64,${btoa(binary)}`;
  return chrome.downloads.download({ url, filename, saveAs: false });
}

function suggestFilename(tab, prefix) {
  let host = 'page';
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep default */
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}-${host}-${stamp}.png`.replace(/[^a-z0-9.-]/gi, '_');
}
