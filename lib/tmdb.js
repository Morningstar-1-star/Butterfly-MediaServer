import axios from "axios";
import { createCache } from "./cache.js";

// TMDB proxy: the key lives ONLY in Render env (TMDB_API_KEY).
// App calls  GET /tmdb/<tmdb path>?<same params>  e.g.
//   /tmdb/trending/movie/week
//   /tmdb/search/multi?query=inception
//   /tmdb/movie/27205?append_to_response=credits,external_ids
// Supports a v3 API key (32 hex) or a v4 read token (starts with "eyJ").
const ALLOWED = /^(trending|search|discover|movie|tv|person|genre|find|configuration|collection|watch\/providers|network|company|keyword)(\/|$)/;
const cache = createCache({ ttlMs: 30 * 60 * 1000, max: 800 });

export function registerTmdb(app) {
  const key = () => (process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN || "").trim();

  app.get("/tmdb/*path", async (req, res) => {
    const k = key();
    if (!k) return res.status(503).json({ success: false, error: "TMDB_API_KEY is not set on the server" });

    const tmdbPath = [].concat(req.params.path || []).join("/");
    if (!ALLOWED.test(tmdbPath) || tmdbPath.includes("..")) {
      return res.status(400).json({ success: false, error: "TMDB path not allowed" });
    }

    const params = { ...req.query };
    delete params.api_key; // never trust a client-supplied key
    const cacheKey = tmdbPath + "?" + new URLSearchParams(params).toString();
    const hit = cache.get(cacheKey);
    if (hit) { res.set("X-Cache", "HIT"); return res.status(hit.status).json(hit.body); }

    const isV4 = k.startsWith("eyJ");
    try {
      const r = await axios.get(`https://api.themoviedb.org/3/${tmdbPath}`, {
        params: isV4 ? params : { ...params, api_key: k },
        headers: isV4 ? { Authorization: `Bearer ${k}` } : {},
        timeout: 15000,
        validateStatus: () => true
      });
      // Trending changes fast; details are stable.
      if (r.status === 200) cache.set(cacheKey, { status: 200, body: r.data }, /^(trending|discover)/.test(tmdbPath) ? 10 * 60 * 1000 : undefined);
      res.set("X-Cache", "MISS").status(r.status).json(r.data);
    } catch (e) {
      res.status(502).json({ success: false, error: e?.message || String(e) });
    }
  });
}
