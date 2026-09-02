const DEFAULTS = { enabled: true, modifier: 'alt' };

const toggle   = document.getElementById('toggle-enabled');
const keyBtns  = document.querySelectorAll('.key-btn');
const keyName  = document.getElementById('key-name');
const keyName2 = document.getElementById('key-name-2');

const LABEL = { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', meta: '⌘ / Win' };

function paint(cfg) {
  toggle.checked = cfg.enabled;
  keyBtns.forEach((b) => b.classList.toggle('active', b.dataset.key === cfg.modifier));
  keyName.textContent = LABEL[cfg.modifier] || 'Alt';
  keyName2.textContent = LABEL[cfg.modifier] || 'Alt';
}

chrome.storage.sync.get(DEFAULTS, paint);

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: toggle.checked });
});

keyBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const modifier = btn.dataset.key;
    chrome.storage.sync.set({ modifier });
    keyBtns.forEach((b) => b.classList.toggle('active', b === btn));
    keyName.textContent = LABEL[modifier];
    keyName2.textContent = LABEL[modifier];
  });
});
