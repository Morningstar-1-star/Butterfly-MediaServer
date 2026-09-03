import express from "express";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;
const require = createRequire(import.meta.url);

const distPath = "./vega-providers/dist";
const memoryStore = new Map();

const commonHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

const providerContext = {
  axios,
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

function loadModule(provider, module) {
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

/* START */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Butterfly Provider Server running on port ${PORT}`);
});
