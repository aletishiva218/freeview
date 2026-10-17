// ─── Utilities ───────────────────────────────────────────────────────────────
const app = document.getElementById('app');
const searchInput = document.getElementById('search-input');

// Both iOS and Android need <audio> (not <video>) for background playback.
// iOS Safari always pauses <video> in background; Android Chrome is unreliable
// for background <video> even with Media Session. <audio> stays alive on both.
const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Holds the background <audio> element created inside a click handler.
// Both iOS and Android require audio.play() to be called within a user-gesture
// event. hashchange is NOT a user gesture, so we create the element in the
// click capture handler and carry it forward into watchView.
let _pendingBgAudio = null;

if (IS_MOBILE) {
  document.addEventListener('click', e => {
    const link = e.target.closest('a[href*="#watch?v="]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    const qi   = href.indexOf('?');
    if (qi === -1) return;
    const videoId = new URLSearchParams(href.slice(qi)).get('v');
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;

    // Discard any leftover audio from a previous navigation
    if (_pendingBgAudio) {
      _pendingBgAudio.pause();
      _pendingBgAudio.src = '';
      try { _pendingBgAudio.remove(); } catch {}
    }

    const a = document.createElement('audio');
    a.src           = `/api/stream/audio/${encodeURIComponent(videoId)}`;
    a.muted         = true;   // muted is always allowed; we unmute in setupMobileAudio
    a.preload       = 'auto';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.play().catch(() => {}); // start within user-gesture call stack
    _pendingBgAudio = a;
  }, true); // capture phase — runs before the hashchange routing
}

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

// ─── Media Session (background audio on mobile) ───────────────────────────────
function setupMediaSession(videoId, v, player) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title:  v.title   || 'FreeView',
    artist: v.channel || '',
    artwork: [
      { src: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, sizes: '320x180', type: 'image/jpeg' },
      { src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' },
      { src: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, sizes: '1280x720', type: 'image/jpeg' },
    ],
  });

  // Set 'playing' immediately — don't wait for the play event.
  // Chrome on Android checks this state when the page goes to background;
  // if it's still 'none' the OS treats the session as inactive and suspends it.
  navigator.mediaSession.playbackState = 'playing';

  navigator.mediaSession.setActionHandler('play',  () => { player.play(); navigator.mediaSession.playbackState = 'playing'; });
  navigator.mediaSession.setActionHandler('pause', () => { player.pause(); navigator.mediaSession.playbackState = 'paused'; });
  navigator.mediaSession.setActionHandler('seekbackward', d => {
    player.currentTime = Math.max(0, player.currentTime - (d.seekOffset || 10));
  });
  navigator.mediaSession.setActionHandler('seekforward', d => {
    player.currentTime = Math.min(player.duration || Infinity, player.currentTime + (d.seekOffset || 10));
  });
  try {
    navigator.mediaSession.setActionHandler('seekto', d => {
      if (d.fastSeek && 'fastSeek' in player) player.fastSeek(d.seekTime);
      else player.currentTime = d.seekTime;
    });
  } catch { /* seekto not supported in all browsers */ }

  player.addEventListener('play',  () => { navigator.mediaSession.playbackState = 'playing'; });
  player.addEventListener('pause', () => { navigator.mediaSession.playbackState = 'paused'; });
  player.addEventListener('ended', () => { navigator.mediaSession.playbackState = 'none'; });

  function updatePosition() {
    if (!player.duration || isNaN(player.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration:     player.duration,
        playbackRate: player.playbackRate,
        position:     player.currentTime,
      });
    } catch { /* setPositionState not supported in all browsers */ }
  }
  player.addEventListener('loadedmetadata', updatePosition);
  player.addEventListener('timeupdate', updatePosition);
}

// ─── Mobile background audio ──────────────────────────────────────────────────
// iOS and Android both pause <video> in background but keep <audio> alive.
// Strategy: muted <video> for visuals + hidden <audio> for sound.
function setupMobileAudio(videoId, v, video, bgAudio) {
  if (!bgAudio) return;

  // Audio was started (muted) from the click handler; unmute it now.
  bgAudio.muted = false;
  // Sync to where the video is starting (both begin at 0 normally).
  bgAudio.currentTime = video.currentTime;

  // Mirror video controls → audio element
  video.addEventListener('play',       () => bgAudio.play().catch(() => {}));
  video.addEventListener('pause',      () => bgAudio.pause());
  video.addEventListener('seeked',     () => { bgAudio.currentTime = video.currentTime; });
  video.addEventListener('ratechange', () => { bgAudio.playbackRate = video.playbackRate; });

  // Track whether the video was playing when the user left — so we don't
  // resume a video the user intentionally paused before pressing home.
  let wasPlayingBeforeHide = false;
  const onVisibility = () => {
    if (document.hidden) {
      wasPlayingBeforeHide = !video.paused;
    } else if (wasPlayingBeforeHide) {
      // Audio kept playing in background; sync video back to it and resume.
      video.currentTime = bgAudio.currentTime;
      video.play().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Clean up when navigating away
  window.addEventListener('hashchange', () => {
    bgAudio.pause();
    bgAudio.src = '';
    document.removeEventListener('visibilitychange', onVisibility);
  }, { once: true });

  // Register the <audio> (not the muted <video>) with the OS for lock-screen controls
  setupMediaSession(videoId, v, bgAudio);
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
  app.innerHTML = spinner();

  // Consume the audio element pre-created in the click handler.
  // If null (direct URL / programmatic navigation) fall back to normal
  // unmuted <video> — background audio won't work but at least sound plays.
  let bgAudio = null;
  if (IS_MOBILE) {
    bgAudio = _pendingBgAudio;
    _pendingBgAudio = null;
  }

  try {
    const v = await api.video(videoId);

    const playerHtml = v.streamable
      ? `<video
           id="player"
           src="/api/stream/${esc(videoId)}"
           controls autoplay preload="auto"
           playsinline${bgAudio ? ' muted' : ''}
           class="player"
         ></video>`
      : `<iframe
           id="player"
           src="https://www.youtube-nocookie.com/embed/${esc(videoId)}?autoplay=1&rel=0&modestbranding=1"
           allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
           allowfullscreen
           class="player"
         ></iframe>`;

    app.innerHTML = `
      <div class="watch-layout">
        <div class="watch-main">
          <div class="player-wrap${v.isShort ? ' player-wrap--short' : ''}">${playerHtml}</div>
          <div class="watch-meta">
            <h1 class="watch-title">${esc(v.title)}</h1>
            <p class="watch-channel">${esc(v.channel)}</p>
            <p class="watch-stats">${esc([v.views, v.duration].filter(Boolean).join(' · '))}</p>
            ${v.streamable ? `
              <div class="watch-actions">
                <a href="/api/download/video/${esc(videoId)}" download="video-${esc(videoId)}.mp4" class="btn-dl btn-dl--video">&#11123; Download Video</a>
                <a href="/api/download/audio/${esc(videoId)}" download="audio-${esc(videoId)}.webm" class="btn-dl btn-dl--audio">&#11123; Download Audio</a>
              </div>` : ''}
            ${v.description ? `
              <details class="watch-desc">
                <summary>Description</summary>
                <pre>${esc(v.description)}</pre>
              </details>` : ''}
          </div>
        </div>
        <aside class="watch-related">
          <p class="watch-related-heading">Up next</p>
          ${v.related.length ? v.related.map(r => videoCard(r, true)).join('') : ''}
        </aside>
      </div>`;

    if (v.streamable) {
      const player = document.getElementById('player');
      if (player) {
        player.addEventListener('error', () => {
          if (player.readyState === 0) {
            player.parentElement.innerHTML = msg(
              'Playback failed',
              'This video may be unavailable or age-restricted.',
              true
            );
          }
        });

        if (bgAudio) {
          // Mobile: audio element carries the sound and stays alive in background.
          // Video is muted (visuals only); hardware volume buttons control audio.
          setupMobileAudio(videoId, v, player, bgAudio);
        } else {
          // Android / desktop: single <video> with Media Session for OS controls.
          if (bgAudio) { bgAudio.pause(); bgAudio.src = ''; } // shouldn't happen, safety
          setupMediaSession(videoId, v, player);
        }
      }
    } else if (bgAudio) {
      // Video fell back to iframe — audio element not needed
      bgAudio.pause();
      bgAudio.src = '';
    }

    if (v.title) document.title = `${v.title} – FreeView`;

  } catch (e) {
    if (bgAudio) { bgAudio.pause(); bgAudio.src = ''; }
    app.innerHTML = msg('Could not load video', e.message, true);
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
