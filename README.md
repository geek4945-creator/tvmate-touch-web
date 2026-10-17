# TVmate Touch Web (PWA)

**Live:** https://geek4945-creator.github.io/tvmate-touch-web/ · open in iPhone Safari → Share → Add to Home Screen.

> Bring your own playlist: this app ships no channels. Use it only with content you are entitled to watch.


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
2. In the app: Settings → Proxy URL = `http://<proxy-host>:8787/?url=`
   and tick "Also route video streams through the proxy" if streams fail.
   For use from an HTTPS-hosted app put the proxy behind HTTPS too (Caddy/nginx/Cloudflare Tunnel).

The proxy rewrites `.m3u8` manifests so segments are fetched through it. It has no authentication: do not expose it publicly
without restricting `ALLOW_HOSTS` and adding auth at the reverse proxy.
Notes: native iOS Safari playback of non-HLS (raw `.ts`) streams generally does not work.

## Limits of a hosted, proxy-less web app
- Providers that send no CORS headers cannot be read from the browser; plain `http://` providers are blocked on this HTTPS site (mixed content). The app shows a clear message and a Proxy URL setting for a proxy you host.
- Playlist, favorites and settings stay in your browser's local storage.

## Not yet implemented
Recording, multiview, parental PIN, catch-up, reminders.

## License
MIT (see LICENSE). Original code; not affiliated with any commercial IPTV player.

## Hosting over HTTPS
- **GitHub Pages:** `.github/workflows/pages.yml` builds and deploys `dist` on every push to `main` (Settings → Pages → Source: GitHub Actions). Vite `base` is `./`, so it works under any sub-path. Pages hosts only the app; provider URLs may need an HTTPS proxy.
- **Single origin (recommended for testing):** `npm run build && STATIC_DIR=dist PORT=8787 node proxy/server.mjs` serves the app *and* the proxy
  from one origin; the app auto-detects it and enables the proxy. Put any HTTPS tunnel/reverse proxy in front (Cloudflare Tunnel, Caddy, Tailscale Funnel) and open that URL in iPhone Safari.
