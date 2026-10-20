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
async function apiFetch(url) {
  const r = await fetch(url);
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

const api = {
  home:   (page = 1) => apiFetch(`/api/home${page > 1 ? `?page=${page}` : ''}`),
  search: (q, page = 1) => apiFetch(`/api/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`),
  video:  (id) => apiFetch(`/api/video/${encodeURIComponent(id)}`),
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
      const { videos, hasMore } = await api.home(page);
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

  const cached = BrowserCache.get('home');

  if (cached) {
    // Render cached data instantly — no spinner wait
    app.innerHTML = `<p class="section-title">Trending</p>${videoGrid(cached.data.videos)}`;
    if (cached.data.hasMore) onScrollEnd(loadNext);

    // Always fetch fresh page 1 in background; update grid only if user hasn't scrolled yet
    api.home(1).then(({ videos, hasMore }) => {
      if (!videos.length) return;
      BrowserCache.set('home', { videos, hasMore });
      if (page === 2) {
        // User hasn't scrolled to load page 2 yet — safe to refresh the grid
        stopObserver();
        app.innerHTML = `<p class="section-title">Trending</p>${videoGrid(videos)}`;
        if (hasMore) onScrollEnd(loadNext);
      }
    }).catch(() => { /* keep cached grid on network error */ });

  } else {
    // First visit — show spinner, fetch, then cache
    app.innerHTML = spinner();
    try {
      const { videos, hasMore } = await api.home(1);
      if (!videos.length) {
        app.innerHTML = msg('Nothing to show', 'Trending feed returned empty.');
        return;
      }
      BrowserCache.set('home', { videos, hasMore });
      app.innerHTML = `<p class="section-title">Trending</p>${videoGrid(videos)}`;
      if (hasMore) onScrollEnd(loadNext);
    } catch (e) {
      app.innerHTML = msg('Could not load home feed', e.message, true);
    }
  }
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

  try {
    const v = await api.video(videoId);

    // User navigated away while the request was in flight
    if (!document.getElementById('player') || parseHash().params.get('v') !== videoId) return;

    if (v.isShort) document.getElementById('player-wrap').classList.add('player-wrap--short');

    document.getElementById('watch-meta').innerHTML = `
      <h1 class="watch-title">${esc(v.title)}</h1>
      <p class="watch-channel">${esc(v.channel)}</p>
      <p class="watch-stats">${esc([v.views, v.duration].filter(Boolean).join(' · '))}</p>
      ${v.description ? `
        <details class="watch-desc">
          <summary>Description</summary>
          <pre>${esc(v.description)}</pre>
        </details>` : ''}`;

    document.getElementById('watch-related').innerHTML = v.related.length ? `
      <p class="watch-related-heading">Up next</p>
      ${v.related.map(r => videoCard(r, true)).join('')}` : '';

    if (v.title) document.title = `${v.title} – FreeView`;

  } catch (e) {
    const meta = document.getElementById('watch-meta');
    if (meta) meta.innerHTML = '';
  }
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
