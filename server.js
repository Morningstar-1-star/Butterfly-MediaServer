import express from "express";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

const providers = JSON.parse(
  fs.readFileSync("./providers/index.json", "utf8")
);

app.get("/", (req, res) => {
  res.json({
    name: "Butterfly Provider Server",
    status: "online",
    providers: providers.providers.length
  });
});

app.get("/providers", (req, res) => {
  res.json(providers);
});

app.listen(PORT, () => {
  console.log(`Butterfly Provider Server running on port ${PORT}`);
});
