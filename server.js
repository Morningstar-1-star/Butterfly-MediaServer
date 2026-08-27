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
      const posts = loadModule(p.id, "posts");

      if (!posts.getSearchPosts) {
        result.status = "NO_SEARCH";
        results.push(result);
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);

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
        : search?.posts || search?.results || [];

      if (!items.length) {
        result.status = "SEARCH_EMPTY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      result.search = true;

      /* META */
      const meta = loadModule(p.id, "meta");

      if (!meta.getMeta) {
        result.status = "SEARCH_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      const link =
        items[0]?.link ||
        items[0]?.url ||
        items[0]?.href;

      if (!link) {
        result.status = "SEARCH_NO_LINK";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      const metaResult = await meta.getMeta({
        link,
        providerContext
      });

      if (!metaResult) {
        result.status = "META_EMPTY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      result.meta = true;

      /* STREAM MODULE EXISTENCE */
      const stream = loadModule(p.id, "stream");

      if (!stream.getStream) {
        result.status = "META_ONLY";
        result.ms = Date.now() - started;
        results.push(result);
        continue;
      }

      result.stream = true;
      result.status = "PASS";
      result.ms = Date.now() - started;

    } catch (error) {
      result.status =
        error?.name === "AbortError"
          ? "TIMEOUT"
          : "ERROR";

      result.error = String(error?.message || error);
      result.ms = Date.now() - started;
    }

    results.push(result);
  }

  res.json({
    success: true,
    query,
    total: results.length,
    passed: results.filter(x => x.status === "PASS").length,
    failed: results.filter(x => x.status !== "PASS").length,
    results
  });
});
