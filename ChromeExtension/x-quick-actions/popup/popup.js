const DEFAULTS = {
  enabled: true,
  dblclickAction: 'download',
  modClickAction: 'download',
  modifier: 'alt',
  showButton: true,
  buttonLike: false,
  scope: 'single',
  quoteMode: 'ask',
  template: 'twitter_{user-name}(@{user-id})_{date-time}_{status-id}_{file-type}',
  saveHistory: true,
};

const cfg = { ...DEFAULTS };
const toggles  = document.querySelectorAll('input[type="checkbox"][data-key]');
const segs     = document.querySelectorAll('.seg[data-setting]');
const template = document.getElementById('template');
const preview  = document.getElementById('preview');
const count    = document.getElementById('history-count');
const clearBtn = document.getElementById('history-clear');

const SAMPLE = {
  'user-name': 'jack', 'user-id': 'jack', 'status-id': '20',
  'date-time': '20060321-205014', 'date-time-local': '20060321-135014',
  'file-type': 'photo', 'file-name': 'GaBcD123xyz',
};

function save(key, value) {
  cfg[key] = value;
  chrome.storage.sync.set({ [key]: value });
  paint();
}

function paintPreview() {
  preview.textContent = template.value.replace(/\{([\w-]+)\}/g, (m, k) => (k in SAMPLE ? SAMPLE[k] : m)) + '.jpg';
}

// Controls that only matter when another setting is on are dimmed otherwise.
function paint() {
  toggles.forEach((t) => (t.checked = cfg[t.dataset.key]));
  segs.forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === cfg[seg.dataset.setting]));
  });
  document.querySelectorAll('[data-needs]').forEach((el) => {
    const v = cfg[el.dataset.needs];
    el.classList.toggle('inactive', v === false || v === 'none');
  });
  document.body.classList.toggle('disabled', !cfg.enabled);
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  Object.assign(cfg, stored);
  template.value = cfg.template;
  paintPreview();
  paint();
});

toggles.forEach((t) => t.addEventListener('change', () => save(t.dataset.key, t.checked)));

segs.forEach((seg) => {
  seg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => save(seg.dataset.setting, b.dataset.value));
  });
});

// --- filename template ------------------------------------------------------

let saveTimer;
template.addEventListener('input', () => {
  paintPreview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save('template', template.value.trim() || DEFAULTS.template), 300);
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

// One post URL per line, oldest first — the same format Import reads.
document.getElementById('history-export').addEventListener('click', () => {
  chrome.storage.local.get({ history: [] }, ({ history }) => {
    const text = history.map((id) => `https://x.com/i/status/${id}`).join('\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `x-quick-actions-history-${history.length}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});

// Accepts post URLs or bare ids, one per line; merged into the current list.
const fileInput = document.getElementById('history-file');
document.getElementById('history-import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  const ids = (await file.text())
    .split(/\r?\n/)
    .map((line) => (line.match(/\/status\/(\d+)/) || line.match(/^\s*(\d+)\s*$/) || [])[1])
    .filter(Boolean);
  if (ids.length) chrome.runtime.sendMessage({ action: 'addHistory', ids });
});

// Two-step confirm instead of a dialog, which would close the popup.
let clearArmed = null;
clearBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearBtn.textContent = 'Confirm';
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
