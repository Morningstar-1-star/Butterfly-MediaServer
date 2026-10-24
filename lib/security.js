// Optional access gate. OFF unless APP_KEY is set on Render.
// When on, every route except "/" and "/health" needs header  x-app-key: <APP_KEY>
// (or ?k=<APP_KEY>). Add the same header in the app's OkHttp client.
export function accessGate(req, res, next) {
  const key = (process.env.APP_KEY || "").trim();
  if (!key) return next();
  if (req.path === "/" || req.path === "/health") return next();
  const given = String(req.get("x-app-key") || req.query.k || "");
  if (given === key) return next();
  res.status(401).json({ success: false, error: "Unauthorized" });
}

// Block requests to private/loopback hosts (SSRF guard for yt-dlp / addons).
export function isSafePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
  return true;
}
