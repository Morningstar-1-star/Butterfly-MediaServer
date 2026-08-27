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
  const file = path.resolve(
    distPath,
    provider,
    `${module}.js`
  );

  if (!fs.existsSync(file)) {
    throw new Error(
      `Provider/module not found: ${provider}/${module}`
    );
  }

  return require(file);
}

function makeTimeout(ms) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, ms);

  return {
    controller,
    stop() {
      clearTimeout(timer);
    }
  };
}

function getSearchItems(search) {
  if (Array.isArray(search)) return search;

  return (
    search?.posts ||
    search?.results ||
    search?.items ||
    search?.data ||
    []
  );
}

function getLink(item) {
  if (!item) return null;

  return (
    item.link ||
    item.url ||
    item.href ||
    item.post?.link ||
    item.post?.url ||
    item.id
  );
}

function getStreamItems(streams) {
  if (Array.isArray(streams)) return streams;

  return (
    streams?.streams ||
    streams?.links ||
    streams?.results ||
    streams?.data ||
    []
  );
}

function getStreamUrl(item) {
  if (typeof item === "string") return item;

  return (
    item?.link ||
    item?.url ||
    item?.file ||
    item?.src ||
    item?.source ||
    null
  );
}

/* SERVER STATUS */

app.get("/", (req, res) => {
  res.json({
    name: "Butterfly Provider Server",
    status: "online",
    vegaProviders: getProviders().length
  });
});

/* PROVIDERS */

app.get("/providers", (req, res) => {
  res.json({
    version: 1,
    providers: getProviders()
  });
});

/* SEARCH */

app.get("/search/:provider", async (req, res) => {
  try {
    const provider = req.params.provider;
    const query = String(req.query.q || "").trim();
    const page = Number(req.query.page || 1);

    if (!query) {
      return res.status(400).json({
        success: false,
        error: "Missing q parameter"
      });
    }

    const mod = loadModule(provider, "posts");

    if (!mod.getSearchPosts) {
      return res.status(400).json({
        success: false,
        error: "Provider does not support search"
      });
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

      res.json({
        success: true,
        provider,
        query,
        page,
        results
      });
    } finally {
      timeout.stop();
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
});

/* META */

app.get("/meta/:provider", async (req, res) => {
  try {
    const provider = req.params.provider;
    const link = String(req.query.link || "").trim();

    if (!link) {
      return res.status(400).json({
        success: false,
        error: "Missing link parameter"
      });
    }

    const mod = loadModule(provider, "meta");

    if (!mod.getMeta) {
      return res.status(400).json({
        success: false,
        error: "Provider does not support metadata"
      });
    }

    const timeout = makeTimeout(20000);

    try {
      const result = await mod.getMeta({
        link,
        signal: timeout.controller.signal,
        providerContext
      });

      res.json({
        success: true,
        provider,
        result
      });
    } finally {
      timeout.stop();
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
});

/* STREAM */

app.get("/stream/:provider", async (req, res) => {
  try {
    const provider = req.params.provider;
    const link = String(req.query.link || "").trim();
    const type = String(req.query.type || "movie");

    if (!link) {
      return res.status(400).json({
        success: false,
        error: "Missing link parameter"
      });
    }

    const mod = loadModule(provider, "stream");

    if (!mod.getStream) {
      return res.status(400).json({
        success: false,
        error: "Provider does not support streams"
      });
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

      res.json({
        success: true,
        provider,
        streams
      });
    } finally {
      timeout.stop();
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
});

/* HEALTH */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    vegaProviders: getProviders().length
  });
});

/* REAL VEGA DIAGNOSTIC */

app.get("/diagnose", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      success: false,
      error: "Use /diagnose?q=Avengers"
    });
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
      streamCount: 0,
      streamUrls: 0,
      error: null,
      ms: 0
    };

    try {
      /* SEARCH */

      let posts;

      try {
        posts = loadModule(
          providerInfo.id,
          "posts"
        );
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

      let meta;

      try {
        meta = loadModule(
          providerInfo.id,
          "meta"
        );
      } catch {
        result.status = "SEARCH_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      if (!meta.getMeta) {
        result.status = "SEARCH_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      const metaTimeout = makeTimeout(20000);

      let metadata;

      try {
        metadata = await meta.getMeta({
          link,
          signal: metaTimeout.controller.signal,
          providerContext
        });
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

      let stream;

      try {
        stream = loadModule(
          providerInfo.id,
          "stream"
        );
      } catch {
        result.status = "META_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      if (!stream.getStream) {
        result.status = "META_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      result.streamModule = true;

      /* ACTUAL STREAM EXTRACTION */

      const streamTimeout = makeTimeout(30000);

      let streams;

      try {
        streams = await stream.getStream({
          link,
          type:
            metadata?.type ||
            metadata?.mediaType ||
            "movie",
          signal: streamTimeout.controller.signal,
          providerContext,
          isDownload: false
        });
      } finally {
        streamTimeout.stop();
      }

      const streamItems = getStreamItems(streams);

      result.streamCount = streamItems.length;

      const urls = streamItems
        .map(getStreamUrl)
        .filter(Boolean);

      result.streamUrls = urls.length;

      if (!streamItems.length) {
        result.status = "STREAM_EMPTY";
      } else if (!urls.length) {
        result.status = "STREAM_NO_URL";
      } else {
        result.status = "STREAM_FOUND";
      }

    } catch (error) {
      const message =
        error?.message ||
        String(error);

      const lower = message.toLowerCase();

      if (
        lower.includes("webview challenge") ||
        lower.includes("webview_required")
      ) {
        result.status = "WEBVIEW_REQUIRED";
      } else if (
        error?.name === "AbortError" ||
        lower.includes("timeout")
      ) {
        result.status = "TIMEOUT";
      } else if (
        lower.includes("403") ||
        lower.includes("forbidden")
      ) {
        result.status = "HTTP_403";
      } else if (
        lower.includes("404") ||
        lower.includes("not found")
      ) {
        result.status = "HTTP_404";
      } else if (
        lower.includes("dns") ||
        lower.includes("enotfound")
      ) {
        result.status = "DNS_ERROR";
      } else {
        result.status = "ERROR";
      }

      result.error = message;
    }

    result.ms = Date.now() - started;
    results.push(result);
  }

  const counts = {};

  for (const item of results) {
    counts[item.status] =
      (counts[item.status] || 0) + 1;
  }

  res.json({
    success: true,
    query,
    total: results.length,
    counts,
    results
  });
});

/* START */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Butterfly Provider Server running on port ${PORT}`
  );
});
