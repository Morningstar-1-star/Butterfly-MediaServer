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

const providerContext = {
  axios,
  cheerio,

  commonHeaders: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  },

  openWebView: async () => {
    throw new Error("WebView challenge requires Android client");
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

/* SERVER STATUS */

app.get("/", (req, res) => {
  res.json({
    name: "Butterfly Provider Server",
    status: "online",
    vegaProviders: getProviders().length
  });
});

/* PROVIDER LIST */

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

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      20000
    );

    let results;

    try {
      results = await mod.getSearchPosts({
        searchQuery: query,
        page,
        providerValue: provider,
        signal: controller.signal,
        providerContext
      });
    } finally {
      clearTimeout(timer);
    }

    res.json({
      success: true,
      provider,
      query,
      page,
      results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
});

/* METADATA */

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

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      30000
    );

    let result;

    try {
      result = await mod.getStream({
        link,
        type,
        signal: controller.signal,
        providerContext,
        isDownload: false
      });
    } finally {
      clearTimeout(timer);
    }

    res.json({
      success: true,
      provider,
      streams: result
    });
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
    status: "ok"
  });
});

/* VEGA DIAGNOSTICS */

app.get("/diagnose", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      success: false,
      error: "Use /diagnose?q=MovieName"
    });
  }

  const providers = getProviders();
  const results = [];

  for (const p of providers) {
    const started = Date.now();

    const result = {
      provider: p.id,
      status: "UNKNOWN",
      search: false,
      meta: false,
      stream: false,
      error: null,
      ms: 0
    };

    try {
      /* SEARCH */

      let posts;

      try {
        posts = loadModule(p.id, "posts");
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

      const controller = new AbortController();

      const timer = setTimeout(
        () => controller.abort(),
        20000
      );

      let search;

      try {
        search = await posts.getSearchPosts({
          searchQuery: query,
          page: 1,
          providerValue: p.id,
          signal: controller.signal,
          providerContext
        });
      } finally {
        clearTimeout(timer);
      }

      const items = Array.isArray(search)
        ? search
        : search?.posts ||
          search?.results ||
          search?.items ||
          [];

      if (!items.length) {
        result.status = "SEARCH_EMPTY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      result.search = true;

      /* META */

      let meta;

      try {
        meta = loadModule(p.id, "meta");
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

      const first = items[0];

      const link =
        first?.link ||
        first?.url ||
        first?.href ||
        first?.post?.link ||
        first?.post?.url;

      if (!link) {
        result.status = "SEARCH_NO_LINK";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      const metaController = new AbortController();

      const metaTimer = setTimeout(
        () => metaController.abort(),
        20000
      );

      let metaResult;

      try {
        metaResult = await meta.getMeta({
          link,
          providerContext,
          signal: metaController.signal
        });
      } finally {
        clearTimeout(metaTimer);
      }

      if (!metaResult) {
        result.status = "META_EMPTY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      result.meta = true;

      /* STREAM MODULE */

      let stream;

      try {
        stream = loadModule(p.id, "stream");
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

      result.stream = true;
      result.status = "PASS";
    } catch (error) {
      result.status =
        error?.name === "AbortError"
          ? "TIMEOUT"
          : "ERROR";

      result.error =
        error?.message || String(error);
    }

    result.ms = Date.now() - started;
    results.push(result);
  }

  res.json({
    success: true,
    query,
    total: results.length,
    passed: results.filter(
      x => x.status === "PASS"
    ).length,
    failed: results.filter(
      x => x.status !== "PASS"
    ).length,
    results
  });
});

/* START SERVER */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Butterfly Provider Server running on port ${PORT}`
  );
});
