import { api, attempt, esc, toast } from './api.js';
import { I } from './icons.js';
import { fanbox } from './links.js';

function result(c, extra = '') {
  return `<div class="result">
    <div class="avatar sm">${esc((c.name || '?').slice(0, 1))}</div>
    <div class="result-main">
      <div class="result-name"><b>${esc(c.name)}</b><a class="ext mono" href="${esc(fanbox({ fanbox_creator_id: c.creator_id }))}" target="_blank" rel="noreferrer" title="Open on Fanbox">@${esc(c.creator_id)}${I.ext}</a>${extra}</div>
      <div class="d" title="${esc(c.description || c.title || '')}">${esc(c.description || c.title || '')}</div>
    </div>
    ${c.tracked ? `<a class="btn sm" href="#/c/fanbox_${esc(c.user_id)}">Open</a>` : `<button class="btn sm" type="button" data-add="@${esc(c.creator_id)}">${I.plus}Add</button>`}
  </div>`;
}

export function mountAdd(el, params, onAdded) {
  el.innerHTML = `<div class="view">
    <div class="view-head"><div><h1>Add creator</h1><p class="lede">Paste a link, or search Fanbox. A new creator is synced from Pawchive and their own site (Fanbox or Patreon).</p></div></div>
    <div class="cols">
    <div class="col">
    <section class="panel">
      <h2>Link or id</h2>
      <div class="form">
        <label class="lab" for="ref">Link</label>
        <div class="ctl"><label class="field"><input id="ref" value="${esc(params.get('ref') || '')}" placeholder="fanbox.cc/@name · patreon.com/name · pawchive.pw/fanbox/user/123 · pixiv user or post link · userId"></label>
          <div class="hint">A Fanbox @creatorId becomes the pixiv userId both sites share; a Patreon page or post link becomes the Patreon user id Pawchive uses.</div></div>
        <label class="lab" for="alias">Alias</label>
        <div class="ctl"><label class="field"><input id="alias" placeholder="Folder name (optional; the creator's own name otherwise)"></label></div>
        <label class="lab" for="grp">Group</label>
        <div class="ctl"><label class="field"><input id="grp" placeholder="e.g. 絵師/ロリメイン/T0 (optional)"></label></div>
        <span class="lab">Source first</span>
        <div class="ctl"><div class="seg" role="group" aria-label="Source first">${[['', 'Default'], ['fanbox-first', 'Their site'], ['pawchive-first', 'Pawchive']].map(([k, l]) => `<button type="button" data-pref="${k}" aria-pressed="${k === ''}">${l}</button>`).join('')}</div>
          <div class="hint">Their site is Fanbox or Patreon. Default follows Settings.</div></div>
        <span class="lab">Sync</span>
        <div class="ctl"><label class="check"><input type="checkbox" id="sync" checked> Sync right after adding</label></div>
        <span></span><div class="ctl"><button class="btn primary" type="button" data-addref>${I.plus}Add</button></div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Creators I support</h2><button class="btn sm" type="button" data-supporting>Load</button></div>
      <div class="results" id="sres"><div class="empty-note">Needs the Fanbox session (Settings).</div></div>
    </section>
    </div>
    <div class="col">
    <section class="panel">
      <h2>Search Fanbox</h2>
      <div class="row-inline nowrap"><label class="field grow">${I.search}<input id="fq" placeholder="Creator name or tag"></label><button class="btn" type="button" data-search>Search</button></div>
      <div class="results" id="fres"><div class="empty-note">Results appear here.</div></div>
    </section>
    </div>
    </div>
  </div>`;
  let pref = '';
  const add = async (ref) => {
    if (!ref.trim()) return toast('Paste a link first', true);
    const sync = el.querySelector('#sync').checked;
    const body = { ref, group: el.querySelector('#grp').value, alias: el.querySelector('#alias').value, preference: pref, sync };
    const out = await attempt(() => api('creators', { method: 'POST', body }));
    if (!out) return;
    toast(out.existing ? 'Already in the list' : sync ? 'Added; syncing' : 'Added');
    await onAdded();
    location.hash = `#/c/${encodeURIComponent(out.id)}`;
  };
  const doSearch = async () => {
    const q = el.querySelector('#fq').value.trim();
    if (!q) return;
    const box = el.querySelector('#fres');
    box.innerHTML = '<div class="loading">Searching…</div>';
    const rows = await attempt(() => api('fanbox/search?q=' + encodeURIComponent(q)));
    box.innerHTML = rows ? (rows.length ? rows.map((c) => result(c)).join('') : '<div class="empty-note">No results.</div>') : '';
  };
  el.querySelector('#fq').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  el.querySelector('#ref').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(e.target.value); });
  el.onclick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.pref !== undefined) {
      pref = t.dataset.pref;
      t.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === t)));
    } else if (t.dataset.addref !== undefined) add(el.querySelector('#ref').value);
    else if (t.dataset.add) add(t.dataset.add);
    else if (t.dataset.search !== undefined) doSearch();
    else if (t.dataset.supporting !== undefined) {
      const box = el.querySelector('#sres');
      box.innerHTML = '<div class="loading">Loading…</div>';
      const rows = await attempt(() => api('fanbox/supporting'));
      box.innerHTML = rows ? (rows.length ? rows.map((c) => result(c, `<span class="chip k-pending">¥${esc(c.fee)}</span>`)).join('') : '<div class="empty-note">You support no plans.</div>') : '';
    }
  };
  if (params.get('ref')) el.querySelector('#ref').focus();
}
