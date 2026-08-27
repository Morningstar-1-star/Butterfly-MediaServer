import express from "express";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import axios from "axios";
import * as cheerio from "cheerio";
import { get as curlGet } from "curl-cffi-node";

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

/*
 * Axios-compatible wrapper.
 * Vega providers expect axios.get/post/etc.
 *
 * curl-cffi-node provides Chrome TLS/HTTP2 impersonation.
 */
function makeResponse(r) {
  return {
    data: r.data,
    status: r.status,
    statusText: String(r.status),
    headers: r.headers || {},
    config: {},
    request: {}
  };
}

const curlAxios = {
  async get(url, config = {}) {
    const response = await curlGet(url, {
      headers: {
        ...commonHeaders,
        ...(config.headers || {})
      },
      impersonate: "chrome131",
      timeout: Math.ceil((config.timeout || 30000) / 1000),
      followRedirects: true,
      maxRedirects: 10
    });

    if (response.status >= 400) {
      const error = new Error(
        `Request failed with status code ${response.status}`
      );
      error.response = makeResponse(response);
      throw error;
    }

    return makeResponse(response);
  },

  async request(config = {}) {
    const method = String(config.method || "GET").toUpperCase();

    if (method === "GET") {
      return this.get(config.url, config);
    }

    /*
     * Keep POST/other requests on Axios for now because
     * some Vega providers rely on Axios request semantics.
     */
    return axios.request(config);
  },

  get defaults() {
    return axios.defaults;
  }
};

const providerContext = {
  axios: curlAxios,
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
    const link = req.query.link;

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

    const result = await mod.getMeta({
      link,
      providerContext
    });

    res.json({
      success: true,
      provider,
      result
    });
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
    const link = req.query.link;
    const type = req.query.type || "movie";

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

/* REAL DIAGNOSTIC */

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
      playable: 0,
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
        results.push(result);
        continue;
      }

      if (!posts.getSearchPosts) {
        result.status = "NO_SEARCH";
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

      const items = Array.isArray(search)
        ? search
        : search?.posts ||
          search?.results ||
          search?.items ||
          [];

      if (!items.length) {
        result.status = "SEARCH_EMPTY";
        continue;
      }

      result.search = true;

      /* FIND LINK */

      const first = items[0];

      const link =
        first?.link ||
        first?.url ||
        first?.href ||
        first?.post?.link ||
        first?.post?.url;

      if (!link) {
        result.status = "SEARCH_NO_LINK";
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
        continue;
      }

      if (!meta.getMeta) {
        result.status = "SEARCH_ONLY";
        continue;
      }

      const metaTimeout = makeTimeout(20000);

      let metadata;

      try {
        metadata = await meta.getMeta({
          link,
          providerContext,
          signal: metaTimeout.controller.signal
        });
      } finally {
        metaTimeout.stop();
      }

      if (!metadata) {
        result.status = "META_EMPTY";
        continue;
      }

      result.meta = true;

      /* STREAM */

      let stream;

      try {
        stream = loadModule(
          providerInfo.id,
          "stream"
        );
      } catch {
        result.status = "META_ONLY";
        continue;
      }

      if (!stream.getStream) {
        result.status = "META_ONLY";
        continue;
      }

      result.streamModule = true;

      /*
       * IMPORTANT:
       * Actually execute getStream().
       */

      const streamTimeout = makeTimeout(30000);

      let streams;

      try {
        streams = await stream.getStream({
          link,
          type: metadata?.type || "movie",
          signal: streamTimeout.controller.signal,
          providerContext,
          isDownload: false
        });
      } finally {
        streamTimeout.stop();
      }

      const streamList = Array.isArray(streams)
        ? streams
        : streams?.streams ||
          streams?.links ||
          streams?.results ||
          [];

      result.streamCount = streamList.length;

      if (!streamList.length) {
        result.status = "STREAM_EMPTY";
        continue;
      }

      /*
       * We count URLs, but don't pretend that
       * HTTP 200 automatically means playable.
       */

      const urls = streamList
        .map(x =>
          typeof x === "string"
            ? x
            : x?.link ||
              x?.url
        )
        .filter(Boolean);

      result.playable = urls.length;

      if (!urls.length) {
        result.status = "STREAM_NO_URL";
        continue;
      }

      result.status = "STREAM_FOUND";

    } catch (error) {
      const message =
        error?.message ||
        String(error);

      if (
        message.includes("WEBVIEW_REQUIRED") ||
        message.includes("WebView challenge")
      ) {
        result.status = "WEBVIEW_REQUIRED";
      } else if (
        error?.name === "AbortError" ||
        message.toLowerCase().includes("timeout")
      ) {
        result.status = "TIMEOUT";
      } else if (
        message.includes("403") ||
        message.includes("Forbidden")
      ) {
        result.status = "HTTP_403";
      } else if (
        message.includes("404") ||
        message.includes("Not Found")
      ) {
        result.status = "HTTP_404";
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
