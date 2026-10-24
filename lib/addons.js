import axios from "axios";
import { createCache } from "./cache.js";
import { isSafePublicUrl } from "./security.js";

// Stremio-style addons (MediaFusion, Comet, Torrentio...). Set on Render:
//   STREMIO_ADDONS = https://your-comet/.../manifest.json,https://mediafusion/.../manifest.json
// Only addons that return direct http(s) URLs are usable in the app (no torrents).
const cache = createCache({ ttlMs: 10 * 60 * 1000, max: 300 });

export function addonList() {
  return String(process.env.STREMIO_ADDONS || "")
    .split(",").map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/\/manifest\.json.*$/i, "").replace(/\/+$/, ""))
    .filter(isSafePublicUrl);
}

export async function fetchAddonStreams({ type, id }) {
  const bases = addonList();
  const results = await Promise.allSettled(bases.map(async base => {
    const r = await axios.get(`${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`, { timeout: 20000 });
    const host = new URL(base).hostname;
    return (r.data?.streams || [])
      .filter(s => s?.url && /^https?:\/\//i.test(s.url)) // skip infoHash-only (torrent) entries
      .map(s => ({
        server: (s.name || host).replace(/\s+/g, " ").trim(),
        title: (s.title || s.description || "").split("\n")[0],
        link: s.url,
        headers: s.behaviorHints?.proxyHeaders?.request || {},
        type: /\.m3u8/i.test(s.url) ? "m3u8" : /\.mkv/i.test(s.url) ? "mkv" : "mp4",
        provider: "addon:" + host
      }));
  }));
  return results.flatMap(r => (r.status === "fulfilled" ? r.value : []));
}

export function registerAddons(app) {
  app.get("/addons/health", (req, res) => res.json({ status: "ok", configured: addonList().length }));

  // GET /addons/streams?type=movie&id=tt1375666           (movie)
  // GET /addons/streams?type=series&id=tt0944947&season=1&episode=1
  app.get("/addons/streams", async (req, res) => {
    const type = String(req.query.type || "movie").toLowerCase() === "movie" ? "movie" : "series";
    let id = String(req.query.id || "").trim();
    if (!/^tt\d{5,10}$/.test(id)) return res.status(400).json({ success: false, error: "id must be an IMDb id like tt1375666 (get it from /tmdb/movie/<id>/external_ids)" });
    if (type === "series") id += `:${parseInt(req.query.season, 10) || 1}:${parseInt(req.query.episode, 10) || 1}`;
    if (!addonList().length) return res.status(503).json({ success: false, error: "STREMIO_ADDONS is not set" });

    const key = type + id;
    const hit = cache.get(key);
    if (hit) return res.set("X-Cache", "HIT").json(hit);
    const streams = await fetchAddonStreams({ type, id });
    const body = { success: streams.length > 0, count: streams.length, streams };
    if (streams.length) cache.set(key, body);
    res.status(streams.length ? 200 : 502).json(body);
  });
}
