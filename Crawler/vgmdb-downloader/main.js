// ==UserScript==
// @name         VGMdb Images Downloader (GM_download)
// @namespace    https://example.com/
// @version      1.0
// @description  Download all cover images from VGMdb pages using GM_download.
// @match        https://vgmdb.net/*
// @run-at       document-end
// @grant        GM_download
// ==/UserScript==

(function () {
  'use strict';

  function sanitize(name) {
    return name.trim()
      .replace(/[\\/*?:"<>|]/g, '_')
      .replace(/\s+/g, ' ');
  }

  function downloadAll() {
    const items = document.querySelectorAll('#cover_gallery a.highslide');
    if (!items.length) return;

    items.forEach(a => {
      const url = a.href;
      const labelEl = a.querySelector('h4.label');
      if (!url || !labelEl) return;

      const title = sanitize(labelEl.textContent);
      const extMatch = url.match(/\.[a-zA-Z0-9]+(?=$|\?)/);
      const ext = extMatch ? extMatch[0] : '.jpg';
      const filename = `${title}${ext}`;

      GM_download({
        url,
        name: filename,
        saveAs: false
      });
    });
  }

  function addButton() {
    const container = document.querySelector('#cover_gallery');
    if (!container) return;

    const btn = document.createElement('button');
    btn.textContent = 'Download All Images';
    btn.style.margin = '8px';
    btn.onclick = downloadAll;
    container.parentNode.insertBefore(btn, container);
  }

  addButton();
})();