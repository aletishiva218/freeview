// ─── Utilities ───────────────────────────────────────────────────────────────
const app = document.getElementById('app');
const searchInput = document.getElementById('search-input');


function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Skeletons (placeholders shaped like the content that is loading) ────────
const SK_CARD = `<div class="sk-card"><div class="sk sk-thumb"></div><div class="sk-info">
  <div class="sk sk-line sk-line--title"></div><div class="sk sk-line sk-line--title2"></div>
  <div class="sk sk-line sk-line--meta"></div></div></div>`;
const SK_SHORT = `<div class="sk-card"><div class="sk sk-thumb"></div><div class="sk-info">
  <div class="sk sk-line sk-line--title"></div><div class="sk sk-line sk-line--meta2"></div></div></div>`;
const SK_COMPACT = `<div class="sk-compact"><div class="sk sk-thumb"></div><div class="sk-info">
  <div class="sk sk-line sk-line--title"></div><div class="sk sk-line sk-line--title2"></div>
  <div class="sk sk-line sk-line--meta"></div></div></div>`;

// A grid of placeholder cards (portrait ones for the Shorts grid).
function skeletonGrid(shorts = false, count = shorts ? 12 : 12) {
  return `<div class="grid${shorts ? ' grid--shorts' : ''}" aria-hidden="true">${
    (shorts ? SK_SHORT : SK_CARD).repeat(count)}</div>`;
}

// Watch page: title, channel line and description placeholders.
function skeletonWatchMeta() {
  return `<div aria-hidden="true">
    <div class="sk sk-watch-title"></div><div class="sk sk-watch-title2"></div>
    <div class="sk-byline"><div class="sk sk-avatar"></div>
      <div style="flex:1"><div class="sk sk-line" style="width:38%"></div><div class="sk sk-line sk-line--meta2" style="margin:0"></div></div></div>
    <div class="sk sk-desc"></div></div>`;
}

function skeletonRelated(count = 8) {
  return `<div class="sk sk-line" style="width:90px;height:18px;margin-bottom:14px" aria-hidden="true"></div>${SK_COMPACT.repeat(count)}`;
}

const MSG_ICONS = {
  error:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>',
  empty:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8.5 11h5"/></svg>',
};

function msg(text, sub = '', isError = false) {
  return `<div class="msg${isError ? ' error' : ''}">
    <div class="msg-icon" aria-hidden="true">${isError ? MSG_ICONS.error : MSG_ICONS.empty}</div>
    <strong>${esc(text)}</strong>${sub ? `<p>${esc(sub)}</p>` : ''}
  </div>`;
}

// Channel avatar: first letter on a colour derived from the name (stable).
function avatar(name) {
  const n = String(name || '?').trim() || '?';
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `<div class="watch-avatar" style="background:hsl(${h} 55% 42%)" aria-hidden="true">${esc([...n][0].toUpperCase())}</div>`;
}

// ─── Theme (System default / Light / Dark) ────────────────────────────────────
// Stored per device in localStorage. index.html applies it before first paint;
// this keeps the button, menu and browser UI colour in sync.
const THEME_ICONS = {
  system: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  light:  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
};
const THEME_LABELS = { system: 'System (default)', light: 'Light', dark: 'Dark' };

// Saved in localStorage and mirrored to the fv_theme cookie: the Android app
// backs up cookies natively, so the choice survives the app being killed.
const Theme = {
  KEY: 'fv:theme',
  COOKIE: 'fv_theme',
  get() {
    let t = null;
    try { t = localStorage.getItem(this.KEY); } catch { /* ignore */ }
    if (!t) t = (document.cookie.match(/(?:^|; )fv_theme=(light|dark)(?:;|$)/) || [])[1];
    return t === 'light' || t === 'dark' ? t : 'system';
  },
  set(choice) {
    try {
      if (choice === 'system') localStorage.removeItem(this.KEY);
      else localStorage.setItem(this.KEY, choice);
    } catch { /* private mode: the cookie below still keeps it */ }
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = choice === 'system'
      ? `${this.COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`
      : `${this.COOKIE}=${choice}; Max-Age=${365 * 24 * 3600}; Path=/; SameSite=Lax${secure}`;
    this.apply(choice);
  },
  apply(choice = this.get()) {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    // Browser UI (Android address bar etc.) follows the page colour (solid,
    // unlike the translucent top bar, which some browsers would ignore).
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
    const btn = document.getElementById('theme-btn');
    btn.innerHTML = THEME_ICONS[choice];
    btn.setAttribute('aria-label', `Theme: ${THEME_LABELS[choice]}`);
    btn.title = `Theme: ${THEME_LABELS[choice]}`;
    document.querySelectorAll('[data-theme-choice]').forEach(b => {
      b.setAttribute('aria-checked', String(b.dataset.themeChoice === choice));
    });
  },
};

(function setupThemePicker() {
  const btn  = document.getElementById('theme-btn');
  const menu = document.getElementById('theme-menu');
  menu.querySelectorAll('[data-theme-choice]').forEach(b => {
    b.insertAdjacentHTML('afterbegin', THEME_ICONS[b.dataset.themeChoice]);
  });

  const open  = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); menu.querySelector('[aria-checked="true"]')?.focus(); };
  const close = () => { menu.hidden = true;  btn.setAttribute('aria-expanded', 'false'); };

  btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden ? open() : close(); });
  menu.addEventListener('click', e => {
    const item = e.target.closest('[data-theme-choice]');
    if (!item) return;
    Theme.set(item.dataset.themeChoice);
    close();
    btn.focus();
  });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('.theme-picker')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });

  // System mode: follow the device switching between light and dark live.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (Theme.get() === 'system') Theme.apply('system');
  });
  Theme.apply();
})();

// ─── API ──────────────────────────────────────────────────────────────────────
// timeoutMs guards against a request that never resolves (e.g. a stalled
// connection while Render wakes the server) leaving a spinner up forever.
async function apiFetch(url, timeoutMs = 60_000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Request timed out' : e.message);
  } finally {
    clearTimeout(timer);
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

const api = {
  home:   (page = 1, cats = [], refresh = 0, format = 'all') => {
    const qs = new URLSearchParams();
    if (page > 1) qs.set('page', page);
    if (cats.length) qs.set('cats', cats.join(','));
    if (refresh > 0) qs.set('r', refresh);
    if (format !== 'all') qs.set('format', format);
    const q = qs.toString();
    return apiFetch(`/api/home${q ? `?${q}` : ''}`);
  },
  search: (q, page = 1, format = 'all') => apiFetch(`/api/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}${format !== 'all' ? `&format=${format}` : ''}`),
  video:  (id) => apiFetch(`/api/video/${encodeURIComponent(id)}`, 45_000),
};

// ─── Browser cache (localStorage) ────────────────────────────────────────────
const BrowserCache = {
  TTL: 5 * 60 * 1000, // 5 minutes

  set(key, data) {
    try {
      localStorage.setItem('fv:' + key, JSON.stringify({ data, ts: Date.now() }));
    } catch { /* storage full or private mode */ }
  },

  get(key) {
    try {
      const raw = localStorage.getItem('fv:' + key);
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      return { data, fresh: Date.now() - ts < this.TTL };
    } catch { return null; }
  },
};

// ─── Category preferences (stored in a cookie on this device) ────────────────
const CATEGORIES = [
  { id: 'film',          label: 'Film & Animation' },
  { id: 'autos',         label: 'Autos & Vehicles' },
  { id: 'music',         label: 'Music' },
  { id: 'pets',          label: 'Pets & Animals' },
  { id: 'sports',        label: 'Sports' },
  { id: 'travel',        label: 'Travel & Events' },
  { id: 'gaming',        label: 'Gaming' },
  { id: 'people',        label: 'People & Blogs' },
  { id: 'comedy',        label: 'Comedy' },
  { id: 'entertainment', label: 'Entertainment' },
  { id: 'news',          label: 'News & Politics' },
  { id: 'howto',         label: 'Howto & Style' },
  { id: 'education',     label: 'Education' },
  { id: 'science',       label: 'Science & Technology' },
  { id: 'nonprofits',    label: 'Nonprofits & Activism' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));
const CATS_COOKIE  = 'fv_cats';

const Prefs = {
  // null = never asked, [] = skipped, [...ids] = chosen categories
  getCategories() {
    const m = document.cookie.match(new RegExp(`(?:^|; )${CATS_COOKIE}=([^;]*)`));
    if (!m) return null;
    const val = decodeURIComponent(m[1]);
    if (val === 'none') return [];
    return val.split(',').filter(id => CATEGORY_IDS.has(id));
  },

  setCategories(ids) {
    const val = ids.length ? ids.join(',') : 'none';
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${CATS_COOKIE}=${encodeURIComponent(val)}; Max-Age=${365 * 24 * 3600}; Path=/; SameSite=Lax${secure}`;
  },
};

function categoryLabel(id) {
  return CATEGORIES.find(c => c.id === id)?.label || id;
}

// Home feed format. "All" is the default for every new visit; the choice is
// kept per tab so coming back from a video keeps the same filter.
const FORMATS = [
  { id: 'all',    label: 'All' },
  { id: 'videos', label: 'Full videos (16:9)' },
  { id: 'shorts', label: 'YouTube Shorts (9:16)' },
];
const FeedFormat = {
  KEY: 'fv:format',
  get() {
    try {
      const f = sessionStorage.getItem(this.KEY);
      return FORMATS.some(x => x.id === f) ? f : 'all';
    } catch { return 'all'; }
  },
  set(f) {
    try { sessionStorage.setItem(this.KEY, f); } catch { /* private mode */ }
  },
};

// How many times the home feed was refreshed in this tab. Each value maps to a
// different set of videos from the same categories (see feedPlan on the server).
// Per-tab so coming back from a video shows the same feed you left.
const FeedRefresh = {
  KEY: 'fv:refresh',
  get() {
    try { return Math.max(0, parseInt(sessionStorage.getItem(this.KEY)) || 0); } catch { return 0; }
  },
  set(n) {
    try { sessionStorage.setItem(this.KEY, String(n)); } catch { /* private mode */ }
  },
};

// ─── Infinite scroll ──────────────────────────────────────────────────────────
let _observer = null;

function stopObserver() {
  if (_observer) { _observer.disconnect(); _observer = null; }
  document.getElementById('scroll-sentinel')?.remove();
}

// Attach an IntersectionObserver to a sentinel div appended to #app.
// `cb` is called once the sentinel enters the viewport (with 300px margin).
function onScrollEnd(cb) {
  stopObserver();
  const sentinel = document.createElement('div');
  sentinel.id = 'scroll-sentinel';
  app.appendChild(sentinel);
  _observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) cb();
  }, { rootMargin: '300px' });
  _observer.observe(sentinel);
}

// ─── Components ───────────────────────────────────────────────────────────────
function videoCard(v, compact = false) {
  const shortBadge = v.isShort ? '<span class="card-short-badge">Shorts</span>' : '';
  const durBadge   = !v.isShort && v.duration
    ? `<span class="card-dur">${esc(v.duration)}</span>` : '';
  return `
    <a class="card${compact ? ' card--compact' : ''}${v.isShort ? ' card--short' : ''}"
       href="${v.isShort ? `#shorts?v=${esc(v.id)}` : `#watch?v=${esc(v.id)}`}" title="${esc(v.title)}"
       ${v.isShort ? `data-id="${esc(v.id)}" data-title="${esc(v.title)}" data-views="${esc(v.views)}" data-thumb="${esc(v.thumbnail)}"` : ''}>
      <div class="card-thumb">
        <img src="${esc(v.thumbnail)}" alt="" loading="lazy" decoding="async"
             onload="this.classList.add('is-loaded')"
             onerror="this.parentNode.classList.add('thumb-error')"/>
        ${shortBadge}${durBadge}
      </div>
      <div class="card-info">
        <p class="card-title">${esc(v.title)}</p>
        <p class="card-chan">${esc(v.channel)}</p>
        <p class="card-meta">${esc([v.views, v.published].filter(Boolean).join(' · '))}</p>
      </div>
    </a>`;
}

// shortsOnly: 9:16 portrait thumbnails in a denser grid, like YouTube's Shorts tab.
function videoGrid(videos, shortsOnly = false) {
  return `<div class="grid${shortsOnly ? ' grid--shorts' : ''}" id="main-grid">${videos.map(v => videoCard(v)).join('')}</div>`;
}

// Placeholder cards shown below the grid while fetching the next page
function pageLoader(shorts = false) {
  const el = document.createElement('div');
  el.id = 'page-loader';
  el.className = 'page-loader';
  el.innerHTML = skeletonGrid(shorts, shorts ? 6 : 4);
  return el;
}


// ─── Views ────────────────────────────────────────────────────────────────────
async function homeView() {
  stopObserver();

  const cats = Prefs.getCategories();
  if (cats === null) return categoriesView(true); // first visit: ask once
  const refresh  = FeedRefresh.get();
  const format   = FeedFormat.get();
  const cacheKey = `home:${cats.join(',')}:${refresh}:${format}`;
  const header   = homeHeader(cats, format);
  const grid     = videos => videoGrid(videos, format === 'shorts');

  // page starts at 2 — page 1 is always the initial/refresh load
  let page    = 2;
  let loading = false;

  async function loadNext() {
    if (loading) return;
    loading = true;
    stopObserver();

    const loader = pageLoader(format === 'shorts');
    app.appendChild(loader);

    try {
      const { videos, hasMore } = await api.home(page, cats, refresh, format);
      loader.remove();
      document.getElementById('main-grid')
        ?.insertAdjacentHTML('beforeend', videos.map(v => videoCard(v)).join(''));
      page++;
      if (hasMore) onScrollEnd(loadNext);
    } catch {
      loader.remove();
    } finally {
      loading = false;
    }
  }

  const cached = BrowserCache.get(cacheKey);

  if (cached) {
    // Render cached data instantly — no loading state
    app.innerHTML = `${header}${grid(cached.data.videos)}`;
    if (cached.data.hasMore) onScrollEnd(loadNext);

    // Always fetch fresh page 1 in background; update grid only if user hasn't scrolled yet
    api.home(1, cats, refresh, format).then(({ videos, hasMore }) => {
      if (!videos.length) return;
      BrowserCache.set(cacheKey, { videos, hasMore });
      const stillHome = ['home', ''].includes(parseHash().path) && document.getElementById('main-grid');
      if (page === 2 && stillHome) {
        // User hasn't scrolled to load page 2 yet — safe to refresh the grid
        stopObserver();
        app.innerHTML = `${header}${grid(videos)}`;
        if (hasMore) onScrollEnd(loadNext);
      }
    }).catch(() => { /* keep cached grid on network error */ });

  } else {
    // First visit (or a refresh) — skeleton cards under the header, fetch, then cache
    app.innerHTML = header + skeletonGrid(format === 'shorts');
    setRefreshing(true);
    try {
      const { videos, hasMore } = await api.home(1, cats, refresh, format);
      if (FeedRefresh.get() !== refresh || FeedFormat.get() !== format
          || !['home', ''].includes(parseHash().path)) return;
      if (!videos.length) {
        app.innerHTML = header + msg('Nothing to show', 'The feed returned no videos.');
        return;
      }
      BrowserCache.set(cacheKey, { videos, hasMore });
      app.innerHTML = `${header}${grid(videos)}`;
      if (hasMore) onScrollEnd(loadNext);
    } catch (e) {
      app.innerHTML = header + msg('Could not load home feed', e.message, true);
    }
    setRefreshing(false);
  }
}

// Home header: the chosen categories with an Edit link (or a prompt to pick
// some), then the All / Full videos / Shorts tabs.
function homeHeader(cats, format) {
  return categoryHeader(cats) + formatTabs(format);
}

function formatTabs(format) {
  return `<div class="format-tabs" role="tablist" aria-label="Video format">
    ${FORMATS.map(f => `
      <button type="button" class="format-tab" role="tab" data-format="${f.id}"
              aria-selected="${f.id === format}">${esc(f.label)}</button>`).join('')}
  </div>`;
}

function categoryHeader(cats) {
  if (!cats.length) {
    return `<div class="feed-head">
      <h1 class="section-title">Trending</h1>
      <div class="feed-actions">${refreshButton()}<a class="feed-edit" href="#categories">Choose categories</a></div>
    </div>`;
  }
  return `<div class="feed-head">
    <h1 class="section-title">For you</h1>
    <div class="feed-cats">${cats.map(c => `<span class="feed-cat">${esc(categoryLabel(c))}</span>`).join('')}</div>
    <div class="feed-actions">${refreshButton()}<a class="feed-edit" href="#categories">Edit</a></div>
  </div>`;
}

function refreshButton() {
  return `<button type="button" class="feed-refresh" id="feed-refresh" aria-label="Refresh videos">
    <span class="feed-refresh-icon" aria-hidden="true">&#8635;</span> Refresh
  </button>`;
}

function setRefreshing(on) {
  const btn = document.getElementById('feed-refresh');
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('is-loading', on);
}

// Format tabs: switch between All / Full videos / Shorts.
app.addEventListener('click', e => {
  const tab = e.target.closest('.format-tab');
  if (!tab || tab.getAttribute('aria-selected') === 'true') return;
  window.scrollTo(0, 0);
  const { path, params } = parseHash();
  if (path === 'search') {
    // Search keeps its tab in the URL; replace (not push) so Back skips tab switches.
    const q = params.get('q');
    const f = tab.dataset.format;
    history.replaceState(null, '', `#search?q=${encodeURIComponent(q)}${f !== 'all' ? `&f=${f}` : ''}`);
    renderedHash = location.hash;
    searchView(q, f);
    return;
  }
  FeedFormat.set(tab.dataset.format);
  homeView();
});

// Refresh: move to the next set of videos for the same categories.
app.addEventListener('click', e => {
  const btn = e.target.closest('#feed-refresh');
  if (!btn || btn.disabled) return;
  FeedRefresh.set(FeedRefresh.get() + 1);
  window.scrollTo(0, 0);
  homeView();
});

// Category picker. `firstVisit` shows Skip/Continue; otherwise Cancel/Save.
function categoriesView(firstVisit = false) {
  stopObserver();
  document.title = 'Choose categories – FreeView';
  const selected = new Set(Prefs.getCategories() || []);

  app.innerHTML = `
    <div class="cat-picker">
      <span class="cat-eyebrow">${firstVisit ? 'Welcome to FreeView' : 'Personalise'}</span>
      <h1 class="cat-title">${firstVisit ? 'What do you like to watch?' : 'Your categories'}</h1>
      <p class="cat-sub">Pick as many as you like. Your home feed will show these.
        ${firstVisit ? 'You can change them anytime.' : 'Choose none to see trending videos.'}</p>
      <div class="cat-grid">
        ${CATEGORIES.map(c => `
          <button type="button" class="cat-chip" data-id="${c.id}" aria-pressed="${selected.has(c.id)}">
            ${esc(c.label)}
          </button>`).join('')}
      </div>
      <div class="cat-actions">
        <button type="button" class="btn btn--ghost" id="cat-secondary">${firstVisit ? 'Skip' : 'Cancel'}</button>
        <button type="button" class="btn btn--primary" id="cat-primary"></button>
      </div>
    </div>`;

  const primary = document.getElementById('cat-primary');
  const refresh = () => {
    const n = selected.size;
    if (firstVisit) {
      primary.textContent = n ? `Continue (${n})` : 'Continue';
      primary.disabled = n === 0;
    } else {
      primary.textContent = n ? `Save (${n})` : 'Save';
    }
  };
  refresh();

  app.querySelector('.cat-grid').addEventListener('click', e => {
    const chip = e.target.closest('.cat-chip');
    if (!chip) return;
    const id = chip.dataset.id;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    chip.setAttribute('aria-pressed', selected.has(id));
    refresh();
  });

  const goHome = () => {
    if (!location.hash || location.hash === '#home') homeView();
    else location.hash = 'home';
  };

  primary.addEventListener('click', () => {
    // Keep the canonical order so the same choice always maps to the same feed/cache.
    Prefs.setCategories(CATEGORIES.map(c => c.id).filter(id => selected.has(id)));
    FeedRefresh.set(0);
    goHome();
  });

  document.getElementById('cat-secondary').addEventListener('click', () => {
    if (firstVisit) Prefs.setCategories([]);
    goHome();
  });
}

// format lives in the URL (#search?q=…&f=shorts) so Back/reload keep it.
async function searchView(q, format = 'all') {
  if (!FORMATS.some(f => f.id === format)) format = 'all';
  stopObserver();
  searchInput.value = q;
  const header = `<h1 class="section-title">Results for <q>${esc(q)}</q></h1>${formatTabs(format)}`;
  app.innerHTML = header + skeletonGrid(format === 'shorts');

  let page    = 1;
  let loading = false;

  async function loadNext() {
    if (loading) return;
    loading = true;
    stopObserver();

    const loader = pageLoader(format === 'shorts');
    if (page > 1) app.appendChild(loader);

    try {
      const { videos, hasMore } = await api.search(q, page, format);
      // User switched tab or searched again while this was loading
      const now = parseHash();
      if (now.path !== 'search' || now.params.get('q') !== q || (now.params.get('f') || 'all') !== format) return;

      loader.remove();

      if (page === 1) {
        if (!videos.length) {
          const what = format === 'shorts' ? 'Shorts' : format === 'videos' ? 'full videos' : 'results';
          app.innerHTML = header + msg(`No ${what} for "${q}"`, 'Try a different search term or tab.');
          return;
        }
        app.innerHTML = header + videoGrid(videos, format === 'shorts');
      } else {
        document.getElementById('main-grid')
          ?.insertAdjacentHTML('beforeend', videos.map(v => videoCard(v)).join(''));
      }

      page++;
      if (hasMore) onScrollEnd(loadNext);

    } catch (e) {
      loader.remove();
      if (page === 1) app.innerHTML = header + msg('Search failed', e.message, true);
    } finally {
      loading = false;
    }
  }

  loadNext();
}

// isShortHint: the card that linked here was a Short, so start with the 9:16 player.
async function watchView(videoId, isShortHint = false) {
  stopObserver();

  // Render the player immediately — the embed iframe plays independently of
  // our metadata API, so a metadata failure must never block playback.
  app.innerHTML = `
    <div class="watch-layout">
      <div class="watch-main">
        <div class="player-wrap${isShortHint ? ' player-wrap--short' : ''}" id="player-wrap">
          <iframe
            id="player"
            src="https://www.youtube-nocookie.com/embed/${esc(videoId)}?autoplay=1&rel=0&modestbranding=1"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowfullscreen
            class="player"
          ></iframe>
        </div>
        <div class="watch-meta" id="watch-meta">${skeletonWatchMeta()}</div>
      </div>
      <aside class="watch-related" id="watch-related">${skeletonRelated()}</aside>
    </div>`;

  loadWatchMeta(videoId);
}

// Fetches title/description/related for the watch page. Retries once on its
// own, then shows a Retry button rather than leaving the area blank.
async function loadWatchMeta(videoId, attempt = 1) {
  const stillHere = () =>
    document.getElementById('player') && parseHash().params.get('v') === videoId;

  const meta = document.getElementById('watch-meta');
  if (meta) meta.innerHTML = skeletonWatchMeta();
  const rel = document.getElementById('watch-related');
  if (rel && !rel.querySelector('.card, .sk-compact')) rel.innerHTML = skeletonRelated();

  let v;
  try {
    v = await api.video(videoId);
  } catch (e) {
    if (!stillHere()) return;
    if (attempt < 2) return loadWatchMeta(videoId, attempt + 1);
    document.getElementById('watch-related').innerHTML = '';
    document.getElementById('watch-meta').innerHTML = `
      <div class="msg error">
        <strong>Could not load video details</strong>${esc(e.message)}
      </div>
      <button type="button" class="retry-btn" id="meta-retry">Retry</button>`;
    document.getElementById('meta-retry')
      .addEventListener('click', () => loadWatchMeta(videoId));
    return;
  }

  // User navigated away while the request was in flight
  if (!stillHere()) return;

  if (v.isShort) document.getElementById('player-wrap').classList.add('player-wrap--short');

  document.getElementById('watch-meta').innerHTML = `
    <h1 class="watch-title">${esc(v.title)}</h1>
    <div class="watch-byline">
      ${avatar(v.channel)}
      <div class="watch-byline-text">
        <p class="watch-channel">${esc(v.channel)}</p>
        <p class="watch-stats">${esc([v.views, v.published, v.duration].filter(Boolean).join(' · '))}</p>
      </div>
    </div>
    ${v.description ? `
      <details class="watch-desc">
        <summary>Description</summary>
        <pre>${esc(v.description)}</pre>
      </details>` : ''}`;

  const related = v.related || [];
  document.getElementById('watch-related').innerHTML = related.length ? `
    <h2 class="watch-related-heading">Up next</h2>
    ${related.map(r => videoCard(r, true)).join('')}` : '';

  if (v.title) document.title = `${v.title} – FreeView`;
}

// ─── Shorts viewer ───────────────────────────────────────────────────────────
// Full-screen vertical feed like YouTube Shorts: one Short per screen, swipe
// (or scroll / arrow keys) to the next. Only the Short on screen has a live
// player; the rest show their thumbnail, which keeps it light on phones.

// The Shorts after the tapped card become the start of the queue.
const ShortsQueue = {
  KEY: 'fv:shortsQueue',
  save(items) {
    try { sessionStorage.setItem(this.KEY, JSON.stringify(items)); } catch { /* ignore */ }
  },
  load() {
    try { return JSON.parse(sessionStorage.getItem(this.KEY)) || null; } catch { return null; }
  },
};

document.addEventListener('click', e => {
  const card = e.target.closest('#app a.card--short');
  if (!card) return;
  const cards = [...document.querySelectorAll('#app a.card--short')];
  const at = cards.indexOf(card);
  ShortsQueue.save(cards.slice(at, at + 200).map(c => ({
    id: c.dataset.id, title: c.dataset.title, views: c.dataset.views, thumbnail: c.dataset.thumb,
  })));
}, true);

const ShortsViewer = (() => {
  const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';
  let root = null, feed = null, items = [], ids = new Set(), slides = [];
  let active = -1, iframe = null, io = null, activateTimer = null, autoplayTimer = null;
  let playing = false, started = false, userPaused = false;
  let muted = false, autoMuted = false;
  let nextPage = 1, exhausted = false, loadingMore = false, loadFailedAt = 0;
  // Opened from search results: keep loading Shorts for that search query.
  let searchQuery = null;
  // Gesture state: the feed is paged by our own handlers (like YouTube) rather
  // than native scroll-snap, which needs a >50% drag and ignores short flicks.
  let dragging = false, dragY0 = 0, dragTop0 = 0, dragIndex = 0, dragTrail = [];
  let wheelAcc = 0, wheelLockUntil = 0, settleTimer = null;

  const isOpen = () => !!root;

  function open(startId) {
    if (root) {
      // Already open (e.g. forward/back between Shorts): jump to that Short.
      const i = items.findIndex(x => x.id === startId);
      if (i >= 0 && i !== active) goTo(i, false);
      return;
    }
    const queued = ShortsQueue.load();
    items = queued && queued[0]?.id === startId
      ? queued.filter(x => x && /^[\w-]{11}$/.test(x.id))
      : [{ id: startId, title: '', views: '', thumbnail: `https://i.ytimg.com/vi/${startId}/hqdefault.jpg` }];
    ids = new Set(items.map(x => x.id));
    searchQuery = renderedHash?.startsWith('#search?')
      ? new URLSearchParams(renderedHash.slice('#search?'.length)).get('q') : null;
    active = -1; nextPage = 1; exhausted = false; loadingMore = false; loadFailedAt = 0;
    started = false; playing = false; userPaused = false;

    root = document.createElement('div');
    root.className = 'shorts-viewer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Shorts');
    root.innerHTML = `
      <div class="shorts-feed"></div>
      <button type="button" class="shorts-btn shorts-close" aria-label="Close Shorts">&#8592;</button>
      <button type="button" class="shorts-btn shorts-mute" aria-label="Mute"></button>
      <button type="button" class="shorts-unmute" hidden>&#128263; Tap to unmute</button>
      <div class="shorts-nav">
        <button type="button" class="shorts-btn" data-step="-1" aria-label="Previous Short">&#9650;</button>
        <button type="button" class="shorts-btn" data-step="1" aria-label="Next Short">&#9660;</button>
      </div>`;
    feed = root.querySelector('.shorts-feed');
    slides = [];
    document.body.appendChild(root);
    document.documentElement.classList.add('shorts-open');
    updateMuteButton();

    io = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (en.isIntersecting && !dragging) {
          const i = Number(en.target.dataset.index);
          clearTimeout(activateTimer);
          // Small delay so fast flings don't spin up a player for every Short passed.
          activateTimer = setTimeout(() => activate(i), 150);
        }
      }
    }, { root: feed, threshold: 0.6 });

    appendSlides(items);

    feed.addEventListener('touchstart', onTouchStart, { passive: true });
    feed.addEventListener('touchmove', onTouchMove, { passive: false });
    feed.addEventListener('touchend', onTouchEnd);
    feed.addEventListener('touchcancel', onTouchEnd);
    feed.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);
    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('message', onPlayerMessage);

    if (!items[0].title) fillMeta(0);
    loadMore();
  }

  function close() {
    if (!root) return;
    clearTimeout(activateTimer);
    clearTimeout(autoplayTimer);
    clearTimeout(settleTimer);
    io?.disconnect();
    dragging = false;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('message', onPlayerMessage);
    root.remove();
    root = feed = iframe = io = null;
    slides = [];
    active = -1;
    document.documentElement.classList.remove('shorts-open');
    document.title = 'FreeView';
  }

  function slideHtml(it, i) {
    return `
      <div class="short-frame">
        <img class="short-poster" src="${esc(it.thumbnail)}" alt="" decoding="async"
             ${i > 2 ? 'loading="lazy"' : ''} onerror="this.style.opacity='0'"/>
        <div class="short-player"></div>
        <div class="short-tap" aria-hidden="true"></div>
        <div class="short-paused" aria-hidden="true">&#9654;</div>
        <div class="short-info">
          <p class="short-title">${esc(it.title)}</p>
          <p class="short-meta">${esc(it.views)}</p>
        </div>
      </div>`;
  }

  function appendSlides(list) {
    for (const it of list) {
      const i = slides.length;
      const el = document.createElement('section');
      el.className = 'short-slide';
      el.dataset.index = i;
      el.innerHTML = slideHtml(it, i);
      feed.appendChild(el);
      slides.push(el);
      io.observe(el);
    }
  }

  // Direct link / reload: fill in the title from the metadata API.
  async function fillMeta(i) {
    try {
      const v = await api.video(items[i].id);
      if (!root || !slides[i]) return;
      items[i].title = v.title; items[i].views = v.views;
      slides[i].querySelector('.short-title').textContent = v.title || '';
      slides[i].querySelector('.short-meta').textContent = v.views || '';
      if (i === active && v.title) document.title = `${v.title} – FreeView`;
    } catch { /* title stays empty; playback is unaffected */ }
  }

  // More Shorts: for the search they came from, otherwise from the user's
  // categories (same cached feeds as the Shorts tabs).
  async function loadMore() {
    if (!root || loadingMore || exhausted) return;
    if (Date.now() - loadFailedAt < 10_000) return; // back off after a failure
    loadingMore = true;
    try {
      const cats = Prefs.getCategories() || [];
      let added = 0;
      while (root && !exhausted && added < 5 && nextPage <= 10) {
        const { videos, hasMore } = searchQuery
          ? await api.search(searchQuery, nextPage, 'shorts')
          : await api.home(nextPage, cats, FeedRefresh.get(), 'shorts');
        if (!root) return;
        nextPage++;
        const fresh = videos.filter(v => v.isShort && !ids.has(v.id));
        fresh.forEach(v => ids.add(v.id));
        items.push(...fresh);
        appendSlides(fresh);
        added += fresh.length;
        if (!hasMore || nextPage > 10) exhausted = true;
      }
      if (exhausted && root) appendEndSlide();
    } catch {
      loadFailedAt = Date.now();
    } finally {
      loadingMore = false;
    }
  }

  function appendEndSlide() {
    if (root.querySelector('.short-slide--end')) return;
    const el = document.createElement('section');
    el.className = 'short-slide short-slide--end';
    el.innerHTML = `<div class="short-end"><p>You're all caught up</p>
      <button type="button" class="btn btn--primary" data-action="close">Back to videos</button></div>`;
    feed.appendChild(el);
  }

  function activate(i) {
    if (!root || i === active || !items[i]) return;
    if (active >= 0 && slides[active]) {
      slides[active].querySelector('.short-player').innerHTML = '';
      slides[active].classList.remove('is-paused', 'is-playing');
    }
    active = i;
    playing = false; started = false; userPaused = false;
    const it = items[i];

    iframe = document.createElement('iframe');
    iframe.className = 'short-iframe';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.src = `${PLAYER_ORIGIN}/embed/${encodeURIComponent(it.id)}?autoplay=1&playsinline=1&loop=1`
      + `&playlist=${encodeURIComponent(it.id)}&controls=0&rel=0&modestbranding=1&fs=0&iv_load_policy=3`
      + `&enablejsapi=1&mute=${muted ? 1 : 0}&origin=${encodeURIComponent(location.origin)}`;
    // Ask the player to report its state (playing/paused) via postMessage.
    iframe.addEventListener('load', () => send('listening'));
    slides[i].querySelector('.short-player').appendChild(iframe);

    // Unmuted autoplay can be blocked by the browser; fall back to muted
    // autoplay (always allowed) and offer "Tap to unmute", like YouTube.
    clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => {
      if (!root || active !== i || started || muted) return;
      autoMuted = true;
      setMuted(true);
      command('playVideo');
    }, 3500);

    history.replaceState(null, '', `#shorts?v=${it.id}`);
    document.title = it.title ? `${it.title} – FreeView` : 'Shorts – FreeView';
    if (i >= items.length - 4) loadMore();
  }

  function send(event, extra = {}) {
    try {
      iframe?.contentWindow?.postMessage(
        JSON.stringify({ event, id: 'fv-short', channel: 'widget', ...extra }), PLAYER_ORIGIN);
    } catch { /* player gone */ }
  }
  const command = (func, args = []) => send('command', { func, args });

  function onPlayerMessage(e) {
    if (!iframe || e.source !== iframe.contentWindow || e.origin !== PLAYER_ORIGIN) return;
    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    const state = data?.event === 'onStateChange' ? data.info
      : data?.event === 'infoDelivery' ? data.info?.playerState : undefined;
    if (state === undefined || state === null) return;
    const slide = slides[active];
    if (state === 1) {            // playing
      playing = true; started = true;
      slide?.classList.add('is-playing'); slide?.classList.remove('is-paused');
    } else if (state === 2) {     // paused
      playing = false;
      if (userPaused) slide?.classList.add('is-paused');
    } else if (state === 0) {     // ended: loop
      command('seekTo', [0, true]); command('playVideo');
    }
  }

  function togglePlay() {
    if (playing) { userPaused = true; command('pauseVideo'); slides[active]?.classList.add('is-paused'); }
    else { userPaused = false; command('playVideo'); slides[active]?.classList.remove('is-paused'); }
    if (autoMuted) { autoMuted = false; setMuted(false); }
  }

  function setMuted(m) {
    muted = m;
    command(m ? 'mute' : 'unMute');
    updateMuteButton();
  }

  function updateMuteButton() {
    if (!root) return;
    const b = root.querySelector('.shorts-mute');
    b.innerHTML = muted ? '&#128263;' : '&#128266;';
    b.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    root.querySelector('.shorts-unmute').hidden = !(muted && autoMuted);
  }

  // ── Paging ──
  const slideHeight = () => feed.clientHeight || 1;
  const currentIndex = () => Math.round(feed.scrollTop / slideHeight());
  const lastIndex = () => feed.children.length - 1; // includes the end slide

  function goTo(i, smooth = true) {
    if (!root) return;
    i = Math.max(0, Math.min(lastIndex(), i));
    feed.scrollTo({ top: i * slideHeight(), behavior: smooth ? 'smooth' : 'auto' });
    // Activate once the slide has settled (the observer may have skipped it
    // while a finger was still down).
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => activate(i), smooth ? 380 : 0);
  }

  function step(d) {
    goTo(currentIndex() + d);
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    dragging = true;
    dragY0 = e.touches[0].clientY;
    dragTrail = [{ t: e.timeStamp, y: dragY0 }];
    dragIndex = currentIndex();
    dragTop0 = dragIndex * slideHeight();
  }

  function onTouchMove(e) {
    if (!dragging) return;
    e.preventDefault(); // we move the feed ourselves
    const y = e.touches[0].clientY;
    const now = e.timeStamp; // when the finger moved, not when this handler ran
    dragTrail.push({ t: now, y });
    while (dragTrail.length > 2 && now - dragTrail[0].t > 100) dragTrail.shift();
    feed.scrollTo({ top: dragTop0 - (y - dragY0), behavior: 'auto' });
  }

  function onTouchEnd(e) {
    if (!dragging) return;
    dragging = false;
    const t = e.changedTouches?.[0];
    const endY = t ? t.clientY : dragTrail[dragTrail.length - 1].y;
    const dy = endY - dragY0;
    // Finger speed over the last ~100ms (px/ms), so a quick flick counts even
    // if the finger rested before it.
    const first = dragTrail[0];
    const velocity = (endY - first.y) / Math.max(1, e.timeStamp - first.t);
    const far = Math.abs(dy) > slideHeight() * 0.15;
    const flick = Math.abs(velocity) > 0.45 && Math.abs(dy) > 24;
    if (far || flick) goTo(dragIndex + (dy < 0 ? 1 : -1));
    else if (Math.abs(dy) > 2) goTo(dragIndex); // spring back
  }

  // Mouse wheel / trackpad: one Short per gesture.
  function onWheel(e) {
    e.preventDefault();
    const now = performance.now();
    if (now < wheelLockUntil) return;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) >= 40) {
      step(wheelAcc > 0 ? 1 : -1);
      wheelAcc = 0;
      wheelLockUntil = now + 550;
    }
  }

  function onResize() {
    if (root && active >= 0) feed.scrollTo({ top: active * slideHeight(), behavior: 'auto' });
  }

  function exit() {
    if (renderedHash !== null) history.back();
    else location.hash = 'home';
  }

  function onClick(e) {
    if (e.target.closest('.shorts-close') || e.target.closest('[data-action="close"]')) return exit();
    if (e.target.closest('.shorts-mute')) { autoMuted = false; return setMuted(!muted); }
    if (e.target.closest('.shorts-unmute')) { autoMuted = false; return setMuted(false); }
    const nav = e.target.closest('[data-step]');
    if (nav) return step(Number(nav.dataset.step));
    if (e.target.closest('.short-tap')) togglePlay();
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowDown': case 'PageDown': case 'j': e.preventDefault(); step(1); break;
      case 'ArrowUp':   case 'PageUp':   case 'k': e.preventDefault(); step(-1); break;
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'm': autoMuted = false; setMuted(!muted); break;
      case 'Escape': exit(); break;
    }
  }

  return { open, close, isOpen };
})();

// ─── Router ───────────────────────────────────────────────────────────────────
function parseHash() {
  const raw = location.hash.slice(1) || 'home';
  const qi  = raw.indexOf('?');
  const path   = qi === -1 ? raw : raw.slice(0, qi);
  const params = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  return { path, params };
}

// Hash of the page currently rendered in #app (the Shorts viewer is an
// overlay on top of it, so closing the viewer can reveal it unchanged).
let renderedHash = null;

function route() {
  const { path, params } = parseHash();
  if (path === 'shorts' && params.get('v')) return ShortsViewer.open(params.get('v'));

  ShortsViewer.close();
  renderedHash = location.hash;
  document.title = 'FreeView';

  if (path === 'home' || path === '') return homeView();
  if (path === 'categories') return categoriesView(false);
  if (path === 'search' && params.get('q')) return searchView(params.get('q'), params.get('f') || 'all');
  if (path === 'watch'  && params.get('v')) return watchView(params.get('v'), params.get('short') === '1');

  homeView();
}

window.addEventListener('hashchange', () => {
  const leavingShorts = ShortsViewer.isOpen() && parseHash().path !== 'shorts';
  if (leavingShorts && location.hash === renderedHash) {
    // Back from Shorts to the page underneath: keep it and its scroll position.
    ShortsViewer.close();
    return;
  }
  if (parseHash().path !== 'shorts') window.scrollTo(0, 0);
  route();
});

document.getElementById('search-form').addEventListener('submit', e => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q) location.hash = `search?q=${encodeURIComponent(q)}`;
});

document.getElementById('logo-btn').addEventListener('click', () => {
  searchInput.value = '';
  // If already on #home the hashchange event won't fire, so force a fresh render.
  if (!location.hash || location.hash === '#home') {
    homeView();
  } else {
    location.hash = 'home';
  }
});

route();
