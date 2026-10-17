import { buildProxied } from "./profiles";
import type { Settings } from "./types";

export type ProxyMode = "none" | "worker" | "local" | "custom";

/** Public URL of the TVmate Cloudflare Worker. The access token is NEVER part of the source: users type it in Settings. */
export const WORKER_URL = "https://tvmate-proxy.geek4945.workers.dev";
export const LOCAL_URL = "http://localhost:8787";
/** Small public HLS test playlist used by "Test proxy". */
export const PROXY_TEST_TARGET = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

const norm = (u: string) => u.trim().replace(/\/?\?url=$/i, "").replace(/\/+$/, "").toLowerCase();

/** Derive the dropdown choice from a legacy single "proxy" URL. */
export function inferMode(proxy: string): ProxyMode {
  const p = norm(proxy);
  if (!p) return "none";
  if (p === norm(WORKER_URL)) return "worker";
  if (p === norm(LOCAL_URL) || p === "http://127.0.0.1:8787") return "local";
  return "custom";
}

export interface Resolved { mode: ProxyMode; base: string; token: string; needsToken: boolean }

/** What the app should actually route through. `base` is "" when requests should go direct. */
export function resolveProxy(s: Pick<Settings, "proxyMode" | "proxy" | "proxyToken" | "workerToken">): Resolved {
  switch (s.proxyMode) {
    case "worker":
      return s.workerToken.trim()
        ? { mode: "worker", base: WORKER_URL, token: s.workerToken.trim(), needsToken: false }
        : { mode: "worker", base: "", token: "", needsToken: true }; // not usable until the token is entered
    case "local":
      return { mode: "local", base: LOCAL_URL, token: "", needsToken: false };
    case "custom":
      return { mode: "custom", base: s.proxy.trim(), token: s.proxyToken.trim(), needsToken: false };
    default:
      return { mode: "none", base: "", token: "", needsToken: false };
  }
}

export interface ProxyTestResult { ok: boolean; message: string }
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Checks that the selected proxy is reachable, accepts the token, and can relay a public HLS playlist. */
export async function testProxy(s: Settings, fetchFn: FetchFn = (i, o) => fetch(i, o)): Promise<ProxyTestResult> {
  const r = resolveProxy(s);
  if (r.mode === "none") return { ok: true, message: "No proxy selected: requests go direct from the browser." };
  if (r.needsToken) return { ok: false, message: "Enter the Worker access token first." };
  if (!r.base) return { ok: false, message: "Enter the proxy URL first." };
  if (!/^https?:\/\//i.test(r.base)) return { ok: false, message: "The proxy URL must start with http:// or https://." };

  if (r.mode === "worker") {
    try {
      const h = await fetchFn(WORKER_URL + "/health", { cache: "no-store" });
      if (!h.ok || (await h.text()).trim() !== "ok") return { ok: false, message: `Worker answered HTTP ${h.status} on /health.` };
    } catch {
      return { ok: false, message: "Cannot reach the Worker (offline, blocked network, or the Worker was removed)." };
    }
  }
  try {
    const res = await fetchFn(buildProxied(r.base, r.token, PROXY_TEST_TARGET), { method: "HEAD", cache: "no-store" });
    if (res.status === 401) return { ok: false, message: "The proxy rejected the access token (HTTP 401)." };
    if (res.status === 403) return { ok: false, message: "The proxy refused the test target (HTTP 403)." };
    if (!res.ok) return { ok: false, message: `The proxy answered HTTP ${res.status} for the test playlist.` };
    return { ok: true, message: r.mode === "worker" ? "OK: Worker reachable, token accepted, relay works." : "OK: proxy relayed the test playlist." };
  } catch {
    return {
      ok: false,
      message: r.mode === "local"
        ? "Cannot reach http://localhost:8787. Start it with `node proxy/server.mjs` on this device (Safari/iPhone cannot use localhost from an HTTPS page)."
        : "Cannot reach the proxy (offline, wrong URL, or it sends no CORS headers).",
    };
  }
}
