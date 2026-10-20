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

function spinner() {
  return '<div class="spinner"></div>';
}

function msg(text, sub = '', isError = false) {
  return `<div class="msg${isError ? ' error' : ''}">
    <strong>${esc(text)}</strong>${sub ? esc(sub) : ''}
  </div>`;
}

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
  home:   (page = 1, cats = [], refresh = 0) => {
    const qs = new URLSearchParams();
    if (page > 1) qs.set('page', page);
    if (cats.length) qs.set('cats', cats.join(','));
    if (refresh > 0) qs.set('r', refresh);
    const q = qs.toString();
    return apiFetch(`/api/home${q ? `?${q}` : ''}`);
  },
  search: (q, page = 1) => apiFetch(`/api/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`),
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
       href="#watch?v=${esc(v.id)}" title="${esc(v.title)}">
      <div class="card-thumb">
        <img src="${esc(v.thumbnail)}" alt="" loading="lazy" decoding="async"
             onerror="this.style.opacity='0'"/>
        ${shortBadge}${durBadge}
      </div>
      <div class="card-info">
        <p class="card-title">${esc(v.title)}</p>
        <p class="card-chan">${esc(v.channel)}</p>
        <p class="card-meta">${esc([v.views, v.published].filter(Boolean).join(' · '))}</p>
      </div>
    </a>`;
}

function videoGrid(videos) {
  return `<div class="grid" id="main-grid">${videos.map(v => videoCard(v)).join('')}</div>`;
}

// Small spinner shown at the bottom while fetching the next page
function pageLoader() {
  const el = document.createElement('div');
  el.id = 'page-loader';
  el.className = 'page-loader';
  el.innerHTML = '<div class="spinner spinner--sm"></div>';
  return el;
}


// ─── Views ────────────────────────────────────────────────────────────────────
async function homeView() {
  stopObserver();

  const cats = Prefs.getCategories();
  if (cats === null) return categoriesView(true); // first visit: ask once
  const refresh  = FeedRefresh.get();
  const cacheKey = `home:${cats.join(',')}:${refresh}`;
  const header   = homeHeader(cats);

  // page starts at 2 — page 1 is always the initial/refresh load
  let page    = 2;
  let loading = false;

  async function loadNext() {
    if (loading) return;
    loading = true;
    stopObserver();

    const loader = pageLoader();
    app.appendChild(loader);

    try {
      const { videos, hasMore } = await api.home(page, cats, refresh);
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
    // Render cached data instantly — no spinner wait
    app.innerHTML = `${header}${videoGrid(cached.data.videos)}`;
    if (cached.data.hasMore) onScrollEnd(loadNext);

    // Always fetch fresh page 1 in background; update grid only if user hasn't scrolled yet
    api.home(1, cats, refresh).then(({ videos, hasMore }) => {
      if (!videos.length) return;
      BrowserCache.set(cacheKey, { videos, hasMore });
      const stillHome = ['home', ''].includes(parseHash().path) && document.getElementById('main-grid');
      if (page === 2 && stillHome) {
        // User hasn't scrolled to load page 2 yet — safe to refresh the grid
        stopObserver();
        app.innerHTML = `${header}${videoGrid(videos)}`;
        if (hasMore) onScrollEnd(loadNext);
      }
    }).catch(() => { /* keep cached grid on network error */ });

  } else {
    // First visit (or a refresh) — show spinner under the header, fetch, then cache
    app.innerHTML = header + spinner();
    setRefreshing(true);
    try {
      const { videos, hasMore } = await api.home(1, cats, refresh);
      if (FeedRefresh.get() !== refresh || !['home', ''].includes(parseHash().path)) return;
      if (!videos.length) {
        app.innerHTML = header + msg('Nothing to show', 'The feed returned no videos.');
        return;
      }
      BrowserCache.set(cacheKey, { videos, hasMore });
      app.innerHTML = `${header}${videoGrid(videos)}`;
      if (hasMore) onScrollEnd(loadNext);
    } catch (e) {
      app.innerHTML = header + msg('Could not load home feed', e.message, true);
    }
    setRefreshing(false);
  }
}

// Home header: the chosen categories with an Edit link, or a prompt to pick some.
function homeHeader(cats) {
  if (!cats.length) {
    return `<div class="feed-head">
      <p class="section-title">Trending</p>
      <div class="feed-actions">${refreshButton()}<a class="feed-edit" href="#categories">Choose categories</a></div>
    </div>`;
  }
  return `<div class="feed-head">
    <p class="section-title">For you</p>
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

async function searchView(q) {
  stopObserver();
  app.innerHTML = spinner();
  searchInput.value = q;

  let page    = 1;
  let loading = false;

  async function loadNext() {
    if (loading) return;
    loading = true;
    stopObserver();

    const loader = pageLoader();
    if (page > 1) app.appendChild(loader);

    try {
      const { videos, hasMore } = await api.search(q, page);

      loader.remove();

      if (page === 1) {
        if (!videos.length) {
          app.innerHTML = msg(`No results for "${q}"`, 'Try a different search term.');
          return;
        }
        app.innerHTML = `
          <p class="section-title">Results for &ldquo;${esc(q)}&rdquo;</p>
          ${videoGrid(videos)}`;
      } else {
        document.getElementById('main-grid')
          ?.insertAdjacentHTML('beforeend', videos.map(v => videoCard(v)).join(''));
      }

      page++;
      if (hasMore) onScrollEnd(loadNext);

    } catch (e) {
      loader.remove();
      if (page === 1) app.innerHTML = msg('Search failed', e.message, true);
    } finally {
      loading = false;
    }
  }

  loadNext();
}

async function watchView(videoId) {
  stopObserver();

  // Render the player immediately — the embed iframe plays independently of
  // our metadata API, so a metadata failure must never block playback.
  app.innerHTML = `
    <div class="watch-layout">
      <div class="watch-main">
        <div class="player-wrap" id="player-wrap">
          <iframe
            id="player"
            src="https://www.youtube-nocookie.com/embed/${esc(videoId)}?autoplay=1&rel=0&modestbranding=1"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowfullscreen
            class="player"
          ></iframe>
        </div>
        <div class="watch-meta" id="watch-meta"><div class="spinner spinner--sm"></div></div>
      </div>
      <aside class="watch-related" id="watch-related"></aside>
    </div>`;

  loadWatchMeta(videoId);
}

// Fetches title/description/related for the watch page. Retries once on its
// own, then shows a Retry button rather than leaving the area blank.
async function loadWatchMeta(videoId, attempt = 1) {
  const stillHere = () =>
    document.getElementById('player') && parseHash().params.get('v') === videoId;

  const meta = document.getElementById('watch-meta');
  if (meta) meta.innerHTML = '<div class="spinner spinner--sm"></div>';

  let v;
  try {
    v = await api.video(videoId);
  } catch (e) {
    if (!stillHere()) return;
    if (attempt < 2) return loadWatchMeta(videoId, attempt + 1);
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
    <p class="watch-channel">${esc(v.channel)}</p>
    <p class="watch-stats">${esc([v.views, v.published, v.duration].filter(Boolean).join(' · '))}</p>
    ${v.description ? `
      <details class="watch-desc">
        <summary>Description</summary>
        <pre>${esc(v.description)}</pre>
      </details>` : ''}`;

  const related = v.related || [];
  document.getElementById('watch-related').innerHTML = related.length ? `
    <p class="watch-related-heading">Up next</p>
    ${related.map(r => videoCard(r, true)).join('')}` : '';

  if (v.title) document.title = `${v.title} – FreeView`;
}

// ─── Router ───────────────────────────────────────────────────────────────────
function parseHash() {
  const raw = location.hash.slice(1) || 'home';
  const qi  = raw.indexOf('?');
  const path   = qi === -1 ? raw : raw.slice(0, qi);
  const params = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  return { path, params };
}

function route() {
  document.title = 'FreeView';
  const { path, params } = parseHash();

  if (path === 'home' || path === '') return homeView();
  if (path === 'categories') return categoriesView(false);
  if (path === 'search' && params.get('q')) return searchView(params.get('q'));
  if (path === 'watch'  && params.get('v')) return watchView(params.get('v'));

  homeView();
}

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
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
