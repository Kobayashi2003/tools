// A styled replacement for a native <select>, whose open list the browser draws in OS colours.
// The <select> stays in the page, hidden, and keeps the value: picking an option sets it and fires
// its `change` event, so code that reads or listens to the <select> needs no changes. Call
// `sync()` after changing the <select>'s value or option labels from code.

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

export function enhanceSelect(select) {
  const wrap = document.createElement('div');
  wrap.className = 'select';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'select-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'select-label';
  const chevron = document.createElement('span');
  chevron.className = 'select-chevron';
  chevron.innerHTML = CHEVRON;
  button.append(label, chevron);
  const list = document.createElement('ul');
  list.className = 'select-list';
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  list.hidden = true;
  wrap.append(button, list);
  select.after(wrap);
  select.hidden = true;
  if (select.getAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));

  let active = 0;
  const options = () => [...list.children];

  function sync() {
    label.textContent = select.selectedOptions[0]?.textContent ?? '';
    list.replaceChildren(...[...select.options].map((option, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.value = option.value;
      li.setAttribute('aria-selected', String(option.selected));
      li.innerHTML = CHECK;
      li.append(option.textContent);
      li.addEventListener('pointerenter', () => highlight(i));
      li.addEventListener('click', () => choose(i));
      return li;
    }));
  }

  function highlight(i) {
    const items = options();
    active = (i + items.length) % items.length;
    items.forEach((li, j) => li.classList.toggle('active', j === active));
    items[active]?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (!list.hidden) return;
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // Open upwards when there is no room below.
    const room = window.innerHeight - button.getBoundingClientRect().bottom;
    wrap.classList.toggle('up', room < list.offsetHeight + 12);
    highlight(Math.max(0, select.selectedIndex));
    list.focus({ preventScroll: true });
  }

  function close(refocus = true) {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus({ preventScroll: true });
  }

  function choose(i) {
    const changed = select.selectedIndex !== i;
    select.selectedIndex = i;
    sync();
    close();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  button.addEventListener('click', () => (list.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') highlight(active + 1);
    else if (e.key === 'ArrowUp') highlight(active - 1);
    else if (e.key === 'Home') highlight(0);
    else if (e.key === 'End') highlight(-1);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') { close(false); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!wrap.contains(e.target)) close(false);
  });

  sync();
  return { sync };
}
