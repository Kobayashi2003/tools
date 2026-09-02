const fullBtn       = document.getElementById('capture-full-btn');
const fullBtnLabel  = document.getElementById('capture-full-label');
const visibleBtn    = document.getElementById('capture-visible-btn');
const progressWrap  = document.getElementById('progress');
const progressFill  = document.getElementById('progress-fill');
const progressText  = document.getElementById('progress-text');
const statusEl      = document.getElementById('status');

const RESTRICTED_URL = /^(chrome|edge|about|chrome-extension):|^https:\/\/chrome\.google\.com\/webstore/;

let activeTab = null;

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  activeTab = tab;
  if (!tab || RESTRICTED_URL.test(tab.url || '')) {
    fullBtn.disabled = true;
    visibleBtn.disabled = true;
    showStatus('error', 'This page cannot be captured.');
    return;
  }
  // Reflect a full-page capture already running in the background (badge survives popup close/reopen).
  chrome.action.getBadgeText({ tabId: tab.id }, (text) => {
    if (text && text.includes('/')) setBusy(text);
  });
});

function setBusy(progressLabel) {
  fullBtn.disabled = true;
  visibleBtn.disabled = true;
  fullBtnLabel.textContent = 'Capturing…';
  progressWrap.classList.remove('hidden');
  progressText.textContent = progressLabel;
  const [cur, total] = progressLabel.split('/').map(Number);
  progressFill.style.width = total ? `${(cur / total) * 100}%` : '0%';
}

function setIdle() {
  fullBtn.disabled = false;
  visibleBtn.disabled = false;
  fullBtnLabel.textContent = 'Capture full page';
  progressWrap.classList.add('hidden');
}

function showStatus(kind, message) {
  statusEl.className = 'status ' + kind;
  statusEl.textContent = message;
}

function runCapture(mode) {
  if (!activeTab) return;
  statusEl.className = 'status hidden';
  if (mode === 'full') setBusy('0/0');
  else {
    fullBtn.disabled = true;
    visibleBtn.disabled = true;
  }

  chrome.runtime.sendMessage({ action: 'capture', mode, tabId: activeTab.id }, (res) => {
    setIdle();
    if (chrome.runtime.lastError) {
      showStatus('error', chrome.runtime.lastError.message);
      return;
    }
    if (!res || !res.ok) {
      showStatus('error', (res && res.error) || 'Unknown error');
      return;
    }
    showStatus('success', 'Saved ✓');
  });
}

fullBtn.addEventListener('click', () => runCapture('full'));
visibleBtn.addEventListener('click', () => runCapture('visible'));

// Live progress pushed from the background service worker while it's scrolling/capturing.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress' && activeTab && msg.tabId === activeTab.id) {
    setBusy(`${msg.current}/${msg.total}`);
  }
});
