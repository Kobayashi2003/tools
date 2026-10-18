import { api, at, attempt, esc, localTime, toast } from './api.js';
import { on } from './live.js';

const STATUS = {
  matched: ['k-done', 'Matched'], review: ['k-partial', 'Review'], ambiguous: ['k-partial', 'Ambiguous'],
  conflict: ['k-failed', 'Conflict'], unmatched: ['k-ignored', 'No post'], skipped: ['k-ignored', 'Skipped'],
};
const OFFSETS = [['', 'Infer'], ['0', 'UTC'], ['540', 'JST +9'], ['480', 'UTC+8'], ['custom', 'Other…']];
const PAGE = 200;

let M = null;

function steps(n) {
  const names = ['Choose', 'Parameters', 'Preview', 'Execute'];
  return `<ol class="steps">${names.map((s, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'cur' : ''}"><b>${i + 1}</b>${s}</li>`).join('')}</ol>`;
}

function offsetPicker(value) {
  const known = OFFSETS.some(([v]) => v === String(value ?? ''));
  return `<div class="row-inline"><div class="seg" role="group" aria-label="Folder date time zone">${OFFSETS.map(([v, l]) => `<button type="button" data-offset="${v}" aria-pressed="${v === 'custom' ? !known : String(value ?? '') === v}">${l}</button>`).join('')}</div>
    <label class="field tiny wide-tiny" ${known ? 'hidden' : ''} data-custom><input id="m-off" value="${known ? '' : esc(value)}" placeholder="minutes, e.g. -300" aria-label="Offset in minutes"></label></div>`;
}

function readOffset() {
  if (M.offset === 'custom') {
    const n = Number(M.el.querySelector('#m-off')?.value);
    return Number.isFinite(n) ? n : 0;
  }
  return M.offset === '' ? null : Number(M.offset);
}

function params() {
  const adopt = M.kind === 'adopt';
  return `<section class="panel">
    <div class="panel-head"><h2>${adopt ? 'Adopt a folder' : 'Rename folders'}</h2>
      <div class="seg" role="group" aria-label="Operation"><button type="button" data-kind="adopt" aria-pressed="${adopt}" ${M.creator.service !== 'fanbox' ? 'disabled title="Fanbox creators only"' : ''}>Adopt</button><button type="button" data-kind="relayout" aria-pressed="${!adopt}">Rename</button></div></div>
    <div class="form">
      ${adopt ? `
        <label class="lab" for="m-root">Source folder</label>
        <div class="ctl"><label class="field"><input id="m-root" value="${esc(M.root)}" placeholder="J:\\…\\遠藤弘土 or its fanbox folder"></label>
          <div class="hint">The "Pixiv Fanbox Downloader" extension's layout: <span class="mono">fanbox/{fee}/[YYYY.MM.DD] title/{n}.{ext}</span>, where 0.* is the cover and 0.txt the text. Matched folders are renamed in place to this project's layout, without the fee level.</div></div>
        <span class="lab">Folder dates</span>
        <div class="ctl">${offsetPicker(M.offset === 'custom' ? '' : M.offset)}<div class="hint">The extension writes the browser's local date. Infer works it out from posts whose title matches only one folder, and shows the deciding samples.</div></div>`
      : `
        <span class="lab">Folder dates</span>
        <div class="ctl">${offsetPicker(M.offset === '' ? '0' : M.offset)}<div class="hint">Folders are renamed in place to the current post template, with dates at this offset. UTC matches the existing folders.</div></div>`}
      <span></span><div class="ctl row-inline"><button class="btn primary" type="button" data-plan>Preview</button><span class="muted">Reads folders and the database; changes nothing.</span></div>
    </div></section>`;
}

function evidence(sum) {
  if (!sum.evidence?.length) return '';
  const best = sum.evidence[0];
  const tied = sum.evidence.filter((g) => g.agree === best.agree).length;
  return `<div class="evidence">
    ${tied > 1 && !sum.offset_given ? `<div class="note">The top ${tied} offsets explain the same folders; the samples cannot tell them apart, so the one nearest JST was picked. Set it by hand if you know it.</div>` : ''}
    <div class="e-row h"><span>Offset</span><span>Agree</span><span>Deciding samples (why not UTC or JST)</span></div>
    ${sum.evidence.map((g) => `<div class="e-row"><span><b>${esc(g.label)}</b>${g.minutes === sum.offset ? ' <span class="tick">✓</span>' : ''}</span><span class="num">${g.agree.toLocaleString()}/${g.total.toLocaleString()}${g.total ? ` · ${((g.agree / g.total) * 100).toFixed(1)}%` : ''}</span>
      <span class="e-w">${g === best ? g.witnesses.slice(0, 3).map(([title, folder, utc]) => { const j = at(utc, 540); const u = at(utc); return `<div class="clip" title="${esc(title)}">${esc(title)} · folder <span class="mono">${folder.slice(5).replace('-', '.')}</span> · UTC <span class="mono">${u.date.slice(5)} ${u.time}</span> · JST <span class="mono">${j.date.slice(5)} ${j.time}</span></div>`; }).join('') || '<span class="muted">No sample tells the offsets apart</span>' : ''}</span></div>`).join('')}
  </div>`;
}

function itemRow(item) {
  const [k, t] = STATUS[item.status] || ['k-pending', item.status];
  const v = item.verified || {};
  const n = item.files ? item.files.filter((f) => f.dst !== 'content.txt').length : null;
  const files = n == null ? '—' : `${n}${v.ok ? ` · <span class="tick">✓</span>${v.ok}` : ''}${v.bad ? ` · <span class="cross">✗${v.bad}</span>` : ''}${v.unknown ? ` · <span class="muted">?${v.unknown}</span>` : ''}`;
  const pick = ['ambiguous', 'review'].includes(item.status) && !M.plan.executed_at;
  const target = item.target
    ? `<span class="mono clip" title="${esc(item.target)}">${esc(item.target.split(/[\\/]/).pop())}</span>`
    : pick && item.candidates?.length ? `<select class="select" data-cand="${esc(item.folder)}">${item.candidates.map((c) => `<option value="${esc(c.post_id)}" ${c.post_id === item.post_id ? 'selected' : ''}>${esc(c.post_id)} · ${esc(at(c.published).date)} · ¥${c.fee} · ${esc(c.title.slice(0, 30))}</option>`).join('')}</select>`
    : '<span class="muted">—</span>';
  return `<tr>
    <td class="n">${item.fee ?? ''}</td>
    <td><span class="mono clip" title="${esc(item.folder)}">${esc(item.name)}</span></td>
    <td class="arrow">→</td>
    <td>${target}</td>
    <td class="mono">${esc(item.post_id || '')}</td>
    <td class="n" title="${v.ok || v.bad || v.unknown ? `${v.ok || 0} checked, ${v.bad || 0} mismatched, ${v.unknown || 0} unchecked` : ''}">${files}</td>
    <td><span class="chip ${k}">${t}</span>${item.note ? `<div class="cell-note clip" title="${esc(item.note)}">${esc(item.note)}</div>` : ''}${item.result ? `<div class="cell-note ${item.result === 'ok' ? '' : 'lvl-error'}">${item.result === 'ok' ? 'Done' : esc(item.result)}</div>` : ''}</td>
    <td class="acts">${pick ? `${item.candidates?.length ? `<button class="linkbtn" type="button" data-accept="${esc(item.folder)}">Accept</button>` : ''}<button class="linkbtn" type="button" data-skip="${esc(item.folder)}">Skip</button>` : ''}</td>
  </tr>`;
}

function preview() {
  const p = M.plan;
  const sum = p.summary;
  const c = sum.counts || {};
  const adopt = p.kind === 'adopt';
  const tiles = [
    ['matched', 'Matched', 'ok', adopt ? 'Renamed and marked adopted' : 'Renamed'],
    ['review', 'Review', 'warn', 'File count differs from the post'],
    ['ambiguous', 'Ambiguous', 'warn', 'Pick the post'],
    ['conflict', 'Conflict', 'bad', 'Target folder exists'],
    ['unmatched', 'No post', '', 'Not on Fanbox; left alone'],
    ['skipped', 'Skipped', '', 'Left alone'],
  ].filter(([key]) => key === 'matched' || c[key]);
  const items = p.items.filter((i) => !M.filter || i.status === M.filter);
  const executing = M.job != null;
  return `<section class="panel">
    <div class="panel-head"><h2>Preview · plan #${p.id}</h2>
      <span class="muted clip" title="${esc(sum.root || '')}">${adopt ? `<span class="mono">${esc(sum.root)}</span> · ` : ''}${esc(sum.offset_label)}${adopt && !sum.offset_given ? ' (inferred)' : ''}</span></div>
    ${adopt ? evidence(sum) : ''}
    <div class="tiles">${tiles.map(([key, label, cls, hint]) => `<button type="button" class="tile ${cls}" data-filter="${key}" aria-pressed="${M.filter === key}" title="Show only these"><span class="h">${label}</span><span class="v">${(c[key] || 0).toLocaleString()}</span><span class="s">${hint}</span></button>`).join('')}
      ${adopt ? `<div class="tile"><span class="h">On Fanbox, not here</span><span class="v">${(sum.missing_locally || 0).toLocaleString()}</span><span class="s">Downloaded as usual</span></div>` : ''}</div>
    <div class="table fixed"><table>
      <colgroup><col style="width:52px"><col><col style="width:28px"><col><col style="width:88px"><col style="width:96px"><col style="width:150px"><col style="width:96px"></colgroup>
      <thead><tr><th class="n">Fee</th><th>Folder</th><th></th><th>New name</th><th>Post</th><th class="n">Files</th><th>Result</th><th></th></tr></thead>
      <tbody>${items.slice(0, M.limit).map(itemRow).join('') || '<tr><td colspan="8" class="empty-cell">Nothing here.</td></tr>'}</tbody></table></div>
    ${items.length > M.limit ? `<div class="more plain">Showing ${M.limit.toLocaleString()} of ${items.length.toLocaleString()}<button class="btn sm" type="button" data-more>Show ${PAGE} more</button></div>` : ''}
    <div class="row-inline end">
      ${p.executed_at ? `<span>Executed ${esc(localTime(p.executed_at))}: ${p.result?.done ?? 0} done${p.result?.failed ? `, ${p.result.failed} failed` : ''}</span>`
        : executing ? `<span class="spin"></span><span id="mig-progress">${esc(M.progress || 'Executing…')}</span>`
        : `<button class="btn" type="button" data-back>Change parameters</button><button class="btn primary" type="button" data-exec ${c.matched ? '' : 'disabled'}>Execute ${(c.matched || 0).toLocaleString()} matched</button>`}
    </div>
  </section>`;
}

async function history() {
  const rows = await api(`migrations?creator_id=${encodeURIComponent(M.cid)}`).catch(() => []);
  if (!rows.length) return '';
  return `<section class="panel"><h2>Earlier plans</h2><div class="table"><table><tbody>${rows.map((r) => `<tr><td class="n" style="width:56px">#${r.id}</td><td>${r.kind === 'adopt' ? 'Adopt' : 'Rename'}</td><td class="muted">${esc(localTime(r.created_at))}</td><td>${r.executed_at ? `Executed · ${r.result?.done ?? 0} done` : 'Not executed'}</td><td class="acts"><a class="linkbtn" href="#/migrate/${encodeURIComponent(M.cid)}?plan=${r.id}">Open</a></td></tr>`).join('')}</tbody></table></div></section>`;
}

async function render() {
  const name = M.creator.alias || M.creator.name;
  const step = M.plan ? (M.plan.executed_at ? 4 : 3) : 2;
  const scroll = M.el.scrollTop;
  M.el.innerHTML = `<div class="view">
    <div class="view-head"><div><h1>Migrate · ${esc(name)}</h1><p class="lede">Make a plan, look at it, then execute. Each item's outcome is kept with the plan.</p></div><a class="btn" href="#/c/${encodeURIComponent(M.cid)}">Back to posts</a></div>
    ${steps(step)}
    ${M.plan ? preview() : params()}
    ${await history()}
  </div>`;
  M.el.scrollTop = scroll;
}

// Progress lines only rewrite the progress text; the page is redrawn once, when the job ends.
function watchJob() {
  const off = on('jobs', async (jobs) => {
    if (!M || M.job == null) return off();
    const j = jobs.find((x) => x.id === M.job);
    if (!j) return; // a snapshot from before the job was queued
    if (j.status === 'queued' || j.status === 'running') {
      M.progress = j.progress;
      const line = M.el.querySelector('#mig-progress');
      if (line) line.textContent = M.progress || 'Executing…';
      return;
    }
    off();
    M.job = null;
    M.plan = await api(`migrations/${M.plan.id}`);
    toast('Migration finished');
    await render();
  });
}

export async function mountMigrate(el, cid, query) {
  M = { el, cid, kind: query.get('kind') || 'adopt', root: '', offset: '', plan: null, filter: '', limit: PAGE, job: null, progress: '' };
  M.creator = await api(`creators/${encodeURIComponent(cid)}`);
  if (M.creator.service !== 'fanbox') M.kind = 'relayout';
  if (query.get('plan')) M.plan = await api(`migrations/${query.get('plan')}`);
  await render();
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.kind) { M.kind = b.dataset.kind; M.offset = ''; return render(); }
    if (b.dataset.offset !== undefined) {
      M.root = M.el.querySelector('#m-root')?.value ?? M.root;
      M.offset = b.dataset.offset;
      b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      M.el.querySelector('[data-custom]').hidden = M.offset !== 'custom';
      return;
    }
    if (b.dataset.plan !== undefined) {
      M.root = M.el.querySelector('#m-root')?.value.trim() ?? '';
      if (M.kind === 'adopt' && !M.root) return toast('Enter the source folder first', true);
      b.disabled = true;
      b.textContent = 'Working…';
      const body = M.kind === 'adopt' ? { creator_id: cid, root: M.root, offset: readOffset() } : { creator_id: cid, offset: readOffset() ?? 0 };
      const plan = await attempt(() => api(`migrations/${M.kind}`, { method: 'POST', body }));
      if (plan) { M.plan = plan; M.filter = ''; M.limit = PAGE; }
      return render();
    }
    if (b.dataset.filter) { M.filter = M.filter === b.dataset.filter ? '' : b.dataset.filter; M.limit = PAGE; return render(); }
    if (b.dataset.more !== undefined) { M.limit += PAGE; return render(); }
    if (b.dataset.back !== undefined) { M.plan = null; return render(); }
    if (b.dataset.accept || b.dataset.skip) {
      const folder = b.dataset.accept || b.dataset.skip;
      const select = [...M.el.querySelectorAll('select[data-cand]')].find((s) => s.dataset.cand === folder);
      const postId = b.dataset.accept ? select?.value : null;
      const item = await attempt(() => api(`migrations/${M.plan.id}/resolve`, { method: 'POST', body: { folder, post_id: postId } }));
      if (item) M.plan = await api(`migrations/${M.plan.id}`);
      return render();
    }
    if (b.dataset.exec !== undefined) {
      const out = await attempt(() => api(`migrations/${M.plan.id}/execute`, { method: 'POST' }));
      if (out) { M.job = out.job; await render(); watchJob(); }
    }
  };
}
