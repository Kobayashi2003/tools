const DEFAULTS = {
  enabled: true,
  trigger: { type: 'modifier', value: 'alt', label: 'Alt' },
};

const toggle = document.getElementById('toggle-enabled');
const keyBtns = document.querySelectorAll('.key-btn');
const recordBtn = document.getElementById('record-btn');
const currentKey = document.getElementById('current-key');
const keyName = document.getElementById('key-name');

const MOD_LABEL = { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', meta: '⌘ / Win' };

function labelFor(e) {
  if (e.key === ' ') return 'Space';
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return e.key || e.code;
}

function paint(cfg) {
  toggle.checked = cfg.enabled;
  const t = cfg.trigger || DEFAULTS.trigger;
  keyBtns.forEach((b) =>
    b.classList.toggle('active', t.type === 'modifier' && b.dataset.key === t.value)
  );
  currentKey.textContent = t.label;
  keyName.textContent = t.label;
}

chrome.storage.sync.get(DEFAULTS, paint);

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: toggle.checked });
});

keyBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const value = btn.dataset.key;
    const trigger = { type: 'modifier', value, label: MOD_LABEL[value] };
    chrome.storage.sync.set({ trigger });
    paint({ enabled: toggle.checked, trigger });
  });
});

let recording = false;

function stopRecording() {
  recording = false;
  recordBtn.classList.remove('recording');
  recordBtn.textContent = 'Record a custom key…';
}

recordBtn.addEventListener('click', () => {
  recording = !recording;
  recordBtn.classList.toggle('recording', recording);
  recordBtn.textContent = recording ? 'Press any key…' : 'Record a custom key…';
});

window.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === 'Escape') {
    stopRecording();
    return;
  }
  // A bare modifier press records as a modifier trigger; anything else as a key.
  const bareMod = { Alt: 'alt', Control: 'ctrl', Shift: 'shift', Meta: 'meta' }[e.key];
  const trigger = bareMod
    ? { type: 'modifier', value: bareMod, label: MOD_LABEL[bareMod] }
    : { type: 'key', value: e.code, label: labelFor(e) };

  chrome.storage.sync.set({ trigger });
  stopRecording();
  paint({ enabled: toggle.checked, trigger });
});
