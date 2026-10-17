// Optional tiny CORS proxy for playlists, EPG and HLS streams.
// Usage: node proxy/server.mjs   (PORT=8787 by default)
// Then in the app: Settings > Proxy URL = http://<host>:8787/?url=
// Only run this on a trusted LAN / behind auth: it fetches any URL it is given.
// Set ALLOW_HOSTS=host1,host2 to restrict targets.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// Optional: STATIC_DIR=dist also serves the built PWA from the same origin, so the app, the proxy and
// the streams share one HTTPS origin (no CORS, no mixed content) when put behind a TLS tunnel/reverse proxy.
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : "";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };

const PORT = Number(process.env.PORT || 8787);
const allow = (process.env.ALLOW_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);

http.createServer(async (req, res) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-expose-headers": "*",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  try {
    const reqUrl = new URL(req.url, "http://x");
    if (STATIC_DIR && reqUrl.pathname === "/__proxy") { res.writeHead(200, cors); return res.end("ok"); }
    const target = reqUrl.searchParams.get("url");
    if (STATIC_DIR && !target) {
      let f = path.join(STATIC_DIR, decodeURIComponent(reqUrl.pathname));
      if (!f.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
      return fs.createReadStream(f).pipe(res);
    }
    if (!target) { res.writeHead(400, cors); return res.end("missing ?url="); }
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol) || (allow.length && !allow.includes(u.hostname))) {
      res.writeHead(403, cors); return res.end("target not allowed");
    }
    const up = await fetch(u, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 TVmateTouchProxy" } });
    const headers = { ...cors, "content-type": up.headers.get("content-type") || "application/octet-stream" };
    res.writeHead(up.status, headers);
    const ct = headers["content-type"].toLowerCase();
    const isM3u8 = u.pathname.endsWith(".m3u8") || ct.includes("mpegurl");
    if (isM3u8) {
      // Rewrite relative/absolute URIs inside HLS manifests so segments also go through the proxy.
      const proto = req.headers["x-forwarded-proto"] || "http";
      const base = `${proto}://${req.headers.host}/?url=`;
      const text = await up.text();
      const out = text.split("\n").map((line) => {
        const t = line.trim();
        if (!t) return line;
        const wrap = (v) => base + encodeURIComponent(new URL(v, up.url).href);
        if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, v) => `URI="${wrap(v)}"`);
        return wrap(t);
      }).join("\n");
      return res.end(out);
    }
    if (!up.body) return res.end();
    for await (const chunk of up.body) { if (!res.write(chunk)) await new Promise((r) => res.once("drain", r)); }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, cors);
    res.end(String(e));
  }
}).listen(PORT, () => console.log(`proxy on :${PORT}`));
