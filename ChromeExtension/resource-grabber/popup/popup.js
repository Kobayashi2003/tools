const modeTabBtns  = document.querySelectorAll('.mode-tab');
const groupRegex   = document.getElementById('group-regex');
const groupSuffix  = document.getElementById('group-suffix');
const inputRegex   = document.getElementById('input-regex');
const inputSuffix  = document.getElementById('input-suffix');
const btnGrab      = document.getElementById('btn-grab');
const statusEl     = document.getElementById('status');
const resultsWrap  = document.getElementById('results-wrap');
const resultsList  = document.getElementById('results-list');
const resultsCount = document.getElementById('results-count');
const btnCopy      = document.getElementById('btn-copy');
const btnDlAll     = document.getElementById('btn-download-all');

let currentMode = 'regex';
let lastResults = [];

modeTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeTabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    groupRegex.classList.toggle('hidden', currentMode !== 'regex');
    groupSuffix.classList.toggle('hidden', currentMode !== 'suffix');
  });
});

chrome.storage.local.get(['lastRegex', 'lastSuffix'], (d) => {
  if (d.lastRegex)  inputRegex.value  = d.lastRegex;
  if (d.lastSuffix) inputSuffix.value = d.lastSuffix;
});
inputRegex.addEventListener('input',  () => chrome.storage.local.set({ lastRegex:  inputRegex.value }));
inputSuffix.addEventListener('input', () => chrome.storage.local.set({ lastSuffix: inputSuffix.value }));

[inputRegex, inputSuffix].forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') btnGrab.click(); });
});

btnGrab.addEventListener('click', async () => {
  const pattern = currentMode === 'regex' ? inputRegex.value.trim() : inputSuffix.value.trim();
  if (!pattern) { showStatus('Please enter a pattern.', 'error'); return; }

  if (currentMode === 'regex') {
    try { new RegExp(pattern); }
    catch { showStatus('Invalid regular expression.', 'error'); return; }
  }

  btnGrab.disabled = true;
  showStatus('Scanning all frames...', 'info');
  resultsWrap.classList.add('hidden');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.runtime.sendMessage(
    { action: 'grabResources', mode: currentMode, pattern, tabId: tab.id },
    (res) => {
      btnGrab.disabled = false;
      if (chrome.runtime.lastError || !res) {
        showStatus('Error: ' + (chrome.runtime.lastError?.message || 'unknown'), 'error');
        return;
      }
      if (!res.urls || res.urls.length === 0) {
        showStatus('No matching resources found.', 'empty');
        return;
      }
      lastResults = res.urls;
      showStatus(`Found ${res.urls.length} resource(s)`, 'success');
      renderResults(res.urls);
    }
  );
});

function downloadUrl(url) {
  chrome.downloads.download({ url, conflictAction: 'uniquify' });
}

btnDlAll.addEventListener('click', () => {
  lastResults.forEach((url, i) => {
    setTimeout(() => downloadUrl(url), i * 100);
  });
  btnDlAll.textContent = `Downloading ${lastResults.length}...`;
  setTimeout(() => { btnDlAll.textContent = 'Download all'; }, lastResults.length * 100 + 500);
});

btnCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(lastResults.join('\n')).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy all'; }, 1500);
  });
});

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}

function getExt(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split('.');
    return parts.length > 1 ? parts.pop().slice(0, 5) : '?';
  } catch { return '?'; }
}

function renderResults(urls) {
  resultsWrap.classList.remove('hidden');
  resultsCount.textContent = `${urls.length} URL(s) found`;
  resultsList.innerHTML = '';

  urls.forEach(url => {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.title = url;

    const badge = document.createElement('span');
    badge.className = 'ext-badge';
    badge.textContent = getExt(url);

    const text = document.createElement('span');
    text.className = 'url-text';
    text.textContent = url.length > 55 ? url.slice(0, 26) + '…' + url.slice(-18) : url;

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'item-btn dl';
    dlBtn.textContent = 'dl';
    dlBtn.title = 'Download';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadUrl(url);
      dlBtn.textContent = 'ok';
      setTimeout(() => { dlBtn.textContent = 'dl'; }, 1200);
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'item-btn';
    copyBtn.textContent = 'copy';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(url);
      copyBtn.textContent = 'done';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
    });

    actions.appendChild(dlBtn);
    actions.appendChild(copyBtn);
    item.appendChild(badge);
    item.appendChild(text);
    item.appendChild(actions);
    resultsList.appendChild(item);
  });
}