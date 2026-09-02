// Element Zapper — hold the trigger key and click an element to delete it.

const DEFAULTS = {
  enabled: true,
  trigger: { type: 'modifier', value: 'alt', label: 'Alt' },
};

let cfg = { ...DEFAULTS };
let keyHeld = false;        // tracks a held custom (non-modifier) trigger key
let highlighted = null;     // element currently outlined
const undoStack = [];       // { node, parent, next } records for Ctrl/Cmd+Z

chrome.storage.sync.get(DEFAULTS, (stored) => {
  cfg = { ...DEFAULTS, ...stored };
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.enabled) cfg.enabled = changes.enabled.newValue;
  if (changes.trigger) {
    cfg.trigger = changes.trigger.newValue;
    keyHeld = false;
    clearHighlight();
  }
});

// --- armed state -----------------------------------------------------------

function modifierActive(e) {
  return { alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey }[cfg.trigger.value];
}

// For modifier triggers we read live state off the mouse event; for custom
// keys we rely on the keydown/keyup-tracked `keyHeld` flag.
function isArmed(e) {
  if (!cfg.enabled) return false;
  if (cfg.trigger.type === 'modifier') return !!modifierActive(e);
  return keyHeld;
}

// --- highlight -------------------------------------------------------------

function isDeletable(el) {
  return el instanceof Element &&
    el !== document.documentElement &&
    el !== document.body;
}

function setHighlight(el) {
  if (highlighted === el) return;
  clearHighlight();
  if (!isDeletable(el)) return;
  highlighted = el;
  el.classList.add('__ez-highlight');
  if (document.body) document.body.classList.add('__ez-armed');
}

function clearHighlight() {
  if (highlighted) highlighted.classList.remove('__ez-highlight');
  highlighted = null;
  if (document.body) document.body.classList.remove('__ez-armed');
}

// --- deletion + undo -------------------------------------------------------

function removeElement(el) {
  if (!isDeletable(el) || !el.parentNode) return;
  const record = { node: el, parent: el.parentNode, next: el.nextSibling };
  clearHighlight();
  el.classList.remove('__ez-highlight');
  el.remove();
  undoStack.push(record);
  if (undoStack.length > 100) undoStack.shift();
}

function restoreLast() {
  const r = undoStack.pop();
  if (!r || !r.parent) return;
  if (r.next && r.next.parentNode === r.parent) {
    r.parent.insertBefore(r.node, r.next);
  } else {
    r.parent.appendChild(r.node);
  }
}

// --- listeners (capture phase, so we beat page handlers) --------------------

document.addEventListener('mousemove', (e) => {
  if (!isArmed(e)) {
    clearHighlight();
    return;
  }
  setHighlight(e.target);
}, true);

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !isArmed(e)) return;
  // Suppress focus, text selection, drag and Alt/Shift/Ctrl-click browser actions.
  e.preventDefault();
  e.stopPropagation();
}, true);

document.addEventListener('click', (e) => {
  if (e.button !== 0 || !isArmed(e)) return;
  e.preventDefault();
  e.stopPropagation();
  removeElement(e.target);
}, true);

window.addEventListener('keydown', (e) => {
  if (cfg.trigger.type === 'key' && e.code === cfg.trigger.value) keyHeld = true;

  // Undo last deletion with Ctrl+Z / Cmd+Z.
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && undoStack.length) {
    e.preventDefault();
    e.stopPropagation();
    restoreLast();
  }
}, true);

window.addEventListener('keyup', (e) => {
  if (cfg.trigger.type === 'key' && e.code === cfg.trigger.value) {
    keyHeld = false;
    clearHighlight();
  }
}, true);

// Releasing focus (tab switch, devtools) must disarm a held key.
window.addEventListener('blur', () => {
  keyHeld = false;
  clearHighlight();
});
