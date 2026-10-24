import express from "express";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import axios from "axios";
import * as cheerio from "cheerio";
import { accessGate } from "./lib/security.js";
import { registerExtras } from "./lib/extras.js";

const app = express();
app.disable("x-powered-by");
app.use(accessGate); // no-op unless APP_KEY is set
const PORT = process.env.PORT || 3000;
const require = createRequire(import.meta.url);

const distPath = path.resolve("./vega-providers/dist");
const memoryStore = new Map();

const commonHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

// OlaMovies blocks datacenter IPs (Render) with HTTP 403. Its requests are
// routed through your own Cloudflare Worker. Set on Render:
//   OLA_PROXY_URL = https://<your-worker>.workers.dev
//   OLA_PROXY_KEY = <the KEY from your Worker code>
// Only olamovies hosts are rewritten; every other provider is untouched.
const OLA_PROXY = (process.env.OLA_PROXY_URL || "").trim().replace(/\/+$/, "");
const OLA_KEY = (process.env.OLA_PROXY_KEY || "").trim();
const OLA_HOST = /(^|\.)olamovies\.[a-z]+$|(^|\.)ol-am\.top$/i;

if (!OLA_PROXY) {
  console.warn("[OlaMovies] OLA_PROXY_URL not set - requests go direct and will likely 403 on Render.");
} else if (!OLA_KEY) {
  console.warn("[OlaMovies] OLA_PROXY_KEY not set - the Worker will reject proxied requests.");
}

const proxiedAxios = axios.create();
proxiedAxios.interceptors.request.use((config) => {
  if (!OLA_PROXY) return config;
  try {
    const u = new URL(config.url, config.baseURL || undefined);
    if (!OLA_HOST.test(u.hostname)) return config;

    let target = u.href;
    if (config.params) {
      const extra = new URLSearchParams(config.params).toString();
      if (extra) target += (target.includes("?") ? "&" : "?") + extra;
      config.params = undefined;
    }

    config.baseURL = undefined;
    config.url = `${OLA_PROXY}/?url=${encodeURIComponent(target)}`;
    if (typeof config.headers?.set === "function") config.headers.set("x-proxy-key", OLA_KEY);
    else config.headers = { ...(config.headers || {}), "x-proxy-key": OLA_KEY };
  } catch {}
  return config;
});

const providerContext = {
  axios: proxiedAxios,
  cheerio,
  commonHeaders,

  openWebView: async () => {
    throw new Error(
      "WEBVIEW_REQUIRED: provider requires Android WebView"
    );
  },

  kvStore: {
    async get(key) {
      return memoryStore.get(key);
    },
    async set(key, value) {
      memoryStore.set(key, value);
    },
    async delete(key) {
      return memoryStore.delete(key);
    },
    async keys() {
      return [...memoryStore.keys()];
    },
    async clear() {
      memoryStore.clear();
    }
  }
};

/* ---------------------------------------------------------------- */
/* PROVIDER LOADING                                                   */
/* ---------------------------------------------------------------- */

function getProviders() {
  if (!fs.existsSync(distPath)) return [];

  return fs
    .readdirSync(distPath, { withFileTypes: true })
    .filter(x => x.isDirectory())
    .map(x => ({
      id: x.name,
      modules: fs
        .readdirSync(path.join(distPath, x.name))
        .filter(file => file.endsWith(".js"))
        .map(file => file.replace(".js", ""))
    }));
}

// App stores provider IDs lowercased ("autoembed") but Vega folders are
// case-sensitive on Linux ("autoEmbed"). Also maps app-side names to folders.
const PROVIDER_ALIASES = { w4u: "world4u" };

function resolveProviderId(id) {
  const raw = String(id || "");
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error(`Invalid provider id: ${raw}`);
  if (!fs.existsSync(distPath)) return raw;
  const dirs = fs
    .readdirSync(distPath, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  if (dirs.includes(raw)) return raw;
  const want = (PROVIDER_ALIASES[raw.toLowerCase()] || raw).toLowerCase();
  return dirs.find(d => d.toLowerCase() === want) || raw;
}

function loadModule(provider, module) {
  provider = resolveProviderId(provider);
  const file = path.resolve(distPath, provider, `${module}.js`);

  if (!fs.existsSync(file)) {
    throw new Error(`Provider/module not found: ${provider}/${module}`);
  }

  return require(file);
}

function makeTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    controller,
    stop() {
      clearTimeout(timer);
    }
  };
}

/* ---------------------------------------------------------------- */
/* RESULT SHAPE HELPERS                                               */
/* ---------------------------------------------------------------- */

function getSearchItems(search) {
  if (Array.isArray(search)) return search;
  return search?.posts || search?.results || search?.items || search?.data || [];
}

function getLink(item) {
  if (!item) return null;
  return item.link || item.url || item.href || item.post?.link || item.post?.url || item.id;
}

function getStreamItems(streams) {
  if (Array.isArray(streams)) return streams;
  return streams?.streams || streams?.links || streams?.results || streams?.data || [];
}

function getStreamUrl(item) {
  if (typeof item === "string") return item;
  return item?.link || item?.url || item?.file || item?.src || item?.source || null;
}

/**
 * A URL only counts as "playable" if it's an absolute http(s) URL AND it's
 * not just an echo of the input link we fed into getStream(). Some broken
 * extractors return the input unchanged on failure — that's not a real find.
 */
function isPlayableUrl(url, sourceLink) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (sourceLink && url.trim() === String(sourceLink).trim()) return false;
  return true;
}

/**
 * THE REAL VEGA CONTRACT (confirmed against Zenda-Cross/vega-providers source):
 *
 *   posts.getSearchPosts()  -> Post[]           { title, link, image }
 *   meta.getMeta({link})    -> Info             { ..., linkList: Link[] }
 *
 *   Link entries come in two flavors:
 *     A) { title, quality, directLinks: [{ title, link }] }
 *        -> directLinks[].link is ALREADY a real stream-source URL
 *           (HubCloud / HubDrive / GDFlix / vcloud / etc). Feed it straight
 *           into stream.getStream({ link }).
 *     B) { title, quality, episodesLink: "<url>" }
 *        -> this is a listing page, not a stream source. You must call
 *           episodes.getEpisodes({ url: episodesLink }) first, which
 *           returns EpisodeLink[] with their own `.link`. THAT is what
 *           goes into stream.getStream({ link }).
 *
 *   stream.getStream({link}) -> Stream[]         { server, link, quality, ... }
 *
 * The previous server passed the raw SEARCH RESULT link (the movie/show
 * page URL) straight into getStream(). That link is never a valid input for
 * getStream() on any provider that uses this contract (4khdhub, hdhub4u,
 * movies4u, mod, uhd, vega, world4u, zeefliz, eonMovies, ...) — which is
 * exactly why those all failed with "Invalid URL": stream.js ends up
 * fetching an empty/garbage URL after failing to find HubCloud/vcloud
 * markers on a page that was never meant to contain them.
 */

function extractLinkListSummary(metadata) {
  const linkList = Array.isArray(metadata?.linkList) ? metadata.linkList : [];
  const direct = [];
  const episodeGroups = [];

  for (const entry of linkList) {
    if (Array.isArray(entry?.directLinks) && entry.directLinks.length) {
      for (const dl of entry.directLinks) {
        if (dl?.link) {
          direct.push({
            title: dl.title || entry.title || "",
            quality: entry.quality || "",
            link: dl.link
          });
        }
      }
    } else if (entry?.episodesLink) {
      episodeGroups.push({
        title: entry.title || "",
        quality: entry.quality || "",
        episodesLink: entry.episodesLink
      });
    }
  }

  return { direct, episodeGroups };
}

/**
 * Turns a meta() result into a flat list of links that are actually valid
 * getStream() inputs — expanding any episodesLink groups via the
 * provider's episodes.js module where one exists.
 */
async function buildResolvedCandidates(provider, metadata, episodeIndex = 0) {
  const { direct, episodeGroups } = extractLinkListSummary(metadata);
  const resolved = [...direct];

  for (const group of episodeGroups) {
    try {
      const episodesMod = loadModule(provider, "episodes");
      if (!episodesMod.getEpisodes) continue;

      const epTimeout = makeTimeout(20000);
      let episodes;
      try {
        episodes = await episodesMod.getEpisodes({
          url: group.episodesLink,
          signal: epTimeout.controller.signal,
          providerContext
        });
      } finally {
        epTimeout.stop();
      }

      const list = Array.isArray(episodes) ? episodes : [];
      const ep = list[episodeIndex] || list[0];

      if (ep?.link) {
        resolved.push({
          title: ep.title || group.title,
          quality: group.quality,
          link: ep.link
        });
      }
    } catch {
      // Provider has no episodes module, or extraction failed for this
      // group — skip it, other candidates may still resolve.
    }
  }

  return resolved;
}

function classifyError(message) {
  const lower = (message || "").toLowerCase();
  if (lower.includes("webview_required") || lower.includes("webview challenge")) return "WEBVIEW_REQUIRED";
  if (lower.includes("timeout")) return "TIMEOUT";
  if (lower.includes("403") || lower.includes("forbidden")) return "HTTP_403";
  if (lower.includes("404") || lower.includes("not found")) return "HTTP_404";
  if (lower.includes("dns") || lower.includes("enotfound")) return "DNS_ERROR";
  return "ERROR";
}

/* ---------------------------------------------------------------- */
/* SERVER STATUS                                                      */
/* ---------------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    name: "Butterfly Provider Server",
    status: "online",
    vegaProviders: getProviders().length
  });
});

app.get("/providers", (req, res) => {
  res.json({ version: 1, providers: getProviders() });
});

/* ---------------------------------------------------------------- */
/* SEARCH                                                             */
/* ---------------------------------------------------------------- */

app.get("/search/:provider", async (req, res) => {
  try {
    const provider = req.params.provider;
    const query = String(req.query.q || "").trim();
    const page = Number(req.query.page || 1);

    if (!query) {
      return res.status(400).json({ success: false, error: "Missing q parameter" });
    }

    const mod = loadModule(provider, "posts");
    if (!mod.getSearchPosts) {
      return res.status(400).json({ success: false, error: "Provider does not support search" });
    }

    const timeout = makeTimeout(20000);
    try {
      const results = await mod.getSearchPosts({
        searchQuery: query,
        page,
        providerValue: provider,
        signal: timeout.controller.signal,
        providerContext
      });

      res.json({ success: true, provider, query, page, results });
    } finally {
      timeout.stop();
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

/* ---------------------------------------------------------------- */
/* META  — now also returns ready-to-use stream candidates            */
/* ---------------------------------------------------------------- */

app.get("/meta/:provider", async (req, res) => {
  try {
    const provider = req.params.provider;
    const link = String(req.query.link || "").trim();

    if (!link) {
      return res.status(400).json({ success: false, error: "Missing link parameter" });
    }

    const mod = loadModule(provider, "meta");
    if (!mod.getMeta) {
      return res.status(400).json({ success: false, error: "Provider does not support metadata" });
    }

    const timeout = makeTimeout(20000);
    let result;
    try {
      result = await mod.getMeta({ link, signal: timeout.controller.signal, providerContext });
    } finally {
      timeout.stop();
    }

    const { direct, episodeGroups } = extractLinkListSummary(result);

    res.json({
      success: true,
      provider,
      result,
      // Ready to pass straight into /stream/:provider?link=<link>
      streamCandidates: direct,
      // Series listing pages — call /episodes/:provider?url=<episodesLink>
      // to turn each of these into their own streamCandidates.
      episodeGroups
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

/* ---------------------------------------------------------------- */
/* EPISODES (new) — required for series on movies4u/vega/mod/          */
/* world4u/zeefliz, which don't inline directLinks in linkList         */
/* ---------------------------------------------------------------- */

app.get("/episodes/:provider", async (req, res) => {
  try {
    const provider = req.params.provider;
    const url = String(req.query.url || "").trim();

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "Missing url parameter (use an episodesLink from /meta result.episodeGroups)"
      });
    }

    let mod;
    try {
      mod = loadModule(provider, "episodes");
    } catch {
      return res.status(400).json({
        success: false,
        error: "Provider has no episodes module — its series links are inline in /meta streamCandidates instead"
      });
    }

    if (!mod.getEpisodes) {
      return res.status(400).json({ success: false, error: "Provider does not support episode listing" });
    }

    const timeout = makeTimeout(20000);
    try {
      const episodes = await mod.getEpisodes({ url, signal: timeout.controller.signal, providerContext });
      res.json({ success: true, provider, episodes });
    } finally {
      timeout.stop();
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

/* ---------------------------------------------------------------- */
/* STREAM — unchanged contract, but `link` MUST be a resolved         */
/* streamCandidates[].link (or an episode's .link), never the raw     */
/* search-result link.                                                */
/* ---------------------------------------------------------------- */

app.get("/stream/:provider", async (req, res) => {
  try {
    const provider = req.params.provider;
    const link = String(req.query.link || "").trim();
    const type = String(req.query.type || "movie");

    if (!link) {
      return res.status(400).json({ success: false, error: "Missing link parameter" });
    }

    const mod = loadModule(provider, "stream");
    if (!mod.getStream) {
      return res.status(400).json({ success: false, error: "Provider does not support streams" });
    }

    const timeout = makeTimeout(30000);
    try {
      const streams = await mod.getStream({
        link,
        type,
        signal: timeout.controller.signal,
        providerContext,
        isDownload: false
      });

      res.json({ success: true, provider, streams });
    } finally {
      timeout.stop();
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

/* ---------------------------------------------------------------- */
/* RESOLVE (new) — one-call convenience: search-result link in,       */
/* playable stream(s) out. Runs the full real pipeline server-side    */
/* and tries multiple candidates until one actually plays.            */
/* ---------------------------------------------------------------- */

app.get("/resolve/:provider", async (req, res) => {
  try {
    const provider = req.params.provider;
    const link = String(req.query.link || "").trim();
    const type = String(req.query.type || "movie");
    const episodeIndex = Number(req.query.episodeIndex || 0);
    const tryAll = req.query.tryAll !== "false";

    if (!link) {
      return res.status(400).json({
        success: false,
        error: "Missing link parameter (use the link from /search results, not a stream link)"
      });
    }

    const metaMod = loadModule(provider, "meta");
    if (!metaMod.getMeta) {
      return res.status(400).json({ success: false, error: "Provider does not support metadata" });
    }

    const metaTimeout = makeTimeout(20000);
    let metadata;
    try {
      metadata = await metaMod.getMeta({ link, signal: metaTimeout.controller.signal, providerContext });
    } finally {
      metaTimeout.stop();
    }

    if (!metadata) {
      return res.status(502).json({ success: false, provider, status: "META_EMPTY" });
    }

    const candidates = await buildResolvedCandidates(provider, metadata, episodeIndex);

    if (!candidates.length) {
      return res.status(502).json({
        success: false,
        provider,
        status: "LINKLIST_EMPTY",
        title: metadata.title,
        error: "meta() returned no directLinks and no resolvable episodesLink"
      });
    }

    const streamMod = loadModule(provider, "stream");
    if (!streamMod.getStream) {
      return res.status(400).json({ success: false, error: "Provider does not support streams" });
    }

    const tryList = tryAll ? candidates.slice(0, 5) : candidates.slice(0, 1);
    const attempts = [];

    for (const cand of tryList) {
      const streamTimeout = makeTimeout(30000);
      try {
        const streams = await streamMod.getStream({
          link: cand.link,
          type: metadata?.type || type,
          signal: streamTimeout.controller.signal,
          providerContext,
          isDownload: false
        });

        const items = getStreamItems(streams);
        const urls = items.filter(it => isPlayableUrl(getStreamUrl(it), cand.link));

        attempts.push({
          sourceTitle: cand.title,
          quality: cand.quality,
          streamCount: items.length,
          playableCount: urls.length
        });

        if (urls.length) {
          return res.json({
            success: true,
            provider,
            status: "STREAM_FOUND",
            title: metadata.title,
            type: metadata.type,
            sourceTitle: cand.title,
            quality: cand.quality,
            streams: urls
          });
        }
      } catch (err) {
        const message = err?.message || String(err);
        attempts.push({ sourceTitle: cand.title, quality: cand.quality, error: message });
      } finally {
        streamTimeout.stop();
      }
    }

    res.status(502).json({
      success: false,
      provider,
      status: "STREAM_NOT_FOUND",
      title: metadata.title,
      attempts
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

/* ---------------------------------------------------------------- */
/* HEALTH                                                              */
/* ---------------------------------------------------------------- */

app.get("/health", (req, res) => {
  res.json({ status: "ok", vegaProviders: getProviders().length });
});

/* ---------------------------------------------------------------- */
/* DIAGNOSE — now follows the real pipeline end to end                */
/* ---------------------------------------------------------------- */

app.get("/diagnose", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({ success: false, error: "Use /diagnose?q=Avengers" });
  }

  const results = [];

  for (const providerInfo of getProviders()) {
    const started = Date.now();

    const result = {
      provider: providerInfo.id,
      status: "UNKNOWN",
      search: false,
      meta: false,
      streamModule: false,
      resolvedCandidates: 0,
      streamCount: 0,
      streamUrls: 0,
      resolvedVia: null,
      error: null,
      ms: 0
    };

    try {
      /* SEARCH */
      let posts;
      try {
        posts = loadModule(providerInfo.id, "posts");
      } catch {
        result.status = "NO_SEARCH_MODULE";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      if (!posts.getSearchPosts) {
        result.status = "NO_SEARCH";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      const searchTimeout = makeTimeout(20000);
      let search;
      try {
        search = await posts.getSearchPosts({
          searchQuery: query,
          page: 1,
          providerValue: providerInfo.id,
          signal: searchTimeout.controller.signal,
          providerContext
        });
      } finally {
        searchTimeout.stop();
      }

      const items = getSearchItems(search);
      if (!items.length) {
        result.status = "SEARCH_EMPTY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }
      result.search = true;

      /* LINK */
      const link = getLink(items[0]);
      if (!link) {
        result.status = "SEARCH_NO_LINK";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      /* META */
      let metaMod;
      try {
        metaMod = loadModule(providerInfo.id, "meta");
      } catch {
        result.status = "SEARCH_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      if (!metaMod.getMeta) {
        result.status = "SEARCH_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      const metaTimeout = makeTimeout(20000);
      let metadata;
      try {
        metadata = await metaMod.getMeta({ link, signal: metaTimeout.controller.signal, providerContext });
      } finally {
        metaTimeout.stop();
      }

      if (!metadata) {
        result.status = "META_EMPTY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }
      result.meta = true;

      /* STREAM MODULE */
      let streamMod;
      try {
        streamMod = loadModule(providerInfo.id, "stream");
      } catch {
        result.status = "META_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      if (!streamMod.getStream) {
        result.status = "META_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }
      result.streamModule = true;

      /* RESOLVE REAL STREAM-SOURCE LINKS (directLinks, or episodesLink -> episodes.getEpisodes) */
      const candidates = await buildResolvedCandidates(providerInfo.id, metadata, 0);
      result.resolvedCandidates = candidates.length;

      if (!candidates.length) {
        result.status = "LINKLIST_EMPTY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      /* TRY UP TO 3 RESOLVED CANDIDATES — a dead mirror on #1 shouldn't sink the whole provider */
      let lastErrorMsg = null;

      for (const cand of candidates.slice(0, 3)) {
        const streamTimeout = makeTimeout(30000);
        try {
          const streams = await streamMod.getStream({
            link: cand.link,
            type: metadata?.type || metadata?.mediaType || "movie",
            signal: streamTimeout.controller.signal,
            providerContext,
            isDownload: false
          });

          const streamItems = getStreamItems(streams);
          result.streamCount = streamItems.length;

          const urls = streamItems.map(getStreamUrl).filter(u => isPlayableUrl(u, cand.link));
          result.streamUrls = urls.length;

          if (urls.length) {
            result.status = "STREAM_FOUND";
            result.resolvedVia = cand.title || cand.quality || "candidate";
            break;
          } else if (streamItems.length) {
            result.status = "STREAM_NO_URL";
          } else {
            result.status = "STREAM_EMPTY";
          }
        } catch (err) {
          lastErrorMsg = err?.message || String(err);
          result.status = classifyError(lastErrorMsg);
          // if this candidate needed a WebView, the next quality/mirror might not — keep trying
        } finally {
          streamTimeout.stop();
        }

        if (result.status === "STREAM_FOUND") break;
      }

      if (result.status !== "STREAM_FOUND" && lastErrorMsg) {
        result.error = lastErrorMsg;
      }

    } catch (error) {
      const message = error?.message || String(error);
      result.status = classifyError(message);
      result.error = message;
    }

    result.ms = Date.now() - started;
    results.push(result);
  }

  const counts = {};
  for (const item of results) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }

  res.json({ success: true, query, total: results.length, counts, results });
});


/* ---------------------------------------------------------------- */
/* NUVIO PROVIDERS — kept separate from the existing Vega providers   */
/* Requires setup-vega.js (or your Render build process) to clone and  */
/* build ./nuvio-providers before the server starts.                   */
/* ---------------------------------------------------------------- */

const nuvioRoot = path.resolve("./nuvio-providers");
const nuvioManifestPath = path.join(nuvioRoot, "manifest.json");

// Built Nuvio providers ship with shared public TMDB keys (often rate-limited
// or revoked). Swap them for your own key once at startup.
const TMDB_KEY = (process.env.TMDB_API_KEY || "").trim();
const OLD_TMDB_KEYS = ["1865f43a0549ca50d341dd9ab8b29f49", "439c478a771f35c05022f9feabcca01c"];

function applyTmdbKeyToNuvio() {
  if (!TMDB_KEY) { console.log("[Nuvio] TMDB_API_KEY not set - providers keep their bundled keys"); return; }
  try {
    const dir = path.join(nuvioRoot, "providers");
    if (!fs.existsSync(dir)) return;
    let changed = 0;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".js"))) {
      const file = path.join(dir, f);
      let code = fs.readFileSync(file, "utf8");
      let next = code;
      for (const k of OLD_TMDB_KEYS) next = next.split(k).join(TMDB_KEY);
      if (next !== code) {
        fs.writeFileSync(file, next);
        changed++;
      }
    }
    console.log(`[Nuvio] TMDB key applied to ${changed} provider files`);
  } catch (e) {
    console.warn("[Nuvio] Could not apply TMDB key:", e?.message || e);
  }
}
applyTmdbKeyToNuvio();

function getNuvioManifest() {
  if (!fs.existsSync(nuvioManifestPath)) {
    throw new Error(
      "Nuvio providers are not installed. Clone/build phisher98/phisher-nuvio-providers during deployment."
    );
  }

  const manifest = JSON.parse(fs.readFileSync(nuvioManifestPath, "utf8"));
  if (!Array.isArray(manifest.scrapers)) {
    throw new Error("Invalid Nuvio manifest: expected a scrapers array");
  }

  return manifest;
}

function loadNuvioProvider(providerId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
    throw new Error("Invalid Nuvio provider ID");
  }

  const manifest = getNuvioManifest();
  const info = manifest.scrapers.find(
    item => item.id === providerId && item.enabled !== false
  );

  if (!info) {
    const error = new Error(`Nuvio provider not found or disabled: ${providerId}`);
    error.statusCode = 404;
    throw error;
  }

  const relativeFile = String(info.filename || "");
  if (!relativeFile || !relativeFile.endsWith(".js") || path.isAbsolute(relativeFile)) {
    throw new Error("Invalid provider filename in Nuvio manifest");
  }

  const file = path.resolve(nuvioRoot, relativeFile);
  const rootPrefix = nuvioRoot.endsWith(path.sep) ? nuvioRoot : nuvioRoot + path.sep;

  if (!file.startsWith(rootPrefix) || !fs.existsSync(file)) {
    const error = new Error(`Nuvio provider file not found: ${relativeFile}`);
    error.statusCode = 404;
    throw error;
  }

  const loaded = require(file);
  const mod = loaded?.default || loaded;

  if (typeof mod.getStreams !== "function") {
    throw new Error(`Nuvio provider ${providerId} does not export getStreams()`);
  }

  return { info, mod };
}

app.get("/nuvio/health", (req, res) => {
  try {
    const manifest = getNuvioManifest();
    const enabled = manifest.scrapers.filter(item => item.enabled !== false);
    res.json({
      status: "ok",
      providerType: "nuvio",
      total: manifest.scrapers.length,
      enabled: enabled.length
    });
  } catch (error) {
    res.status(503).json({
      status: "unavailable",
      providerType: "nuvio",
      error: error?.message || String(error)
    });
  }
});

app.get("/nuvio/providers", (req, res) => {
  try {
    const manifest = getNuvioManifest();
    const providers = manifest.scrapers.map(item => ({
      id: item.id,
      filename: item.filename,
      enabled: item.enabled !== false,
      supportedTypes: item.supportedTypes || []
    }));

    res.json({
      success: true,
      version: manifest.version || 1,
      count: providers.length,
      enabledCount: providers.filter(item => item.enabled).length,
      providers
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      error: error?.message || String(error)
    });
  }
});

/*
 * Example:
 * /nuvio/streams/MoviesDrive?tmdbId=872585&type=movie
 * /nuvio/streams/SomeProvider?tmdbId=1399&type=tv&season=1&episode=2
 *
 * This returns provider results for testing. It does not guarantee that
 * every provider returns a directly playable URL; some return embed pages
 * or depend on APIs/runtime features not available on a Node server.
 */
app.get("/nuvio/streams/:provider", async (req, res) => {
  try {
    const providerId = req.params.provider;
    const tmdbId = String(req.query.tmdbId || "").trim();
    const type = String(req.query.type || "movie").toLowerCase();
    const season = Number.parseInt(String(req.query.season || "1"), 10);
    const episode = Number.parseInt(String(req.query.episode || "1"), 10);

    if (!tmdbId) {
      return res.status(400).json({
        success: false,
        error: "Missing tmdbId query parameter"
      });
    }

    if (!["movie", "tv", "show", "anime"].includes(type)) {
      return res.status(400).json({
        success: false,
        error: "type must be movie, tv, show, or anime"
      });
    }

    if (!Number.isInteger(season) || season < 1 ||
        !Number.isInteger(episode) || episode < 1) {
      return res.status(400).json({
        success: false,
        error: "season and episode must be positive integers"
      });
    }

    const { mod } = loadNuvioProvider(providerId);
    const streams = await mod.getStreams(tmdbId, type, season, episode);
    const list = Array.isArray(streams)
      ? streams
      : Array.isArray(streams?.streams)
        ? streams.streams
        : [];

    res.json({
      success: true,
      provider: providerId,
      tmdbId,
      type,
      season: type === "movie" ? null : season,
      episode: type === "movie" ? null : episode,
      count: list.length,
      streams: list
    });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    res.status(status).json({
      success: false,
      provider: req.params.provider,
      error: error?.message || String(error)
    });
  }
});


/*
 * One-call Nuvio resolver for the app:
 * /nuvio/resolve?tmdbId=27205&type=movie[&season=1&episode=1][&providers=MoviesDrive,hdhub4u][&limit=6]
 * Tries enabled Nuvio providers (4 at a time, 25s each) and returns real
 * stream URLs. success:false if none produced a URL.
 */
app.get("/nuvio/resolve", async (req, res) => {
  try {
    const tmdbId = String(req.query.tmdbId || "").trim();
    const type = String(req.query.type || "movie").toLowerCase();
    const season = Number.parseInt(String(req.query.season || "1"), 10) || 1;
    const episode = Number.parseInt(String(req.query.episode || "1"), 10) || 1;
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || "6"), 10) || 6, 1), 12);
    if (!tmdbId) return res.status(400).json({ success: false, error: "Missing tmdbId" });

    const manifest = getNuvioManifest();
    const wanted = String(req.query.providers || "")
      .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    const isTv = type === "tv" || type === "show" || type === "series";
    let list = manifest.scrapers.filter(i => i.enabled !== false)
      .filter(i => !i.supportedTypes?.length || i.supportedTypes.includes(isTv ? "tv" : "movie"));
    if (wanted.length) list = list.filter(i => wanted.includes(String(i.id).toLowerCase()));

    const streams = [];
    const tried = [];
    for (let i = 0; i < list.length && streams.length === 0 && i < 12; i += 4) {
      const batch = list.slice(i, i + 4);
      await Promise.all(batch.map(async info => {
        try {
          const { mod } = loadNuvioProvider(info.id);
          const out = await Promise.race([
            mod.getStreams(tmdbId, isTv ? "tv" : "movie", season, episode),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 25000))
          ]);
          const arr = Array.isArray(out) ? out : Array.isArray(out?.streams) ? out.streams : [];
          let n = 0;
          for (const s of arr) {
            const url = s?.url || s?.link;
            if (!url || !/^https?:\/\//i.test(url)) continue;
            streams.push({
              server: s.name || s.provider || info.id,
              link: url,
              quality: s.quality || "",
              headers: s.headers || {},
              type: /\.m3u8/i.test(url) ? "m3u8" : /\.mkv/i.test(url) ? "mkv" : "mp4",
              provider: info.id
            });
            n++;
          }
          tried.push({ provider: info.id, streams: n });
        } catch (e) {
          tried.push({ provider: info.id, error: e?.message || String(e) });
        }
      }));
    }
    const out = streams.slice(0, limit * 4);
    res.status(out.length ? 200 : 502).json({ success: out.length > 0, tmdbId, type, count: out.length, streams: out, tried });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

/* DEBUG: shows what Render gets back from the OlaMovies Worker */
app.get("/debug-ola", async (req, res) => {
  // Disabled unless DEBUG_TOKEN is set on Render and passed as ?token=
  if (!process.env.DEBUG_TOKEN || req.query.token !== process.env.DEBUG_TOKEN) {
    return res.status(404).json({ error: "not found" });
  }
  const target = "https://v6.olamovies.mov/api/search?q=Inception&limit=24";
  const base = `${OLA_PROXY}/?url=${encodeURIComponent(target)}`;
  const ua = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
  const tests = {
    header: { url: base, headers: { "x-proxy-key": OLA_KEY } },
    query: { url: `${base}&k=${encodeURIComponent(OLA_KEY)}`, headers: {} },
    queryBrowserUA: { url: `${base}&k=${encodeURIComponent(OLA_KEY)}`, headers: { "User-Agent": ua } }
  };
  const out = { proxy: OLA_PROXY, keyLength: OLA_KEY.length, envKeySet: !!process.env.OLA_PROXY_KEY, envUrlSet: !!process.env.OLA_PROXY_URL };
  for (const [name, t] of Object.entries(tests)) {
    try {
      const r = await axios.get(t.url, { headers: t.headers, timeout: 20000, validateStatus: () => true, responseType: "text", transformResponse: x => x });
      out[name] = { status: r.status, server: r.headers["server"], cfRay: r.headers["cf-ray"], body: String(r.data).slice(0, 200) };
    } catch (e) {
      out[name] = { error: e?.message || String(e) };
    }
  }
  res.json(out);
});

/* START */

registerExtras(app, { port: PORT }); // TMDB proxy, yt-dlp, addons, /unified, /status

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Butterfly Provider Server running on port ${PORT}`);
});
