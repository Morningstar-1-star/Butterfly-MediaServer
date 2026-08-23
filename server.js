import express from "express";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const app = express();
const PORT = process.env.PORT || 3000;
const require = createRequire(import.meta.url);

const distPath = "./vega-providers/dist";

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

app.get("/", (req, res) => {
  res.json({
    name: "Butterfly Provider Server",
    status: "online",
    vegaProviders: getProviders().length
  });
});

app.get("/providers", (req, res) => {
  res.json({
    version: 1,
    providers: getProviders()
  });
});

app.get("/test/:provider/:module", (req, res) => {
  try {
    const file = path.resolve(
      distPath,
      req.params.provider,
      `${req.params.module}.js`
    );

    const mod = require(file);

    res.json({
      success: true,
      provider: req.params.provider,
      module: req.params.module,
      exports: Object.keys(mod)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Butterfly Provider Server running on port ${PORT}`);
});
