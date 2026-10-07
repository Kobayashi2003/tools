const DEFAULTS = {
  enabled: true,
  dblclick: true,
  modifierClick: true,
  modifier: 'alt',
  showButton: true,
  autoLike: false,
  scope: 'single',
  quoteMode: 'ask',
  template: 'twitter_{user-name}(@{user-id})_{date-time}_{status-id}_{file-type}',
  saveHistory: true,
};

const toggles   = document.querySelectorAll('input[type="checkbox"][data-key]');
const modBtns   = document.querySelectorAll('.key-btn');
const scopeBtns = document.querySelectorAll('.seg-btn[data-scope]');
const quoteBtns = document.querySelectorAll('.seg-btn[data-quote]');
const template  = document.getElementById('template');
const preview   = document.getElementById('preview');
const count     = document.getElementById('history-count');
const clearBtn  = document.getElementById('history-clear');

const SAMPLE = {
  'user-name': 'jack', 'user-id': 'jack', 'status-id': '20',
  'date-time': '20060321-205014', 'date-time-local': '20060321-135014',
  'file-type': 'photo', 'file-name': 'GaBcD123xyz',
};

function paintPreview() {
  const name = template.value.replace(/\{([\w-]+)\}/g, (m, k) => (k in SAMPLE ? SAMPLE[k] : m));
  preview.textContent = '→ ' + name + '.jpg';
}

function paint(cfg) {
  toggles.forEach((t) => (t.checked = cfg[t.dataset.key]));
  modBtns.forEach((b) => b.classList.toggle('active', b.dataset.mod === cfg.modifier));
  scopeBtns.forEach((b) => b.classList.toggle('active', b.dataset.scope === cfg.scope));
  quoteBtns.forEach((b) => b.classList.toggle('active', b.dataset.quote === cfg.quoteMode));
  template.value = cfg.template;
  paintPreview();
  document.body.classList.toggle('disabled', !cfg.enabled);
}

chrome.storage.sync.get(DEFAULTS, paint);

toggles.forEach((t) => {
  t.addEventListener('change', () => {
    chrome.storage.sync.set({ [t.dataset.key]: t.checked });
    if (t.dataset.key === 'enabled') document.body.classList.toggle('disabled', !t.checked);
  });
});

modBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    chrome.storage.sync.set({ modifier: btn.dataset.mod });
    modBtns.forEach((b) => b.classList.toggle('active', b === btn));
  });
});

scopeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    chrome.storage.sync.set({ scope: btn.dataset.scope });
    scopeBtns.forEach((b) => b.classList.toggle('active', b === btn));
  });
});

quoteBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    chrome.storage.sync.set({ quoteMode: btn.dataset.quote });
    quoteBtns.forEach((b) => b.classList.toggle('active', b === btn));
  });
});

// --- filename template ------------------------------------------------------

let saveTimer;
template.addEventListener('input', () => {
  paintPreview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set({ template: template.value.trim() || DEFAULTS.template });
  }, 300);
});

document.querySelectorAll('.tag').forEach((tag) => {
  tag.addEventListener('click', () => {
    const { selectionStart: s, selectionEnd: e, value } = template;
    template.value = value.slice(0, s) + tag.textContent + value.slice(e);
    template.selectionStart = template.selectionEnd = s + tag.textContent.length;
    template.focus();
    template.dispatchEvent(new Event('input'));
  });
});

document.getElementById('template-reset').addEventListener('click', (e) => {
  e.preventDefault();
  template.value = DEFAULTS.template;
  template.dispatchEvent(new Event('input'));
});

// --- history ----------------------------------------------------------------

function paintCount(history) {
  count.textContent = history.length.toLocaleString();
}

chrome.storage.local.get({ history: [] }, (s) => paintCount(s.history));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) paintCount(changes.history.newValue || []);
});

// One post URL per line, oldest first.
document.getElementById('history-export').addEventListener('click', () => {
  chrome.storage.local.get({ history: [] }, ({ history }) => {
    const text = history.map((id) => `https://x.com/i/status/${id}`).join('\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `x-media-history-${history.length}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});

// Two-step confirm instead of a dialog, which would close the popup.
let clearArmed = null;
clearBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearBtn.textContent = 'Click again to clear';
    clearArmed = setTimeout(() => {
      clearArmed = null;
      clearBtn.textContent = 'Clear';
    }, 2500);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  clearBtn.textContent = 'Clear';
  chrome.runtime.sendMessage({ action: 'clearHistory' });
});
