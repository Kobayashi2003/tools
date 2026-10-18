import { esc } from './api.js';

// A small modal for confirmations and short forms; the browser's own confirm() is not
// used so the wording can say exactly what will happen. A field's `options` are offered
// as suggestions while typing; any other value is still accepted.
export function dialog({ title, body = '', fields = [], confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `
      <form method="dialog" class="dlg-in">
        <h2>${esc(title)}</h2>
        ${body ? `<div class="dlg-body">${body}</div>` : ''}
        ${fields.map((f, i) => `
          <label class="dlg-field" for="dlg-${i}"><span>${esc(f.label)}</span>
            <span class="field"><input id="dlg-${i}" name="${esc(f.name)}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off" ${f.options ? `list="dlg-${i}-opts"` : ''}></span>
            ${f.options ? `<datalist id="dlg-${i}-opts">${f.options.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>` : ''}
            ${f.hint ? `<small>${esc(f.hint)}</small>` : ''}
          </label>`).join('')}
        <div class="dlg-actions">
          <button type="button" class="btn" value="cancel" data-cancel>Cancel</button>
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(confirm)}</button>
        </div>
      </form>`;
    document.body.appendChild(d);
    const finish = (value) => { d.close(); d.remove(); resolve(value); };
    d.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    d.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const values = {};
      fields.forEach((f, i) => { values[f.name] = d.querySelector(`#dlg-${i}`).value; });
      finish(values);
    });
    d.showModal();
    (d.querySelector('input') || d.querySelector('[type=submit]')).focus();
  });
}
