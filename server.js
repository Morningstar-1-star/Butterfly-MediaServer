import express from "express";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

const providersFile = "./providers/index.json";

function getProviders() {
  try {
    return JSON.parse(fs.readFileSync(providersFile, "utf8"));
  } catch {
    return { version: 1, providers: [] };
  }
}

app.get("/", (req, res) => {
  const data = getProviders();

  res.json({
    name: "Butterfly Provider Server",
    status: "online",
    providers: data.providers.length
  });
});

app.get("/providers", (req, res) => {
  res.json(getProviders());
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Butterfly Provider Server running on port ${PORT}`);
});
