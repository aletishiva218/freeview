import cluster from 'cluster';
import { cpus } from 'os';
import express from 'express';
import compression from 'compression';
import { Innertube, Platform } from 'youtubei.js';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import path from 'path';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = Number(process.env.PORT) || 3000;
// WEB_CONCURRENCY lets you scale up on paid/high-RAM hosts.
// Default 1 — Innertube uses ~150 MB per worker; free-tier hosts (512 MB) can't fit more than one.
const N_WORKERS = Number(process.env.WEB_CONCURRENCY) || 1;

// Stamp changes on every server restart so browsers always fetch fresh CSS/JS.
const ASSET_VER = Date.now();

// ─── Cluster primary ─────────────────────────────────────────────────────────
if (cluster.isPrimary) {
  console.log(`\n  FreeView — spawning ${N_WORKERS} workers on port ${PORT}…`);

  for (let i = 0; i < N_WORKERS; i++) cluster.fork();

  // Open browser once, after the first worker signals ready
  let opened = false;
  cluster.on('message', (worker, msg) => {
    if (msg === 'ready' && !opened) {
      opened = true;
      const url = `http://localhost:${PORT}`;
      console.log(`\n  Ready → ${url}  (${N_WORKERS} workers)\n  Press Ctrl+C to stop.\n`);
      if (process.platform === 'win32') exec(`start ${url}`);
    }
  });

  // Auto-restart crashed workers
  cluster.on('exit', (worker, code) => {
    if (code !== 0) {
      console.error(`  Worker ${worker.process.pid} exited (code ${code}) — restarting…`);
      cluster.fork();
    }
  });

  // Graceful shutdown: tell all workers to stop, then exit
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log('\n  Shutting down…');
      for (const w of Object.values(cluster.workers)) w.send('shutdown');
      setTimeout(() => process.exit(0), 5000);
    });
  }

  process.exitCode = 0;

} else {
  // ─── Worker ────────────────────────────────────────────────────────────────
  workerMain();
}

async function workerMain() {
  const wid = `[w${process.pid}]`;

  // ─── JS evaluator ─────────────────────────────────────────────────────────
  // YouTube's player JS uses URL, encodeURIComponent etc — run in global scope.
  function installEvaluator() {
    const shim = Platform.shim;
    Platform.load({
      ...shim,
      // eslint-disable-next-line no-new-func
      eval: (data) => (new Function(data.output))(),
    });
  }

  // ─── Innertube singleton ──────────────────────────────────────────────────
  // generate_session_locally: false — fetches a real visitor token from YouTube
  // on first use. Locally-generated tokens are rejected with 403 from datacenter
  // IPs (Render). A real session fetched from YouTube works from any IP.
  let _yt = null;
  let _ytPromise = null;

  function getYT() {
    if (_yt) return Promise.resolve(_yt);
    if (_ytPromise) return _ytPromise;
    _ytPromise = (async () => {
      installEvaluator();
      const yt = await Innertube.create({ generate_session_locally: false });
      _yt = yt;
      return yt;
    })().catch(err => { _ytPromise = null; throw err; });
    return _ytPromise;
  }

  // Reset the session so the next call to getYT() creates a fresh one.
  // Called when YouTube returns 403 (expired / invalid session).
  function resetYT() { _yt = null; _ytPromise = null; }

  // ─── Single-flight + TTL cache ────────────────────────────────────────────
  // Single-flight: if two requests miss the cache simultaneously, only ONE
  // hits the YouTube API — all others wait for that same promise to resolve.
  const _cache    = new Map(); // key → { val, exp }
  const _inflight = new Map(); // key → Promise

  async function withCache(key, ttlMs, fn) {
    const hit = _cache.get(key);
    if (hit && Date.now() < hit.exp) return hit.val;

    if (_inflight.has(key)) return _inflight.get(key);

    const p = fn()
      .then(val => {
        _cache.set(key, { val, exp: Date.now() + ttlMs });
        _inflight.delete(key);
        // Evict oldest entry when over 1 000 to keep memory bounded
        if (_cache.size > 1000) {
          let oldestKey = null, oldestExp = Infinity;
          for (const [k, v] of _cache) {
            if (v.exp < oldestExp) { oldestExp = v.exp; oldestKey = k; }
          }
          if (oldestKey) _cache.delete(oldestKey);
        }
        return val;
      })
      .catch(err => {
        _inflight.delete(key);
        throw err;
      });

    _inflight.set(key, p);
    return p;
  }

  // ─── Continuation cache (raw ytjs objects for page 2+) ────────────────────
  // Keys: `cont:home:<page>` or `cont:s:<query>:<page>`
  // 30-min TTL — YouTube continuation tokens expire after ~1 hour.
  // Each worker holds its own copy; a cross-worker miss causes a re-fetch
  // from page 1 which is fast because the processed result is already in _cache.
  const _contCache = new Map();

  // ─── Timeout helper ──────────────────────────────────────────────────────
  // Races a promise against a deadline. Prevents a slow/hung YouTube API
  // call from holding an open HTTP connection forever.
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`${label} timed out (${ms}ms)`)), ms)
      ),
    ]);
  }

  // ─── Formatters ──────────────────────────────────────────────────────────
  function formatDuration(seconds) {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${m}:${String(s).padStart(2,'0')}`;
  }

  function fmtVideo(v) {
    if (!v) return null;

    // LockupView — YouTube's newer container format (watch_next_feed)
    if (v.type === 'LockupView') {
      const id = v.content_id;
      if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
      const title   = v.metadata?.title?.text || 'Untitled';
      const rows    = v.metadata?.metadata?.metadata_rows || [];
      const channel = rows[0]?.metadata_parts?.[0]?.text?.text || '';
      const row1    = (rows[1]?.metadata_parts || []).map(p => p.text?.text || '').filter(Boolean);
      return {
        id, title, channel, channelId: '',
        thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        views: row1[0] || '', published: row1[1] || '', duration: '',
      };
    }

    // ShortsLockupView — individual Short inside a GridShelfView Shorts shelf
    if (v.type === 'ShortsLockupView') {
      // Video ID comes from the tap endpoint; entity_id is "shorts-shelf-item-<id>"
      const id = v.on_tap_endpoint?.payload?.videoId
        || String(v.entity_id || '').split('-').slice(-1)[0];
      if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
      const title = v.overlay_metadata?.primary_text?.text || 'Short';
      const views = v.overlay_metadata?.secondary_text?.text || '';
      // Use the Short's native thumbnail from the endpoint (9:16 frame)
      const thumbs = v.on_tap_endpoint?.payload?.thumbnail?.thumbnails || [];
      const thumbnail = thumbs[0]?.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
      return {
        id, title, channel: '', channelId: '',
        thumbnail, views, published: '', duration: '', isShort: true,
      };
    }

    const id = v.id;
    if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;

    const title =
      (typeof v.title === 'string' ? v.title : null) ||
      v.title?.text || v.title?.runs?.[0]?.text || 'Untitled';

    const channel =
      v.author?.name || v.short_byline_text?.runs?.[0]?.text || '';

    const channelId =
      v.author?.id ||
      v.short_byline_text?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '';

    // Detect a regular Video that is actually a Short (≤60 s duration)
    const durSec  = v.duration?.seconds || 0;
    const durText = v.duration?.text || formatDuration(durSec);
    const isShort = durSec > 0 && durSec <= 60;

    return {
      id, title, channel, channelId,
      thumbnail:  `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      views:      v.view_count?.text || v.short_view_count?.text || '',
      published:  v.published?.text || '',
      duration:   durText,
      ...(isShort && { isShort: true }),
    };
  }

  // Flattens any item type into 0–N video objects.
  // GridShelfView is a Shorts shelf — it contains multiple ShortsLockupView items.
  function extractVideos(item) {
    if (!item) return [];
    if (item.type === 'GridShelfView') {
      return (item.contents || []).flatMap(extractVideos);
    }
    // ReelShelf is another Shorts container used in some contexts
    if (item.type === 'ReelShelf') {
      return (item.items || item.contents || []).flatMap(extractVideos);
    }
    const v = fmtVideo(item);
    return v ? [v] : [];
  }

  function fmtVideoInfo(info) {
    const b  = info.basic_info  || {};
    const pi = info.primary_info   || {};
    const si = info.secondary_info || {};

    const related = [];
    try {
      for (const item of (info.watch_next_feed || [])) {
        const v = fmtVideo(item);
        if (v) related.push(v);
        if (related.length >= 20) break;
      }
    } catch { /* optional */ }

    // basic_info is empty on datacenter IPs (YouTube bot-detection).
    // primary_info and secondary_info are still populated in that case.
    const title =
      b.title
      || pi.title?.runs?.[0]?.text
      || pi.title?.text
      || '';

    const channel =
      b.author
      || si.owner?.author?.name
      || si.owner?.title?.text
      || '';

    const channelId =
      b.channel_id
      || si.owner?.author?.id
      || '';

    const views =
      b.view_count
        ? Number(b.view_count).toLocaleString('en-US') + ' views'
        : pi.view_count?.original_view_count
          ? Number(pi.view_count.original_view_count).toLocaleString('en-US') + ' views'
          : pi.view_count?.short_view_count?.text || '';

    const description =
      b.short_description
      || si.description?.text
      || '';

    const durSec  = b.duration || 0;
    const isShort = durSec > 0 && durSec <= 60;

    return {
      id: b.id || '',
      title,
      channel,
      channelId,
      views,
      published: pi.relative_date?.text || pi.published?.text || '',
      description,
      duration: formatDuration(durSec),
      isShort,
      related,
    };
  }

  function extractHomeFeedVideos(feed) {
    const videos = [];
    for (const section of (feed.contents?.contents || [])) {
      const container = section.content || section;
      for (const item of (container.contents || container.items || container.videos || [])) {
        const v = fmtVideo(item.content || item);
        if (v) videos.push(v);
      }
    }
    return videos;
  }

  // ─── Pagination helper ────────────────────────────────────────────────────
  // Fetch (or chain to) the Nth page of a YouTube search, caching each
  // continuation object for the next request. Cross-worker cache miss →
  // re-fetches from page 1 (correct but ~500 ms slower on that one request).
  // searchOpts: passed to yt.search() — home feed uses { type: 'video' } to
  // exclude Shorts shelves; user search passes {} to include all types.
  async function getSearchPage(yt, query, page, prefix, searchOpts = {}) {
    if (page === 1) {
      const sr = await withTimeout(yt.search(query, searchOpts), 15_000, `${prefix}-p1`);
      _contCache.set(`${prefix}:1`, { obj: sr, exp: Date.now() + 30 * 60_000 });
      return sr;
    }

    const prev = _contCache.get(`${prefix}:${page - 1}`);
    if (prev && Date.now() < prev.exp && prev.obj.has_continuation) {
      const cont = await withTimeout(prev.obj.getContinuation(), 15_000, `${prefix}-cont-${page}`);
      _contCache.set(`${prefix}:${page}`, { obj: cont, exp: Date.now() + 30 * 60_000 });
      return cont;
    }

    // Cache miss (different worker served page N-1) — rebuild chain from p1
    let cur = await withTimeout(yt.search(query, searchOpts), 15_000, `${prefix}-refetch`);
    _contCache.set(`${prefix}:1`, { obj: cur, exp: Date.now() + 30 * 60_000 });
    for (let p = 2; p <= page; p++) {
      if (!cur.has_continuation) return null;
      cur = await withTimeout(cur.getContinuation(), 15_000, `${prefix}-chain-${p}`);
      _contCache.set(`${prefix}:${p}`, { obj: cur, exp: Date.now() + 30 * 60_000 });
    }
    return cur;
  }

  // Fallback for when the per-video Innertube endpoints are blocked:
  // oEmbed (public, not IP-blocked) gives title + channel; a search for the
  // title (search is not blocked) gives views/duration/description snippet
  // from the matching result and a list of related videos.
  async function getInfoFromOEmbed(yt, id, timing) {
    let t = Date.now();
    const r = await withTimeout(fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`),
      8_000, `oembed:${id}`);
    if (!r.ok) throw new Error(`oEmbed failed with status code ${r.status}`);
    const o = await r.json();
    timing.oembed = Date.now() - t;

    let self = null, raw = null, related = [];
    t = Date.now();
    try {
      const sr = await withTimeout(yt.search(o.title), 10_000, `search:${id}`);
      raw  = (sr.results || []).find(n => n.id === id || n.video_id === id) || null;
      const vids = (sr.results || []).flatMap(extractVideos);
      self = vids.find(v => v.id === id) || null;
      related = vids.filter(v => v.id !== id).slice(0, 20);
    } catch (e) {
      console.warn(wid, `[/api/video] related search failed for ${id}: ${e.message}`);
    }
    timing.search = Date.now() - t;

    const description =
      raw?.description_snippet?.text
      || raw?.snippets?.map(sn => sn.text?.text || '').filter(Boolean).join('\n')
      || '';

    return {
      id,
      title:       o.title || '',
      channel:     o.author_name || '',
      channelId:   self?.channelId || '',
      views:       self?.views || '',
      published:   self?.published || '',
      description,
      duration:    self?.duration || '',
      isShort:     !!self?.isShort,
      related,
    };
  }

  // Circuit breaker for getInfo. On datacenter IPs (Render) YouTube either
  // 403s or stalls the per-video endpoints (/player, /next) until timeout, so
  // after one failure we skip getInfo for a while and go straight to oEmbed.
  const BLOCK_MS = 30 * 60_000;
  let infoBlockedUntil = 0;

  // ─── Category feeds ───────────────────────────────────────────────────────
  // YouTube has no keyless "videos in category X" feed that works from Render,
  // so each category maps to search queries (search is not IP-blocked).
  // Results are cached per query+page and shared by every user, so the
  // YouTube load is independent of how many users pick which categories.
  //
  // Each category has FEED_VARIANTS queries so "Refresh" can show different
  // videos from the same categories while the cache stays in place.
  const FEED_VARIANTS = 4;
  const CATEGORY_QUERIES = {
    film:          ['official movie trailer', 'new movie teaser', 'animated short film', 'short film'],
    autos:         ['car review', 'bike review', 'supercar', 'car modification'],
    music:         ['new music video', 'top songs this week', 'live performance song', 'official audio song'],
    pets:          ['funny pets animals', 'cute dogs', 'funny cats', 'wildlife animals documentary'],
    sports:        ['sports highlights', 'cricket highlights', 'basketball highlights', 'tennis highlights'],
    travel:        ['travel vlog', 'travel guide', 'road trip vlog', 'beautiful places to visit'],
    gaming:        ['gaming', 'minecraft', 'gta gameplay', 'game review'],
    people:        ['daily vlog', 'day in my life', 'family vlog', 'storytime'],
    comedy:        ['comedy sketch', 'stand up comedy', 'funny videos', 'comedy skit'],
    entertainment: ['entertainment show', 'celebrity interview', 'reality show', 'late night talk show'],
    news:          ['news today', 'breaking news', 'world news', 'politics news'],
    howto:         ['how to diy tutorial', 'makeup tutorial', 'cooking recipe', 'life hacks'],
    education:     ['educational explained', 'history documentary', 'math explained', 'english lesson'],
    science:       ['science technology', 'tech review', 'space science', 'science experiment'],
    nonprofits:    ['nonprofit charity activism', 'social cause documentary', 'climate activism', 'volunteering charity'],
  };
  // Used for the general feed after a refresh (refresh 0 keeps the original feed).
  const TRENDING_QUERIES = ['trending videos', 'viral videos', 'popular videos today', 'most watched videos this week'];

  // Refresh cycle: refreshes 0–3 use each query variant from page 1, 4–7 start
  // one page deeper, and so on for 20 refreshes before the cycle repeats.
  // Cached results expire after 10 min, so later cycles show new videos anyway.
  const REFRESH_CYCLE = FEED_VARIANTS * 5;
  function feedPlan(page, refresh) {
    const r = ((refresh % REFRESH_CYCLE) + REFRESH_CYCLE) % REFRESH_CYCLE;
    return { variant: r % FEED_VARIANTS, page: page + Math.floor(r / FEED_VARIANTS) };
  }

  function parseCategories(raw) {
    const ids = String(raw || '').split(',').map(c => c.trim()).filter(c => CATEGORY_QUERIES[c]);
    return [...new Set(ids)].sort();
  }

  // kind: 'video' (regular landscape videos) or 'shorts' (YouTube Shorts).
  function getQueryPage(query, page, kind = 'video') {
    return withCache(`q:${kind}:${query}:${page}`, 10 * 60_000, async () => {
      const yt = await getYT();
      const sr = await getSearchPage(yt, query, page, `cont:q:${kind}:${query}`, { type: kind });
      if (!sr) return { videos: [], hasMore: false };
      // Video search returns Video nodes (no Shorts); Shorts search returns
      // GridShelfView shelves of ShortsLockupView items.
      const videos = kind === 'shorts'
        ? (sr.results || []).flatMap(extractVideos).filter(v => v.isShort)
        : (sr.videos || []).map(fmtVideo).filter(v => v && !v.isShort);
      return { videos, hasMore: sr.has_continuation || false };
    });
  }

  // Deterministic shuffle so a given refresh always produces the same order
  // (keeps browser-side caching and pagination consistent).
  function seededShuffle(arr, seed) {
    let x = (seed * 2654435761) >>> 0 || 1;
    const rand = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  const FEED_FORMATS = new Set(['all', 'videos', 'shorts']);
  // How many items of each kind one feed page aims for, per format.
  const FEED_SIZES = {
    all:    { video: 36, shorts: 12 },
    videos: { video: 48, shorts: 0 },
    shorts: { video: 0,  shorts: 40 },
  };

  // Mixes one page from each query round-robin, so every category is
  // represented near the top. A failing query is skipped; returns null only
  // when every query failed.
  async function mixQueries(queries, page, kind, total, seed) {
    const results = await Promise.allSettled(queries.map(q => getQueryPage(q, page, kind)));
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!ok.length) return { error: results.find(r => r.status === 'rejected').reason };

    const perQuery = Math.max(kind === 'shorts' ? 4 : 8, Math.ceil(total / queries.length));
    const lists = ok.map(r => r.videos.slice(0, perQuery));
    if (seed) lists.forEach((l, i) => seededShuffle(l, seed + i));
    const videos = [];
    for (let i = 0; lists.some(l => i < l.length); i++) {
      for (const l of lists) if (l[i]) videos.push(l[i]);
    }
    return { videos, hasMore: ok.some(r => r.hasMore) };
  }

  // Home feed for the chosen categories (or general trending when none),
  // format ('all' | 'videos' | 'shorts') and refresh position.
  async function buildFeed(cats, page, refresh, format) {
    const plan    = feedPlan(page, refresh);
    const queries = cats.length
      ? cats.map(c => CATEGORY_QUERIES[c][plan.variant])
      : [TRENDING_QUERIES[plan.variant]];
    const sizes = FEED_SIZES[format];
    const seed  = refresh > 0 ? refresh * 31 + page * 7 : 0;

    const [vid, sh] = await Promise.all([
      sizes.video  ? mixQueries(queries, plan.page, 'video',  sizes.video,  seed)     : null,
      sizes.shorts ? mixQueries(queries, plan.page, 'shorts', sizes.shorts, seed + 1) : null,
    ]);
    const parts = [vid, sh].filter(Boolean);
    if (parts.every(p => p.error)) throw parts[0].error;

    // 'all': one Short after every 3 videos, then whatever is left over.
    const v = vid?.videos || [], s = sh?.videos || [];
    const mixed = [];
    for (let i = 0, j = 0; i < v.length || j < s.length;) {
      for (let k = 0; k < 3 && i < v.length; k++) mixed.push(v[i++]);
      if (j < s.length) mixed.push(s[j++]);
    }

    const seen = new Set();
    const videos = mixed.filter(x => !seen.has(x.id) && seen.add(x.id));
    return { videos, hasMore: parts.some(p => p.hasMore) };
  }

  // ─── Express ──────────────────────────────────────────────────────────────
  const app = express();

  // Read index.html once at worker startup; inject asset version at serve time.
  const indexRaw = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

  // Gzip all JSON/HTML/JS/CSS responses — cuts typical API payload by 60–70 %
  app.use(compression());

  // Redirect old asset URLs that browsers may have cached in old index.html snapshots.
  // Query strings (?v=2 etc.) are irrelevant to routing — these catch all variants.
  app.get('/style.css', (_, res) => res.redirect(301, '/main.css'));
  app.get('/app.js',    (_, res) => res.redirect(301, '/main.js'));

  // Serve static assets — no caching on CSS/JS so browsers always fetch the latest.
  app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));

  // Health check — useful for load-balancers and uptime monitors
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      worker: process.pid,
      uptime: Math.floor(process.uptime()),
      cache:  { entries: _cache.size, inflight: _inflight.size },
    });
  });

  // Home feed (10-min cache per page, single-flight)
  app.get('/api/home', async (req, res) => {
    const page = Math.max(1, Math.min(10, parseInt(req.query.page) || 1));
    const cats    = parseCategories(req.query.cats);
    const refresh = Math.max(0, Math.min(1000, parseInt(req.query.r) || 0));
    const format  = FEED_FORMATS.has(req.query.format) ? req.query.format : 'all';
    try {
      return res.json(await buildFeed(cats, page, refresh, format));
    } catch (e) {
      console.error(wid, '[/api/home feed]', e.message);
      if (format === 'shorts') return res.status(500).json({ error: e.message });
      // Fall back to the original trending feed (regular videos) below.
    }
    try {
      // Page 1: short TTL so home always shows fresh videos on revisit.
      // Pages 2+: longer TTL so the continuation chain stays valid.
      const ttl = page === 1 ? 90_000 : 10 * 60_000;
      const data = await withCache(`home:${page}`, ttl, async () => {
        const yt = await getYT();

        // Page 1: try getHomeFeed first (works when authenticated)
        if (page === 1) {
          let list = [];
          try {
            const feed = await withTimeout(yt.getHomeFeed(), 15_000, 'getHomeFeed');
            list = extractHomeFeedVideos(feed);
          } catch { /* non-fatal */ }

          if (list.length >= 8) {
            return { videos: list.slice(0, 40), hasMore: true };
          }
        }

        // Search fallback — { type: 'video' } keeps the home feed as regular
        // videos only (no Shorts). Shorts are accessible via user search.
        const sr = await getSearchPage(yt, 'trending videos', page, 'cont:home', { type: 'video' });
        if (!sr) return { videos: [], hasMore: false };
        return {
          videos: (sr.videos || []).map(fmtVideo).filter(Boolean).slice(0, 40),
          hasMore: sr.has_continuation || false,
        };
      });
      res.json(data);
    } catch (e) {
      if (e.message?.includes('403') || e.message?.includes('status code')) {
        console.warn(wid, '[/api/home] session rejected, resetting…');
        resetYT();
      }
      console.error(wid, '[/api/home]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Search (5-min cache per query+page, single-flight)
  app.get('/api/search', async (req, res) => {
    const q      = String(req.query.q || '').trim();
    const page   = Math.max(1, Math.min(10, parseInt(req.query.page) || 1));
    const format = FEED_FORMATS.has(req.query.format) ? req.query.format : 'all';
    if (!q) return res.json({ videos: [], hasMore: false });
    try {
      // all: YouTube's normal mixed results (videos + Shorts shelves).
      // videos: video-only search (no Shorts). shorts: YouTube's Shorts search.
      const data = await withCache(`s:${format}:${q}:${page}`, 5 * 60_000, async () => {
        const yt   = await getYT();
        const opts = format === 'videos' ? { type: 'video' } : format === 'shorts' ? { type: 'shorts' } : {};
        const sr   = await getSearchPage(yt, q, page, `cont:s:${format}:${q}`, opts);
        if (!sr) return { videos: [], hasMore: false };
        let videos;
        if (format === 'videos')      videos = (sr.videos || []).map(fmtVideo).filter(v => v && !v.isShort);
        else if (format === 'shorts') videos = (sr.results || []).flatMap(extractVideos).filter(v => v.isShort);
        else                          videos = (sr.results || []).flatMap(extractVideos);
        const seen = new Set();
        return {
          videos: videos.filter(v => !seen.has(v.id) && seen.add(v.id)).slice(0, 40),
          hasMore: sr.has_continuation || false,
        };
      });
      res.json(data);
    } catch (e) {
      if (e.message?.includes('403') || e.message?.includes('status code')) {
        console.warn(wid, '[/api/search] session rejected, resetting…');
        resetYT();
      }
      console.error(wid, '[/api/search]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Video metadata + related (1-hour cache, single-flight)
  app.get('/api/video/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id))
      return res.status(400).json({ error: 'Invalid video ID' });
    try {
      const timing = {};
      const info = await withCache(`v:${id}`, 60 * 60_000, async () => {
        let t = Date.now();
        const yt = await getYT();
        timing.session = Date.now() - t;

        if (Date.now() < infoBlockedUntil) return getInfoFromOEmbed(yt, id, timing);

        // Start the fallback in parallel so a stalled getInfo costs at most
        // its timeout, not timeout + fallback.
        const fallback = getInfoFromOEmbed(yt, id, timing);
        fallback.catch(() => {}); // handled below if needed

        t = Date.now();
        try {
          const info = fmtVideoInfo(await withTimeout(yt.getInfo(id), 5_000, `getInfo:${id}`));
          if (info.title) return info;
        } catch (e) {
          infoBlockedUntil = Date.now() + BLOCK_MS;
          console.warn(wid, `[/api/video] getInfo failed for ${id}, using oEmbed for ${BLOCK_MS / 60_000} min: ${e.message}`);
        } finally {
          timing.getinfo = Date.now() - t;
        }
        return fallback;
      });
      res.set('Server-Timing',
        Object.entries(timing).map(([k, v]) => `${k};dur=${v}`).join(', ') || 'cache;dur=0');
      res.json(info);
    } catch (e) {
      console.error(wid, '[/api/video]', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // SPA fallback — inject asset version and never let browsers cache this response.
  // Every server restart (= every Render deploy) produces a new ASSET_VER timestamp,
  // so browsers always fetch the latest style.css and app.js after a deploy.
  app.get('*', (_, res) => {
    const html = indexRaw
      .replace('/main.css', `/main.css?v=${ASSET_VER}`)
      .replace('/main.js',  `/main.js?v=${ASSET_VER}`);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.type('html').send(html);
  });

  // ─── Start ─────────────────────────────────────────────────────────────────
  console.log(`  Worker ${process.pid} initialising Innertube…`);

  getYT()
    .then(() => {
      const server = createServer(app);

      server.listen(PORT, () => {
        console.log(`  Worker ${process.pid} ready`);
        process.send?.('ready'); // signal primary to open the browser
      });

      // Graceful shutdown on signal from primary
      process.on('message', (msg) => {
        if (msg === 'shutdown') {
          server.close(() => process.exit(0));
        }
      });

      // Handle clean Ctrl+C in single-process mode (no cluster)
      for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => server.close(() => process.exit(0)));
      }
    })
    .catch(err => {
      console.error(`  Worker ${process.pid} init failed:`, err.message);
      process.exit(1);
    });
}
