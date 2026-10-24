# Butterfly MediaServer v2.2

Render settings
- Build: `npm install && npm run build`
- Start: `npm start`

Environment variables (Render > Environment)
| Name | Needed | Purpose |
|---|---|---|
| TMDB_API_KEY | yes | Your TMDB key (v3 key or v4 token). Used by /tmdb and Nuvio providers |
| OLA_PROXY_URL / OLA_PROXY_KEY | optional | Your Cloudflare Worker for OlaMovies |
| UNIFIED_VEGA | optional | e.g. `hdhub4u,drive` - Vega providers /unified also queries by title |
| STREMIO_ADDONS | optional | Comma list of Comet / MediaFusion manifest URLs (direct-link addons only) |
| APP_KEY | optional | If set, every route needs header `x-app-key` |
| DEBUG_TOKEN | optional | Enables /debug-ola?token=... |

Routes
- Existing: /providers /search /meta /episodes /stream /resolve /diagnose /nuvio/*
- New: /tmdb/<tmdb path> , /unified , /ytdlp/health , /ytdlp/extract?url= , /addons/streams , /status

Notes
- YouTube links from /ytdlp/extract are bound to the server IP (`ipBound: true`); keep the app's local extractor for YouTube playback.
- Free Render sleeps after ~15 min idle: ping /health every 5 min with UptimeRobot / cron-job.org.
