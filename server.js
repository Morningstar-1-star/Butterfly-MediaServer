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
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
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

  return fs.readdirSync(distPath, { withFileTypes: true })
    .filter(x => x.isDirectory())
    .map(x => ({
      id: x.name,
      modules: fs.readdirSync(path.join(distPath, x.name))
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
    throw new Error(`Provider/module not found: ${provider}/${module}`);
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
    const query = req.query.q || "";
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

    const results = await mod.getSearchPosts({
      searchQuery: query,
      page,
      providerValue: provider,
      signal: controller.signal,
      providerContext
    });

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
      error: error.message
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
      error: error.message
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

    const result = await mod.getStream({
      link,
      type,
      signal: controller.signal,
      providerContext,
      isDownload: false
    });

    res.json({
      success: true,
      provider,
      streams: result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* HEALTH */

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Butterfly Provider Server running on port ${PORT}`
  );
});
