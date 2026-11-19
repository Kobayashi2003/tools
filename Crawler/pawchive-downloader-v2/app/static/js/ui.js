import { esc } from './api.js';

// Pieces every page shares, so a panel looks finished in each of its states.

// A panel or page with nothing to show: a mark, one line, a hint, centred in the room it
// has, so the space reads as intentional rather than as something that failed to load.
export const emptyState = ({ icon = '', title, hint = '', action = '', key = 'empty' }) => `
  <div class="empty-state" data-key="${key}">
    ${icon ? `<span class="es-mark">${icon}</span>` : ''}
    <span class="es-t">${esc(title)}</span>
    ${hint ? `<span class="es-h">${hint}</span>` : ''}
    ${action}
  </div>`;

// Placeholder rows of the real rows' height, so a panel already has its final size while
// its data is on the way and nothing moves when it lands.
export const skeletonRows = (n, { height = 40, key = 'loading', lines = 2 } = {}) => `
  <div class="sk-rows" data-key="${key}" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => `
    <div class="sk-item" style="height:${height}px"><span class="sk sk-dot"></span><span class="sk-lines">
      <span class="sk sk-line" style="width:${[62, 48, 70, 55, 66, 40][i % 6]}%"></span>${lines > 1 ? `<span class="sk sk-line thin" style="width:${[30, 38, 24, 34, 28, 36][i % 6]}%"></span>` : ''}
    </span><span class="sk sk-num"></span></div>`).join('')}
  </div>`;
