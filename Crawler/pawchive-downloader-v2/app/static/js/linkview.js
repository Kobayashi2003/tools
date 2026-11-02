import { api, attempt, esc } from './api.js';
import { dialog } from './dialog.js';
import { I } from './icons.js';

// Cloud-storage links found in post text. A link a host can check shows whether it still
// opens; one a host can fetch is saved into its post's download folder under links/ and then
// counts as done. Anything else is opened in the browser and marked by hand.
// A check that finds a link dead marks it failed; one that finds a failed link alive again
// makes it new.
const STATES = [['new', 'New'], ['done', 'Done'], ['failed', 'Failed'], ['skipped', 'Skipped'], ['', 'All']];
const LABEL = { new: 'New', done: 'Done', skipped: 'Skipped', failed: 'Failed' };
const STATE_CHIP = { done: 'k-done', failed: 'k-failed', skipped: 'k-ignored' };
const CHECK = { alive: ['k-done', 'Alive'], dead: ['k-failed', 'Dead'], unknown: ['k-wait', 'Unknown'] };

let state = 'new';

function checkChip(l) {
  if (!l.check_state) return l.checker ? '<span class="chip muted" title="Not checked yet">Unchecked</span>' : '';
  const [cls, label] = CHECK[l.check_state] || ['', l.check_state];
  return `<span class="chip ${cls}" title="${esc(`${l.check_note || ''}${l.checked_at ? ` · checked ${l.checked_at.slice(0, 16).replace('T', ' ')} UTC` : ''}`)}">${label}</span>`;
}

const KEY_FROM = { text: 'key from the post text', manual: 'key entered by hand' };

function linkRow(l) {
  // A link posted without its key can be fetched once a key is in, or the text offers one.
  const fetchable = l.fetcher && l.state === 'new' && l.check_state !== 'dead' && (!l.needs_key || l.key_hints.length);
  const host = [
    l.needs_key && l.check_state !== 'dead' ? `<button class="linkbtn" type="button" data-key="${l.id}" title="${l.key_hints.length ? 'The post text has a likely key; check it or enter one' : 'Posted without its key: enter it'}">Key…</button>` : '',
    l.checker ? `<button class="linkbtn muted" type="button" data-check="${l.id}" title="Ask ${esc(l.checker)} whether it still opens">Check</button>` : '',
    fetchable ? `<button class="linkbtn" type="button" data-fetch="${l.id}" title="Save it into the post's download folder under links/">Fetch</button>` : '',
  ].join('');
  const acts = l.state === 'new'
    ? `${host}<button class="linkbtn" type="button" data-mark="done" data-ids="${l.id}">Done</button><button class="linkbtn muted" type="button" data-mark="skipped" data-ids="${l.id}">Skip</button>`
    : `${host}<span class="chip ${STATE_CHIP[l.state] || ''}">${LABEL[l.state] || l.state}</span><button class="linkbtn muted" type="button" data-mark="new" data-ids="${l.id}" title="Show it as new again">Undo</button>`;
  const said = l.fetch_error
    ? `Fetch failed: ${l.fetch_error}`
    : [l.check_state && l.check_note, l.key && KEY_FROM[l.key_source]].filter(Boolean).join(' · ');
  const note = said ? `<span class="lk-note ${l.fetch_error ? 'bad' : 'muted'}" title="${esc(said)}">${esc(said)}</span>` : '';
  return `<div class="lk-row ${l.state}">
    <span class="lk-host mono">${esc(l.host)}</span>
    <span class="lk-main"><a class="lk-url" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${esc(l.url)}${I.ext}</a>${note}</span>
    <a class="lk-post" href="#/c/${encodeURIComponent(l.creator_id)}" title="${esc(l.title)}"><span class="mono muted">${esc((l.published || '').slice(0, 10))}</span> ${esc(l.title)}</a>
    <span class="lk-acts">${checkChip(l)}${acts}</span></div>`;
}

export async function mountLinks(el, params) {
  const creator = params.get('creator') || '';
  el.innerHTML = '<div class="view"><div class="loading">Loading…</div></div>';
  let links = [];
  try {
    links = await api(`links?state=${state}${creator ? `&creator_id=${encodeURIComponent(creator)}` : ''}`);
  } catch (e) {
    el.innerHTML = `<div class="view"><div class="empty-note">${esc(e.message)}</div></div>`;
    return;
  }
  const groups = new Map();
  for (const l of links) {
    if (!groups.has(l.creator_id)) groups.set(l.creator_id, []);
    groups.get(l.creator_id).push(l);
  }
  const who = creator && links[0] ? links[0].creator_name : creator;
  el.innerHTML = `<div class="view">
    <div class="view-head"><div><h1>Links</h1><p class="lede">Cloud-storage links found in post text. Google Drive, MEGA and Dropbox links can be checked and fetched, GigaFile links checked: what a fetch saves goes into the post's download folder under <span class="mono">links/</span>, and the link counts as done. A check that finds a link dead marks it failed. Others are opened here and marked by hand.</p></div>
      <div class="seg" role="group" aria-label="Show">${STATES.map(([k, l]) => `<button type="button" data-state="${k}" aria-pressed="${state === k}">${l}</button>`).join('')}</div></div>
    ${creator ? `<div class="chips"><span class="chip">${esc(who)}</span><a class="linkbtn" href="#/links">All creators</a></div>` : ''}
    ${groups.size ? [...groups.entries()].map(([cid, items]) => {
      const fresh = items.filter((l) => l.state === 'new');
      const checkable = items.filter((l) => l.checker);
      const fetchable = fresh.filter((l) => l.fetcher && l.check_state !== 'dead' && (!l.needs_key || l.key_hints.length));
      return `<section class="panel lk-group">
        <div class="panel-head"><h2><a href="#/c/${encodeURIComponent(cid)}">${esc(items[0].creator_name)}</a> <span class="muted">${items.length.toLocaleString()}</span></h2>
          <span class="lk-bulk">
          ${checkable.length ? `<button class="btn" type="button" data-check="${checkable.map((l) => l.id).join(',')}">Check ${checkable.length}</button>` : ''}
          ${fetchable.length ? `<button class="btn" type="button" data-fetch="${fetchable.map((l) => l.id).join(',')}">${I.dl}Fetch ${fetchable.length}</button>` : ''}
          ${fresh.length ? `<button class="btn" type="button" data-mark="done" data-ids="${fresh.map((l) => l.id).join(',')}">${I.check}Mark ${fresh.length} done</button>` : ''}
          </span></div>
        <div class="lk-list">${items.map(linkRow).join('')}</div></section>`;
    }).join('') : `<div class="empty-note">${state === 'new' ? 'No new links.' : 'No links here.'}</div>`}
  </div>`;
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.state !== undefined) {
      state = b.dataset.state;
      mountLinks(el, params);
    } else if (b.dataset.mark) {
      const ids = b.dataset.ids.split(',').map(Number);
      const done = await attempt(() => api('links/state', { method: 'POST', body: { ids, state: b.dataset.mark } }));
      if (done) mountLinks(el, params);
    } else if (b.dataset.key) {
      const l = links.find((x) => x.id === Number(b.dataset.key));
      if (!l) return;
      const hints = l.key_hints;
      const got = await dialog({
        title: 'Decryption key',
        body: `<p class="mono" style="word-break:break-all">${esc(l.url)}</p><p>${hints.length
          ? `The post text holds ${hints.length > 1 ? `${hints.length} strings that look like its key; the likeliest is filled in` : 'a string that looks like its key; it is filled in'}. A check tries it against the host.`
          : 'Posted without its key, and the post text shows none. Paste the key (the part after # in the full link).'}</p>`,
        fields: [{ name: 'key', label: 'Key', value: hints[0] || '', options: hints.length > 1 ? hints : undefined, placeholder: 'e.g. N8fkV-FoUINJ1qg1Ra62BQ' }],
        confirm: 'Save and check',
      });
      if (!got || !got.key.trim()) return;
      const out = await attempt(() => api('links/key', { method: 'POST', body: { id: l.id, key: got.key.trim() } }), 'Key saved; checking');
      if (out) mountLinks(el, params);
    } else if (b.dataset.check || b.dataset.fetch) {
      const fetch = Boolean(b.dataset.fetch);
      const ids = (b.dataset.fetch || b.dataset.check).split(',').map(Number);
      const out = await attempt(
        () => api(`links/${fetch ? 'fetch' : 'check'}`, { method: 'POST', body: { ids } }),
        `${fetch ? 'Fetching' : 'Checking'} ${ids.length} link${ids.length > 1 ? 's' : ''}; see Jobs`,
      );
      if (out) b.disabled = true;
    }
  };
}
