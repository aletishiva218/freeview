import cluster from 'cluster';
import { cpus } from 'os';
import express from 'express';
import compression from 'compression';
import { Innertube, Platform, YT } from 'youtubei.js';
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

  function fmtVideoInfo(info, fallbackId = '') {
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
        ? Number(b.view_count).toLocaleString() + ' views'
        : pi.view_count?.original_view_count
          ? Number(pi.view_count.original_view_count).toLocaleString() + ' views'
          : pi.view_count?.short_view_count?.text || '';

    const description =
      b.short_description
      || si.description?.text
      || '';

    const durSec  = b.duration || 0;
    const isShort = durSec > 0 && durSec <= 60;

    return {
      id: b.id || fallbackId,
      title,
      channel,
      channelId,
      views,
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

  function is403(e) {
    return e?.message?.includes('403') || e?.message?.includes('status code');
  }

  // Builds a VideoInfo from the /next response alone (empty player response).
  // primary_info, secondary_info and watch_next_feed are all populated from /next.
  async function getInfoFromNext(yt, id) {
    const next = await yt.actions.execute('/next', {
      videoId: id, racyCheckOk: true, contentCheckOk: true,
    });
    return new YT.VideoInfo([{ data: {} }, next], yt.actions, '');
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
    const q    = String(req.query.q || '').trim();
    const page = Math.max(1, Math.min(10, parseInt(req.query.page) || 1));
    if (!q) return res.json({ videos: [], hasMore: false });
    try {
      const data = await withCache(`s:${q}:${page}`, 5 * 60_000, async () => {
        const yt = await getYT();
        const sr = await getSearchPage(yt, q, page, `cont:s:${q}`);
        if (!sr) return { videos: [], hasMore: false };
        return {
          videos: (sr.results || []).flatMap(extractVideos).slice(0, 40),
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
      const info = await withCache(`v:${id}`, 60 * 60_000, async () => {
        const yt = await getYT();
        try {
          return fmtVideoInfo(await withTimeout(yt.getInfo(id), 15_000, `getInfo:${id}`));
        } catch (e) {
          if (!is403(e)) throw e;
          // YouTube blocks the /player endpoint from datacenter IPs (Render) with
          // 403 regardless of session. Playback uses the embed iframe, so we only
          // need metadata — fetch it from /next, which is not blocked.
          console.warn(wid, `[/api/video] /player rejected for ${id}, using /next only`);
          return fmtVideoInfo(await withTimeout(getInfoFromNext(yt, id), 15_000, `next:${id}`), id);
        }
      });
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
