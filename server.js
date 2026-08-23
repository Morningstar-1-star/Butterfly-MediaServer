import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

const distPath = "./vega-providers/dist";

function getVegaProviders() {
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
  const providers = getVegaProviders();

  res.json({
    name: "Butterfly Provider Server",
    status: "online",
    vegaProviders: providers.length
  });
});

app.get("/providers", (req, res) => {
  res.json({
    version: 1,
    providers: getVegaProviders()
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Butterfly Provider Server running on port ${PORT}`);
});
