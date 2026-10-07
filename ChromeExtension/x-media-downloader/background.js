// Service worker: performs downloads for the content script and, when X
// rotates its GraphQL query ids, rediscovers them from the web client bundle.

const DEFAULTS = {
  enabled: true,
  dblclick: true,
  modifierClick: true,
  modifier: 'alt',
  showButton: true,
  autoLike: false,
  scope: 'single',
  quoteMode: 'ask',
  template: 'twitter_{user-name}(@{user-id})_{date-time}_{status-id}_{file-type}',
  saveHistory: true,
};

const WANTED_OPS = ['TweetResultByRestId', 'FavoriteTweet'];

// Seed default settings on install so the popup and content scripts agree.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    // 1.0 shipped a different default whose tokens no longer exist.
    if (cfg.template === 'X/{user-id}_{date}_{status-id}_{index}') cfg.template = DEFAULTS.template;
    chrome.storage.sync.set(cfg);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'download') {
    downloadAll(msg.items).then(sendResponse);
    return true;
  }
  if (msg.action === 'discoverOps') {
    discoverOps(msg.urls).then(sendResponse);
    return true;
  }
  if (msg.action === 'addHistory') {
    addHistory(msg.ids).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'clearHistory') {
    queueHistory(() => chrome.storage.local.set({ history: [] })).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Download history: post ids, oldest first. All writes go through this one
// queue so concurrent downloads from several tabs never drop entries.
const HISTORY_MAX = 50000;
let historyQueue = Promise.resolve();

function queueHistory(task) {
  historyQueue = historyQueue.then(task).catch(() => {});
  return historyQueue;
}

function addHistory(ids) {
  return queueHistory(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    const set = new Set(history);
    const before = set.size;
    for (const id of ids) if (/^\d+$/.test(id)) set.add(id);
    if (set.size !== before) await chrome.storage.local.set({ history: [...set].slice(-HISTORY_MAX) });
  });
}

async function downloadAll(items) {
  const errors = [];
  for (const item of items) {
    try {
      await chrome.downloads.download({
        url: item.url,
        filename: item.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } catch (err) {
      errors.push(`${item.filename}: ${err.message}`);
    }
  }
  return { ok: errors.length === 0, count: items.length - errors.length, errors };
}

// Scan the web client's scripts for operation definitions shaped like
//   queryId:"…",operationName:"TweetResultByRestId",operationType:"query",
//   metadata:{featureSwitches:["a","b",…],…}
// Results are cached per script URL, since the URL carries the build hash.
async function discoverOps(urls) {
  const ops = {};
  try {
    const { opsCache = {} } = await chrome.storage.local.get('opsCache');
    for (const url of urls) {
      if (!opsCache[url]) {
        const text = await fetch(url).then((r) => r.text());
        opsCache[url] = parseOps(text);
      }
      Object.assign(ops, opsCache[url]);
      if (WANTED_OPS.every((name) => ops[name])) break;
    }
    // Only keep the most recent bundles around.
    const keys = Object.keys(opsCache);
    for (const k of keys.slice(0, Math.max(0, keys.length - 4))) delete opsCache[k];
    await chrome.storage.local.set({ opsCache });
    return { ok: Object.keys(ops).length > 0, ops };
  } catch (err) {
    return { ok: false, error: err.message, ops };
  }
}

function parseOps(text) {
  const found = {};
  const q = '["\'`]';
  const re = new RegExp(
    `queryId:${q}([\\w-]+)${q},operationName:${q}(\\w+)${q}` +
      `(?:,operationType:${q}\\w+${q},metadata:\\{featureSwitches:\\[([^\\]]*)\\])?`,
    'g'
  );
  for (const m of text.matchAll(re)) {
    if (!WANTED_OPS.includes(m[2])) continue;
    const op = { queryId: m[1] };
    if (m[3] !== undefined) op.featureSwitches = [...m[3].matchAll(/["'`](\w+)["'`]/g)].map((f) => f[1]);
    found[m[2]] = op;
  }
  return found;
}
