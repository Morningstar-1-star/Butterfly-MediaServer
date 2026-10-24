import axios from "axios";
import { createCache, withTimeout } from "./cache.js";
import { addonList, fetchAddonStreams } from "./addons.js";

// One call for the app:
//   /unified?tmdbId=27205&type=movie&title=Inception[&imdbId=tt1375666][&vega=hdhub4u,drive]
//   /unified?tmdbId=1399&type=tv&season=1&episode=2&title=Game%20of%20Thrones
// Runs Nuvio + (optional) Vega + (optional) Stremio addons in parallel, merges,
// ranks by quality and caches 10 min. It reuses the existing routes via loopback,
// so no provider logic is duplicated.
const cache = createCache({ ttlMs: 10 * 60 * 1000, max: 300 });

const qNum = q => { const m = String(q || "").match(/(\d{3,4})\s*p?/); return m ? parseInt(m[1], 10) : /4k|uhd/i.test(q) ? 2160 : 0; };

export function registerUnified(app, { port }) {
  const self = axios.create({ baseURL: `http://127.0.0.1:${port}`, timeout: 60000, validateStatus: () => true,
    headers: process.env.APP_KEY ? { "x-app-key": process.env.APP_KEY } : {} });

  app.get("/unified", async (req, res) => {
    const tmdbId = String(req.query.tmdbId || "").trim();
    const type = String(req.query.type || "movie").toLowerCase();
    const isTv = ["tv", "show", "series"].includes(type);
    const season = parseInt(req.query.season, 10) || 1;
    const episode = parseInt(req.query.episode, 10) || 1;
    const title = String(req.query.title || "").trim();
    const imdbId = String(req.query.imdbId || "").trim();
    const vegaList = String(req.query.vega || process.env.UNIFIED_VEGA || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 4);

    if (!tmdbId && !(title && vegaList.length)) {
      return res.status(400).json({ success: false, error: "Need tmdbId (Nuvio) and/or title + vega providers" });
    }

    const key = JSON.stringify([tmdbId, isTv, season, episode, title, imdbId, vegaList]);
    const hit = cache.get(key);
    if (hit) return res.set("X-Cache", "HIT").json(hit);

    const tasks = [];

    if (tmdbId) {
      tasks.push(["nuvio", async () => {
        const r = await self.get("/nuvio/resolve", { params: { tmdbId, type: isTv ? "tv" : "movie", season, episode } });
        if (!r.data?.streams?.length && r.data?.error) throw new Error(r.data.error);
        return (r.data?.streams || []).map(s => ({ ...s, source: "nuvio" }));
      }]);
    }

    for (const p of vegaList) {
      tasks.push(["vega:" + p, async () => {
        const s = await self.get(`/search/${encodeURIComponent(p)}`, { params: { q: title } });
        if (s.data?.error) throw new Error(s.data.error);
        const first = s.data?.results?.[0];
        if (!first?.link) return [];
        const r = await self.get(`/resolve/${encodeURIComponent(p)}`, { params: { link: first.link, type: isTv ? "series" : "movie", episodeIndex: Math.max(episode - 1, 0) } });
        return (r.data?.streams || []).map(x => ({
          server: x.server || p, link: x.link || x.url, headers: x.headers || {}, quality: r.data?.quality || x.quality || "",
          type: x.type || (/\.m3u8/i.test(x.link || x.url || "") ? "m3u8" : "mp4"), provider: p, source: "vega"
        })).filter(x => x.link);
      }]);
    }

    if (imdbId && addonList().length) {
      tasks.push(["addons", async () => {
        const id = isTv ? `${imdbId}:${season}:${episode}` : imdbId;
        return (await fetchAddonStreams({ type: isTv ? "series" : "movie", id })).map(s => ({ ...s, source: "addon" }));
      }]);
    }

    const settled = await Promise.allSettled(tasks.map(([, fn]) => withTimeout(fn(), 55000, "timeout")));
    const report = [];
    const streams = [];
    settled.forEach((r, i) => {
      const name = tasks[i][0];
      if (r.status === "fulfilled") { report.push({ source: name, streams: r.value.length }); streams.push(...r.value); }
      else report.push({ source: name, error: r.reason?.message || String(r.reason) });
    });

    // de-dupe by URL, rank: higher quality first, direct mp4/m3u8 before mkv
    const seen = new Set();
    const ranked = streams
      .filter(s => s.link && !seen.has(s.link) && seen.add(s.link))
      .sort((a, b) => (qNum(b.quality) - qNum(a.quality)) || ((b.type === "m3u8") - (a.type === "m3u8")));

    const body = { success: ranked.length > 0, count: ranked.length, streams: ranked, sources: report };
    if (ranked.length) cache.set(key, body);
    res.status(ranked.length ? 200 : 502).json(body);
  });
}
