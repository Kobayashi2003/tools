// X Media Downloader — content script.
//
// Triggers (each can be toggled in the popup):
//   * Double-click a photo / video / GIF in a post. A single click still
//     works as usual — it is held for DBL_MS and then replayed.
//   * Hold the modifier key (Alt by default) and click — downloads instantly.
//     While the key is held, the media under the cursor is outlined.
//   * A download button in each post's action bar — downloads every media
//     item in the post.
// Optionally the post is liked at the same time (never un-liked).
//
// Media URLs come from X's GraphQL TweetResultByRestId endpoint (original
// photos, highest-bitrate MP4). If that fails, photos fall back to the URL in
// the page rewritten to name=orig.

(() => {
  const DEFAULTS = {
    enabled: true,
    dblclick: true,
    modifierClick: true,
    modifier: 'alt',
    showButton: true,
    autoLike: false,
    scope: 'single', // what a gesture downloads: 'single' media or 'all' in the post
    quoteMode: 'ask', // button on a post whose quoted post has media too: 'ask' | 'own' | 'both'
    template: 'twitter_{user-name}(@{user-id})_{date-time}_{status-id}_{file-type}',
    saveHistory: true,
  };

  const MODIFIER_PROP = { alt: 'altKey', ctrl: 'ctrlKey', shift: 'shiftKey', meta: 'metaKey' };
  const DBL_MS = 300;
  const MEDIA_SEL = '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"]';
  const MEDIA_IMG_RE = /^https:\/\/pbs\.twimg\.com\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;
  const STATUS_RE = /\/status\/(\d+)(?:\/(?:photo|video)\/(\d+))?/;

  const cfg = { ...DEFAULTS };
  let history = new Set();

  // --- settings & history ---------------------------------------------------

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    Object.assign(cfg, stored);
    queueScan();
  });
  chrome.storage.local.get({ history: [] }, (s) => {
    history = new Set(s.history);
    refreshButtonStates();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.history) {
      history = new Set(changes.history.newValue || []);
      refreshButtonStates();
    }
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) if (k in cfg) cfg[k] = newValue;
    if (changes.enabled || changes.showButton) {
      removeButtons();
      queueScan();
    }
    if (!cfg.enabled) setHover(null);
  });

  // The background worker owns the stored list and appends serially, so tabs
  // never overwrite each other's entries; this local copy is only for display
  // and is kept in sync through storage.onChanged.
  function markDownloaded(...ids) {
    ids = ids.filter((id) => id && !history.has(id));
    if (!cfg.saveHistory || !ids.length) return;
    ids.forEach((id) => history.add(id));
    refreshButtonStates();
    chrome.runtime.sendMessage({ action: 'addHistory', ids });
  }

  // --- X API ----------------------------------------------------------------

  // Public bearer token used by the X web client itself.
  const BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  // Known-good defaults; refreshed from the web client bundle when they fail.
  const DEFAULT_FEATURES = {
    articles_preview_enabled: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    communities_web_enable_tweet_community_results_fetch: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    longform_notetweets_consumption_enabled: false,
    longform_notetweets_inline_media_enabled: true,
    longform_notetweets_rich_text_read_enabled: false,
    premium_content_api_read_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_edit_tweet_api_enabled: false,
    responsive_web_enhance_cards_enabled: false,
    responsive_web_graphql_exclude_directive_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: false,
    responsive_web_grok_analysis_button_from_backend: false,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: false,
    responsive_web_grok_image_annotation_enabled: false,
    responsive_web_grok_share_attachment_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_jetfuel_frame: false,
    responsive_web_media_download_video_enabled: false,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    rweb_video_screen_enabled: false,
    standardized_nudges_misinfo: true,
    tweet_awards_web_tipping_enabled: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    tweetypie_unmention_optimization_enabled: false,
    verified_phone_label_enabled: false,
    view_counts_everywhere_api_enabled: true,
  };

  const OPS = {
    TweetResultByRestId: { queryId: '2ICDjqPd81tulZcYrtpTuQ', featureSwitches: Object.keys(DEFAULT_FEATURES) },
    FavoriteTweet: { queryId: 'lI07N6Otwv1PhnEgXILM7A', featureSwitches: null },
  };

  function cookies() {
    const out = {};
    for (const part of document.cookie.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function apiHeaders() {
    const c = cookies();
    const h = {
      authorization: 'Bearer ' + BEARER,
      'x-twitter-active-user': 'yes',
      'x-csrf-token': c.ct0 || '',
    };
    if (c.lang) h['x-twitter-client-language'] = c.lang;
    // A 32-char ct0 means a logged-out (guest) session.
    if (c.ct0 && c.ct0.length === 32 && c.gt) h['x-guest-token'] = c.gt;
    else h['x-twitter-auth-type'] = 'OAuth2Session';
    return h;
  }

  let discovery = null;
  function discoverOps() {
    if (!discovery) {
      // Script tags plus lazily imported chunks (only visible as resources).
      const loaded = [
        ...[...document.scripts].map((s) => s.src),
        ...performance.getEntriesByType('resource').map((r) => r.name),
      ];
      const urls = [...new Set(loaded)]
        .filter((src) => /^https:\/\/abs\.twimg\.com\/.+\.js(\?|$)/.test(src))
        .sort((a, b) => /\/(main|entry)[.-]/.test(b) - /\/(main|entry)[.-]/.test(a))
        .slice(0, 60);
      discovery = urls.length
        ? chrome.runtime.sendMessage({ action: 'discoverOps', urls }).then((res) => {
            for (const [name, op] of Object.entries(res?.ops || {})) Object.assign(OPS[name], op);
            return !!res?.ok;
          })
        : Promise.resolve(false);
    }
    return discovery;
  }

  function buildFeatures(op, extra) {
    if (!op.featureSwitches) return null;
    const f = {};
    for (const name of op.featureSwitches) f[name] = DEFAULT_FEATURES[name] ?? false;
    return Object.assign(f, extra);
  }

  async function gql(name, variables, { method = 'GET', retried = false, extraFeatures = {} } = {}) {
    const op = OPS[name];
    const features = buildFeatures(op, extraFeatures);
    const url = new URL(`/i/api/graphql/${op.queryId}/${name}`, location.origin);
    const init = { method, credentials: 'include', headers: apiHeaders() };
    if (method === 'GET') {
      url.searchParams.set('variables', JSON.stringify(variables));
      if (features) url.searchParams.set('features', JSON.stringify(features));
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify({ variables, queryId: op.queryId, ...(features && { features }) });
    }

    const res = await fetch(url, init);
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (res.ok && body?.data && !body.errors) return body;

    const msg = (body?.errors || []).map((e) => e.message).join('; ');
    if (!retried) {
      // "The following features cannot be null: a, b" → send them as false.
      const missing = msg.match(/cannot be null: ([\w, ]+)/);
      if (missing) {
        for (const f of missing[1].split(',')) extraFeatures[f.trim()] = false;
        return gql(name, variables, { method, retried: true, extraFeatures });
      }
      // Stale query id / feature set → rediscover from the bundle and retry.
      if (!res.ok && ![401, 403, 429].includes(res.status) && (await discoverOps())) {
        return gql(name, variables, { method, retried: true });
      }
    }
    if (res.ok && body?.data) return body; // partial errors but usable data
    throw new Error(msg || `HTTP ${res.status}`);
  }

  const unwrap = (r) => (r && r.tweet) || r;

  const tweetCache = new Map();
  function fetchTweet(id) {
    if (!tweetCache.has(id)) {
      const p = gql('TweetResultByRestId', {
        tweetId: id,
        withCommunity: false,
        includePromotedContent: false,
        withVoice: false,
      }).then((body) => {
        let t = unwrap(body.data?.tweetResult?.result);
        if (!t?.legacy) throw new Error(t?.__typename || 'post unavailable');
        const rt = unwrap(t.legacy.retweeted_status_result?.result);
        if (rt?.legacy) t = rt;
        return t;
      });
      p.catch(() => tweetCache.delete(id));
      tweetCache.set(id, p);
    }
    return tweetCache.get(id);
  }

  // --- media model ----------------------------------------------------------

  function userOf(t) {
    const u = t.core?.user_results?.result || {};
    return {
      screenName: u.core?.screen_name || u.legacy?.screen_name || 'unknown',
      name: u.core?.name || u.legacy?.name || '',
    };
  }

  // Media of a post and of the post it quotes, in display order.
  function collectMedia(t) {
    const out = [];
    const add = (tw) => {
      (tw?.legacy?.extended_entities?.media || []).forEach((media, i) =>
        out.push({ media, index: i + 1, tweet: tw })
      );
    };
    add(t);
    const q = unwrap(t.quoted_status_result?.result);
    if (q?.legacy) add(q);
    return out;
  }

  // The last path segment without extension identifies a media item both in
  // API URLs (…/media/KEY.jpg) and page URLs (…/media/KEY?format=jpg).
  function keyOf(url) {
    if (!url || !MEDIA_IMG_RE.test(url)) return null;
    return new URL(url).pathname.split('/').pop().replace(/\.\w+$/, '');
  }

  function mediaSource(m) {
    if (m.type === 'photo') {
      const ext = m.media_url_https.split('.').pop();
      return { url: m.media_url_https.replace(/\.\w+$/, '') + `?format=${ext}&name=orig`, ext };
    }
    const best = (m.video_info?.variants || [])
      .filter((v) => v.content_type === 'video/mp4')
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    return best ? { url: best.url, ext: 'mp4' } : null;
  }

  // --- filenames ------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');

  // Same convention as the original userscript: reserved filename characters
  // become full-width look-alikes, invisible characters are dropped.
  const FULLWIDTH = { '\\': '＼', '/': '／', '|': '｜', '<': '＜', '>': '＞', ':': '：', '*': '＊', '?': '？', '"': '＂' };
  const INVISIBLE_RE = /[\u{0}-\u{1F}\u{200B}-\u{200D}\u{2060}\u{FEFF}]|🔞/gu;

  const clean = (value) => String(value).replace(/[\\/|<>:*?"]/g, (c) => FULLWIDTH[c]).replace(INVISIBLE_RE, '');

  // YYYYMMDD-hhmmss, in UTC by default like the original script.
  function stamp(d, local) {
    const p = local
      ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
      : [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
    return `${p[0]}${pad(p[1])}${pad(p[2])}-${pad(p[3])}${pad(p[4])}${pad(p[5])}`;
  }

  // Tokens are cleaned so a "/" in a display name never creates a folder; a
  // literal "/" in the template does. `suffix` (0-based position) is appended
  // as "-N" for multi-media posts unless the template already has {file-name}.
  function buildFilename(tokens, ext, suffix) {
    let name = cfg.template
      .split(/(\{[\w-]+\})/)
      .map((part, i) => {
        if (i % 2 === 0) return part.replace(/[\\|<>:*?"]/g, (c) => FULLWIDTH[c]);
        const k = part.slice(1, -1);
        return k in tokens ? clean(tokens[k]) : part;
      })
      .join('');
    if (suffix != null && !cfg.template.includes('{file-name}')) name += '-' + suffix;
    const path = name
      .split('/')
      .map((seg) => seg.trim().replace(/^\.+|\.+$/g, '').slice(0, 150))
      .filter(Boolean)
      .join('/');
    return `${path || tokens['status-id']}.${ext}`;
  }

  function apiItem(entry, multiple) {
    const src = mediaSource(entry.media);
    if (!src) return null;
    const t = entry.tweet;
    const u = userOf(t);
    const d = new Date(t.legacy.created_at);
    const tokens = {
      'user-name': u.name || u.screenName,
      'user-id': u.screenName,
      'status-id': t.rest_id || t.legacy.id_str,
      'date-time': stamp(d, false),
      'date-time-local': stamp(d, true),
      'file-type': entry.media.type.replace('animated_', ''),
      'file-name': keyOf(entry.media.media_url_https) || entry.media.id_str,
    };
    return { url: src.url, filename: buildFilename(tokens, src.ext, multiple ? entry.index - 1 : null) };
  }

  // Fallback when the API is unavailable: the photo URL in the page.
  function domPhotoItem(target) {
    const u = new URL(target.img.src);
    const ext = u.searchParams.get('format') || 'jpg';
    const key = keyOf(target.img.src);
    const user = (target.link && target.link.pathname.split('/')[1]) || 'unknown';
    const tokens = {
      'user-name': user,
      'user-id': user,
      'status-id': target.statusId,
      'date-time': 'unknown',
      'date-time-local': 'unknown',
      'file-type': 'photo',
      'file-name': key,
    };
    return {
      url: `https://pbs.twimg.com/media/${key}?format=${ext}&name=orig`,
      filename: buildFilename(tokens, ext, (target.index || 1) - 1),
    };
  }

  // Work out which media items a target refers to and the post owning them.
  async function resolve(target, scope) {
    let tweet;
    try {
      tweet = await fetchTweet(target.statusId);
    } catch (err) {
      if (scope === 'single' && target.img && /\/media\//.test(target.img.src)) {
        return { items: [domPhotoItem(target)], ownerId: target.statusId };
      }
      throw err;
    }
    const all = collectMedia(tweet);
    if (!all.length) throw new Error('no media in this post');

    const hit = target.key && all.find((e) => keyOf(e.media.media_url_https) === target.key);
    const owner = hit ? hit.tweet : all[0].tweet;
    const own = all.filter((e) => e.tweet === owner);

    let picked = own;
    if (scope === 'single') {
      if (hit) picked = [hit];
      else if (target.index && own[target.index - 1]) picked = [own[target.index - 1]];
    }
    const items = picked.map((e) => apiItem(e, own.length > 1)).filter(Boolean);
    if (!items.length) throw new Error('no downloadable media');
    return { items, ownerId: owner.rest_id || owner.legacy.id_str };
  }

  // --- DOM helpers ----------------------------------------------------------

  // The post's own id: the timestamp link in its header (quoted posts have no
  // such link, so the first match belongs to the outer post).
  function primaryStatusId(article) {
    const time = article.querySelector('a[href*="/status/"] time');
    const m = time && time.closest('a').pathname.match(STATUS_RE);
    if (m) return m[1];
    const lm = location.pathname.match(STATUS_RE);
    return lm ? lm[1] : null;
  }

  function describe(node) {
    const box = node.closest(MEDIA_SEL) || node;
    const img =
      node.tagName === 'IMG' ? node : box.querySelector('img[src^="https://pbs.twimg.com/"]');
    const video = node.tagName === 'VIDEO' ? node : box.querySelector('video');
    const thumb = (video && video.poster) || (img && img.src) || '';
    const link = box.closest('a[href*="/status/"]');
    const article = box.closest('article');

    let statusId = null;
    let index = null;
    const m = link && link.pathname.match(STATUS_RE);
    if (m) [, statusId, index] = m;
    if (!statusId && article) statusId = primaryStatusId(article);
    if (!statusId) {
      // Photo / video viewer: /user/status/ID/photo/N
      const lm = location.pathname.match(STATUS_RE);
      if (lm) [, statusId, index] = lm;
    }
    if (!statusId) return null;
    return { box, img, link, article, statusId, index: index ? +index : null, key: keyOf(thumb) };
  }

  function isMediaNode(el) {
    if (el.tagName === 'IMG') return MEDIA_IMG_RE.test(el.src);
    return el.tagName === 'VIDEO';
  }

  // Media under the pointer. X layers transparent overlays above images, so
  // fall back to scanning everything at the point (ignoring what lies behind
  // an open modal).
  function mediaAt(e) {
    const t = e.target;
    if (!(t instanceof Element) || t.closest('.xmd-btn, .xmd-toast, .xmd-menu')) return null;
    const direct = t.closest(MEDIA_SEL) || (isMediaNode(t) && t);
    if (direct) return describe(direct);
    const modal = document.querySelector('[aria-modal="true"]');
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (modal && !modal.contains(el)) continue;
      const hit = el.closest(MEDIA_SEL) || (isMediaNode(el) && el);
      if (hit) return describe(hit);
    }
    return null;
  }

  // --- like -----------------------------------------------------------------

  function findLikeButton(statusId) {
    const scopes = [...document.querySelectorAll('article')].filter((a) => primaryStatusId(a) === statusId);
    const modal = document.querySelector('[aria-modal="true"]');
    if (modal && location.pathname.includes(`/status/${statusId}/`)) {
      scopes.push(...[...modal.querySelectorAll('[role="group"]')].filter((g) => !g.closest('article')));
    }
    for (const s of scopes) {
      const unlike = s.querySelector('[data-testid="unlike"]');
      if (unlike) return { liked: true };
      const like = s.querySelector('[data-testid="like"]');
      if (like) return { button: like };
    }
    return null;
  }

  // Prefer clicking the real button so X's UI stays in sync; otherwise call
  // the API (e.g. the media belongs to a quoted post).
  async function likePost(statusId) {
    const found = findLikeButton(statusId);
    if (found?.liked) return 'already';
    if (found?.button) {
      found.button.click();
      return 'liked';
    }
    try {
      await gql('FavoriteTweet', { tweet_id: statusId }, { method: 'POST' });
      return 'liked';
    } catch (err) {
      return /already/i.test(err.message) ? 'already' : 'failed';
    }
  }

  // --- feedback UI ----------------------------------------------------------

  // Keep a fixed-position overlay glued to `anchor` (the media or button it
  // belongs to) while the page scrolls, so it moves with the post instead of
  // hanging where the cursor was. Returns a function that stops following.
  function follow(el, anchor) {
    if (!anchor || !anchor.isConnected) return () => {};
    const a = anchor.getBoundingClientRect();
    const dx = parseFloat(el.style.left) - a.left;
    const dy = parseFloat(el.style.top) - a.top;
    let queued = false;
    const update = () => {
      queued = false;
      if (!anchor.isConnected) return; // virtualized away — stay put
      const r = anchor.getBoundingClientRect();
      el.style.left = r.left + dx + 'px';
      el.style.top = r.top + dy + 'px';
    };
    const onMove = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    };
    window.addEventListener('scroll', onMove, { capture: true, passive: true });
    window.addEventListener('resize', onMove, { passive: true });
    return () => {
      window.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
    };
  }

  function toast(x, y, text, anchor) {
    const el = document.createElement('div');
    el.className = 'xmd-toast';
    el.textContent = text;
    document.documentElement.appendChild(el);
    // Clamp with room for the longer result text that replaces "Fetching…".
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(x + 14, innerWidth - Math.max(r.width, 220) - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y + 14, innerHeight - r.height - 8)) + 'px';
    const unfollow = follow(el, anchor);
    const remove = () => {
      unfollow();
      el.remove();
    };
    let timer;
    return {
      finish(msg, kind) {
        el.textContent = msg;
        el.classList.add(kind === 'error' ? 'xmd-toast-error' : 'xmd-toast-ok');
        clearTimeout(timer);
        timer = setTimeout(remove, kind === 'error' ? 4000 : 1800);
      },
      dismiss() {
        clearTimeout(timer);
        remove();
      },
    };
  }

  function flash(el) {
    if (!el) return;
    el.classList.remove('xmd-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('xmd-flash');
    setTimeout(() => el.classList.remove('xmd-flash'), 600);
  }

  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

  function summarize(entries) {
    const counts = {};
    for (const e of entries) {
      const kind = { photo: 'photo', animated_gif: 'GIF' }[e.media.type] || 'video';
      counts[kind] = (counts[kind] || 0) + 1;
    }
    return Object.entries(counts).map(([k, n]) => plural(n, k)).join(', ');
  }

  // Small picker for posts whose quoted post also has media (like the
  // original userscript's dialog). Resolves to the chosen value or null.
  function choose(x, y, title, options, anchor) {
    return new Promise((resolve) => {
      const menu = document.createElement('div');
      menu.className = 'xmd-menu';
      const head = document.createElement('div');
      head.className = 'xmd-menu-title';
      head.textContent = title;
      menu.appendChild(head);

      let unfollow = () => {};
      const close = (value) => {
        unfollow();
        menu.remove();
        window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onDown, true);
        resolve(value);
      };
      const onKey = (e) => {
        const n = Number(e.key);
        if (e.key === 'Escape') close(null);
        else if (n >= 1 && n <= options.length) close(options[n - 1].value);
        else return;
        swallow(e);
      };
      const onDown = (e) => {
        if (!menu.contains(e.target)) close(null);
      };

      options.forEach((opt, i) => {
        const b = document.createElement('button');
        b.className = 'xmd-menu-item';
        const label = document.createElement('b');
        label.textContent = opt.label;
        const hint = document.createElement('span');
        hint.textContent = opt.hint;
        const key = document.createElement('kbd');
        key.textContent = i + 1;
        b.append(key, label, hint);
        b.addEventListener('click', (e) => {
          swallow(e);
          close(opt.value);
        });
        menu.appendChild(b);
      });

      document.documentElement.appendChild(menu);
      const r = menu.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(x - r.width + 20, innerWidth - r.width - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(y + 12, innerHeight - r.height - 8)) + 'px';
      unfollow = follow(menu, anchor);
      window.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onDown, true);
    });
  }

  // Download, record history, optionally like, and report in the toast.
  async function deliver(t, items, { historyIds, likeId, box }) {
    const res = await chrome.runtime.sendMessage({ action: 'download', items });
    if (!res?.count) throw new Error(res?.errors?.[0] || 'download failed');
    markDownloaded(...historyIds);
    flash(box);

    let msg = `↓ ${plural(res.count, 'file')}`;
    if (res.errors.length) msg += ` · ${res.errors.length} failed`;
    if (cfg.autoLike) {
      const liked = await likePost(likeId);
      msg += { liked: ' · ♥ liked', already: ' · ♥ already liked', failed: ' · like failed' }[liked];
    }
    t.finish(msg, res.errors.length ? 'error' : 'ok');
  }

  // Gestures: the clicked media item (or every item of the post owning it).
  async function run(target, scope, x, y) {
    const t = toast(x, y, 'Fetching media…', target.box);
    try {
      const { items, ownerId } = await resolve(target, scope);
      await deliver(t, items, { historyIds: [ownerId, target.statusId], likeId: ownerId, box: target.box });
    } catch (err) {
      t.finish('✗ ' + err.message, 'error');
    }
  }

  // Action-bar button: every media item of the post. When the post and the
  // post it quotes both have media, `quoteMode` decides (or the user picks).
  async function runPost(statusId, x, y, button) {
    let t = toast(x, y, 'Fetching media…', button);
    button.classList.add('xmd-loading');
    try {
      const tweet = await fetchTweet(statusId);
      const groups = [];
      for (const e of collectMedia(tweet)) {
        let g = groups.find((g) => g.tweet === e.tweet);
        if (!g) groups.push((g = { tweet: e.tweet, entries: [] }));
        g.entries.push(e);
      }
      if (!groups.length) throw new Error('no media in this post');

      let picked = [groups[0]];
      if (groups.length > 1 && cfg.quoteMode === 'both') picked = groups;
      else if (groups.length > 1 && cfg.quoteMode === 'ask') {
        t.dismiss();
        const [own, quoted] = groups;
        const by = (g) => '@' + userOf(g.tweet).screenName;
        const choice = await choose(x, y, 'This post quotes another post with media', [
          { value: 'own', label: 'This post', hint: `${by(own)} · ${summarize(own.entries)}` },
          { value: 'quoted', label: 'Quoted post', hint: `${by(quoted)} · ${summarize(quoted.entries)}` },
          { value: 'both', label: 'Both', hint: plural(own.entries.length + quoted.entries.length, 'file') },
        ], button);
        if (!choice) return;
        picked = { own: [own], quoted: [quoted], both: groups }[choice];
        t = toast(x, y, 'Downloading…', button);
      }

      const items = picked
        .flatMap((g) => g.entries.map((e) => apiItem(e, g.entries.length > 1)))
        .filter(Boolean);
      if (!items.length) throw new Error('no downloadable media');
      const ids = picked.map((g) => g.tweet.rest_id || g.tweet.legacy.id_str);
      await deliver(t, items, { historyIds: [statusId, ...ids], likeId: ids[0], box: null });
    } catch (err) {
      t.finish('✗ ' + err.message, 'error');
    } finally {
      button.classList.remove('xmd-loading');
    }
  }

  // --- gestures -------------------------------------------------------------

  function modifierActive(e) {
    return e[MODIFIER_PROP[cfg.modifier] || 'altKey'] === true;
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // A first click on media is held back; if no second click follows within
  // DBL_MS it is replayed on the original element so X opens the viewer etc.
  let pending = null;
  let replaying = false;

  function flushPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    if (!p.node.isConnected) return;
    replaying = true;
    try {
      p.node.dispatchEvent(new MouseEvent('click', p.init));
    } finally {
      replaying = false;
    }
  }

  function clickInit(e) {
    const init = { bubbles: true, cancelable: true, composed: true, view: window, detail: 1 };
    for (const k of ['clientX', 'clientY', 'screenX', 'screenY', 'button', 'buttons', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey']) {
      init[k] = e[k];
    }
    return init;
  }

  window.addEventListener(
    'click',
    (e) => {
      if (replaying || !cfg.enabled || e.button !== 0) return;
      const viaModifier = cfg.modifierClick && modifierActive(e);
      if (!viaModifier && !cfg.dblclick) return;
      const target = mediaAt(e);
      if (!target) return;
      swallow(e);

      if (viaModifier) {
        pending && (clearTimeout(pending.timer), (pending = null));
        run(target, cfg.scope, e.clientX, e.clientY);
        return;
      }
      if (pending && pending.box === target.box) {
        clearTimeout(pending.timer);
        pending = null;
        run(target, cfg.scope, e.clientX, e.clientY);
        return;
      }
      flushPending(); // a different media item — let the earlier click through
      pending = { box: target.box, node: e.target, init: clickInit(e), timer: setTimeout(flushPending, DBL_MS) };
    },
    true
  );

  // Stop text selection on double-click and Chrome's Alt+click "save link".
  window.addEventListener(
    'mousedown',
    (e) => {
      if (!cfg.enabled || e.button !== 0) return;
      const viaModifier = cfg.modifierClick && modifierActive(e);
      const dbl = cfg.dblclick && e.detail > 1;
      if ((viaModifier || dbl) && mediaAt(e)) e.preventDefault();
    },
    true
  );

  window.addEventListener(
    'dblclick',
    (e) => {
      if (cfg.enabled && cfg.dblclick && mediaAt(e)) swallow(e);
    },
    true
  );

  // Outline the media under the cursor while the modifier is held.
  let hovered = null;
  function setHover(el) {
    if (hovered === el) return;
    if (hovered) hovered.classList.remove('xmd-hover');
    hovered = el;
    if (el) el.classList.add('xmd-hover');
  }

  window.addEventListener(
    'mousemove',
    (e) => {
      if (!cfg.enabled || !cfg.modifierClick || !modifierActive(e)) return setHover(null);
      setHover(mediaAt(e)?.box || null);
    },
    true
  );
  window.addEventListener('keyup', (e) => {
    if (!modifierActive(e)) setHover(null);
  });
  window.addEventListener('blur', () => setHover(null));

  // --- action-bar button ----------------------------------------------------

  // X's own Share glyph with the arrow flipped to point down, so stroke weight
  // and proportions match the neighbouring icons.
  const DL_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16.41l-5.7-5.7 1.41-1.42L11 12.59V3h2v9.59l3.29-3.3 1.41 1.42L12 16.41zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"/></svg>';

  function addButton(article) {
    const id = primaryStatusId(article);
    if (!id || article.dataset.xmd === id) return;
    if (!article.querySelector(MEDIA_SEL)) return;
    // The post's own action bar is the last group (quoted posts have none).
    const group = [...article.querySelectorAll('[role="group"]')].pop();
    if (!group) return;

    article.querySelectorAll('.xmd-btn').forEach((b) => b.remove());
    article.dataset.xmd = id;
    const btn = document.createElement('div');
    btn.className = 'xmd-btn';
    btn.dataset.statusId = id;
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Download media');
    btn.tabIndex = 0;
    btn.title = 'Download media';
    btn.innerHTML = `<div class="xmd-btn-inner"><div class="xmd-btn-circle"></div>${DL_ICON}</div>`;
    btn.classList.toggle('xmd-done', history.has(id));
    // Borrow the idle icon colour from X's own buttons (differs per theme).
    const ref = group.querySelector('svg');
    if (ref) btn.style.setProperty('--xmd-fg', getComputedStyle(ref).color);
    const trigger = (e) => {
      swallow(e);
      const r = btn.getBoundingClientRect();
      runPost(primaryStatusId(article), e.clientX || r.left, e.clientY || r.bottom, btn);
    };
    btn.addEventListener('click', trigger);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') trigger(e);
    });
    group.appendChild(btn);
  }

  function refreshButtonStates() {
    document.querySelectorAll('.xmd-btn').forEach((b) => b.classList.toggle('xmd-done', history.has(b.dataset.statusId)));
  }

  function removeButtons() {
    document.querySelectorAll('.xmd-btn').forEach((b) => b.remove());
    document.querySelectorAll('article[data-xmd]').forEach((a) => delete a.dataset.xmd);
  }

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      if (cfg.enabled && cfg.showButton) document.querySelectorAll('article').forEach(addButton);
    });
  }

  new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
})();
