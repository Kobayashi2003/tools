const btn     = document.getElementById('btn');
const totalEl = document.getElementById('total');
const dupesEl = document.getElementById('dupes');
const msgEl   = document.getElementById('msg');

async function countDuplicates() {
  const tabs = await chrome.tabs.query({});
  const seen = new Set();
  let dupes = 0;

  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl;
    if (!url || url.startsWith('chrome://')) continue;
    if (seen.has(url)) dupes++;
    else seen.add(url);
  }

  totalEl.textContent = tabs.length;
  dupesEl.textContent = dupes;
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  btn.textContent = 'Working...';

  const res = await chrome.runtime.sendMessage({ action: 'deduplicate' });

  msgEl.className = 'msg ' + (res.closed > 0 ? 'success' : 'empty');
  msgEl.textContent = res.closed > 0
    ? `✓ Closed ${res.closed} duplicate tab(s)`
    : 'No duplicate tabs found';

  await countDuplicates();
  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 8a6 6 0 1 0 6-6" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="2,5 2,8 5,8" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg> Deduplicate tabs`;
});

countDuplicates();