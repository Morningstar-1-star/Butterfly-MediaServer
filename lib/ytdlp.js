import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { createCache } from "./cache.js";
import { isSafePublicUrl } from "./security.js";

// yt-dlp backup extractor. Binary is downloaded at build time by setup-vega.js
// into ./bin/yt-dlp (standalone build, no Python needed). Falls back to a
// `yt-dlp` found on PATH.
const LOCAL_BIN = path.resolve("./bin/yt-dlp");
const cache = createCache({ ttlMs: 5 * 60 * 1000, max: 200 });
let running = 0;
const MAX_PARALLEL = 2; // Render free = 512 MB RAM

function binPath() {
  return fs.existsSync(LOCAL_BIN) ? LOCAL_BIN : "yt-dlp";
}

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(binPath(), args, { timeout: timeoutMs, maxBuffer: 25 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").toString().split("\n").filter(Boolean).slice(-2).join(" ");
        return reject(new Error(msg || "yt-dlp failed"));
      }
      resolve(stdout.toString());
    });
  });
}

function shape(info) {
  const formats = (info.formats || [])
    .filter(f => f.url && /^https?:/i.test(f.url) && (f.vcodec !== "none" || f.acodec !== "none"))
    .map(f => ({
      id: f.format_id,
      url: f.url,
      ext: f.ext,
      height: f.height || null,
      fps: f.fps || null,
      hasVideo: f.vcodec && f.vcodec !== "none",
      hasAudio: f.acodec && f.acodec !== "none",
      protocol: f.protocol,
      bitrate: f.tbr ? Math.round(f.tbr) : null,
      headers: f.http_headers || info.http_headers || {}
    }));
  const muxed = formats.filter(f => f.hasVideo && f.hasAudio).sort((a, b) => (b.height || 0) - (a.height || 0));
  const host = (() => { try { return new URL(info.webpage_url || "").hostname; } catch { return ""; } })();
  return {
    title: info.title,
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    uploader: info.uploader || null,
    extractor: info.extractor_key,
    // YouTube/googlevideo URLs are bound to the IP that requested them (this server).
    // The phone usually can't play them directly: use only as metadata / for sites
    // that don't IP-lock, or fall back to the app's local NewPipe/yt-dlp.
    ipBound: /youtube|youtu\.be|googlevideo/i.test(host + (info.extractor_key || "")),
    best: muxed[0] || null,
    formats
  };
}

export function registerYtdlp(app) {
  app.get("/ytdlp/health", async (req, res) => {
    try {
      const v = (await run(["--version"], 10000)).trim();
      res.json({ status: "ok", version: v, binary: binPath() });
    } catch (e) {
      res.status(503).json({ status: "unavailable", error: e.message, hint: "Build step must download ./bin/yt-dlp (see setup-vega.js)" });
    }
  });

  // GET /ytdlp/extract?url=<page url>&audio=1(optional)
  app.get("/ytdlp/extract", async (req, res) => {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ success: false, error: "Missing url" });
    if (!isSafePublicUrl(url)) return res.status(400).json({ success: false, error: "URL not allowed" });

    const hit = cache.get(url);
    if (hit) return res.set("X-Cache", "HIT").json(hit);

    if (running >= MAX_PARALLEL) return res.status(429).json({ success: false, error: "Busy, retry in a few seconds" });
    running++;
    try {
      const out = await run(["-J", "--no-playlist", "--no-warnings", "--socket-timeout", "15", url], 50000);
      const body = { success: true, ...shape(JSON.parse(out)) };
      cache.set(url, body);
      res.json(body);
    } catch (e) {
      res.status(502).json({ success: false, error: e?.message || String(e) });
    } finally {
      running--;
    }
  });
}
