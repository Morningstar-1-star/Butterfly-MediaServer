import { registerTmdb } from "./tmdb.js";
import { registerYtdlp } from "./ytdlp.js";
import { registerAddons, addonList } from "./addons.js";
import { registerUnified } from "./unified.js";

export function registerExtras(app, { port }) {
  registerTmdb(app);
  registerYtdlp(app);
  registerAddons(app);
  registerUnified(app, { port });

  // Safe status page: shows what is configured, never prints secrets.
  app.get("/status", (req, res) => res.json({
    tmdbKey: !!(process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN),
    olaProxy: !!process.env.OLA_PROXY_URL && !!process.env.OLA_PROXY_KEY,
    addons: addonList().length,
    unifiedVega: String(process.env.UNIFIED_VEGA || "").split(",").filter(Boolean),
    accessGate: !!process.env.APP_KEY
  }));
}
