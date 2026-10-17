# TVmate Touch – Web (PWA)

A touch-first IPTV player that runs in any modern browser and installs to the iPhone home screen from Safari.
Original design; plain TypeScript + Vite + hls.js.

## Features
- M3U/M3U8 URL, Xtream Codes login, or paste/import an M3U file
- Channel groups (chips), search, favorites (stored on device)
- EPG grid (XMLTV, `.gz` supported where the browser has `DecompressionStream`), now-line, jump to now
- HLS player (native HLS on Safari/iOS, hls.js elsewhere), mini player, PiP, fullscreen
- Swipe left/right on the video to change channel; swipe down to minimize, up to expand
- iOS layout: safe-area insets, bottom tab bar, `apple-touch-icon`, web manifest, standalone display

## Run
```bash
npm install
npm run dev        # http://<your-ip>:5173 (LAN)
npm run build      # outputs dist/ (static; host anywhere over HTTPS)
```

## Install on iPhone
Open the hosted HTTPS URL in Safari → Share → **Add to Home Screen**.
(PWA install and service workers require HTTPS, except on `localhost`.)

## CORS and mixed content (read this)
Browsers only let a web page read playlists / EPG / segments from servers that send CORS headers. Most IPTV providers don't.
Also, an HTTPS-hosted page cannot load `http://` streams (mixed content). Solutions:

1. Run the optional proxy on a machine you control (LAN box, VPS, Pi):
   ```bash
   node proxy/server.mjs                 # PORT=8787, optional ALLOW_HOSTS=provider.example.com
   ```
2. In the app: Settings → Proxy dropdown → "Local proxy" (http://localhost:8787) or "Custom URL" (`http://<proxy-host>:8787/?url=`)
   and tick "Also route video streams through the proxy" if streams fail.
   For use from an HTTPS-hosted app put the proxy behind HTTPS too (Caddy/nginx/Cloudflare Tunnel).

The proxy rewrites `.m3u8` manifests so segments are fetched through it. It has no authentication: do not expose it publicly
without restricting `ALLOW_HOSTS` and adding auth at the reverse proxy.
Notes: native iOS Safari playback of non-HLS (raw `.ts`) streams generally does not work.

## Not yet implemented
Recording, multiview, parental PIN, catch-up, reminders (see ../docs/FEATURES.md).

## Hosting over HTTPS
- **GitHub Pages:** `.github/workflows/pages.yml` deploys `web/dist` on push. Pages needs a public repo (or a paid plan for private repos).
  Enable with Settings → Pages → Source: GitHub Actions. Pages hosts only the app; you still need an HTTPS proxy for provider URLs.
- **Single origin (recommended for testing):** `npm run build && STATIC_DIR=dist PORT=8787 node proxy/server.mjs` serves the app *and* the proxy
  from one origin; the app auto-detects it and enables the proxy. Put any HTTPS tunnel/reverse proxy in front (Cloudflare Tunnel, Caddy, Tailscale Funnel) and open that URL in iPhone Safari.

## Proxy dropdown (Settings)

One selection fixes CORS / mixed content: **None (direct)**, **TVmate Cloudflare Worker** (recommended; deploy `proxy-worker/` from the
main repo, then paste its access token once; it is stored only in this browser's localStorage and is never part of the source or bundle),
**Local proxy** (`http://localhost:8787`, `node proxy/server.mjs`; not usable from iPhone Safari on an HTTPS page) and **Custom URL** (+ optional token).
"Test proxy" checks the Worker `/health` and a token-checked HEAD relay of a public HLS playlist. Public CORS proxies (corsproxy.io, allorigins, ...)
are intentionally not offered: they log traffic and often break streams.
