import type { Channel, Source } from "./types";

export type QualityCap = "auto" | "480" | "720" | "1080";
export type NetMode = "auto" | "wifi" | "mobile";
export interface Profile { bufferSec: number; cap: QualityCap }
export interface Profiles { wifi: Profile; mobile: Profile }

export const BUFFER_MIN = 5;
export const BUFFER_MAX = 60;

/** "Wi-Fi": ~15 s buffer, no cap. "Mobile data saver": ~25 s buffer (rides out signal dips), 720p cap. */
export const DEFAULT_PROFILES: Profiles = {
  wifi: { bufferSec: 15, cap: "auto" },
  mobile: { bufferSec: 25, cap: "720" },
};

export const clampBuffer = (n: number): number =>
  Math.min(BUFFER_MAX, Math.max(BUFFER_MIN, Math.round(Number.isFinite(n) ? n : 15)));

export function sanitizeProfiles(p: Partial<Profiles> | undefined): Profiles {
  const caps: QualityCap[] = ["auto", "480", "720", "1080"];
  const fix = (x: Partial<Profile> | undefined, d: Profile): Profile => ({
    bufferSec: clampBuffer(x?.bufferSec ?? d.bufferSec),
    cap: caps.includes(x?.cap as QualityCap) ? (x!.cap as QualityCap) : d.cap,
  });
  return { wifi: fix(p?.wifi, DEFAULT_PROFILES.wifi), mobile: fix(p?.mobile, DEFAULT_PROFILES.mobile) };
}

interface ConnLike { type?: string; effectiveType?: string; saveData?: boolean }

/** Browser network class. Safari/iOS has no navigator.connection, so it falls back to Wi-Fi (use the manual override). */
export function detectNetwork(conn: ConnLike | undefined | null): "wifi" | "mobile" {
  if (!conn) return "wifi";
  if (conn.type === "cellular") return "mobile";
  if (conn.type === "wifi" || conn.type === "ethernet") return "wifi";
  if (conn.saveData) return "mobile";
  if (conn.effectiveType && /^(slow-2g|2g|3g)$/.test(conn.effectiveType)) return "mobile";
  return "wifi";
}

export function activeNetwork(mode: NetMode, conn: ConnLike | undefined | null): "wifi" | "mobile" {
  return mode === "auto" ? detectNetwork(conn) : mode;
}

export const capHeight = (cap: QualityCap): number => (cap === "auto" ? Infinity : Number(cap));

/** Highest level index whose height fits under the cap (levels need not be sorted). -1 = no cap. */
export function levelCapIndex(levels: { height?: number; bitrate?: number }[], cap: QualityCap): number {
  if (cap === "auto" || levels.length === 0) return -1;
  const max = capHeight(cap);
  let best = -1;
  let bestH = -1;
  let lowest = 0;
  levels.forEach((l, i) => {
    const h = l.height || 0;
    if (h > 0 && h <= max && h >= bestH) { best = i; bestH = h; }
    if ((l.height || Infinity) < (levels[lowest].height || Infinity)) lowest = i;
  });
  // Nothing fits (e.g. only 1080p offered, cap 480): use the lowest variant rather than fail.
  return best >= 0 ? best : lowest;
}

// ---------- prefer HLS ----------
const XTREAM_TS = /^(.*\/live\/[^/]+\/[^/]+\/\d+)\.ts(\?.*)?$/i;
export const isHls = (u: string) => /\.m3u8(\?|$)/i.test(u);

/** Xtream-style `/live/u/p/123.ts` -> `.m3u8` (Safari cannot play raw TS). Other URLs are untouched. */
export function preferHlsUrl(url: string): string {
  const m = XTREAM_TS.exec(url);
  return m ? `${m[1]}.m3u8${m[2] ?? ""}` : url;
}

/** Xtream get.php playlists: ask the server for m3u8 output. */
export function preferHlsPlaylistUrl(url: string): string {
  return /[?&]output=ts\b/i.test(url) ? url.replace(/([?&]output=)ts\b/i, "$1m3u8") : url;
}

const XTREAM_LIVE = /^(.*\/live\/[^/]+\/[^/]+\/\d+)\.(ts|m3u8)(\?.*)?$/i;
/** The other Xtream live output format for the same channel (m3u8 <-> ts), or null for non-Xtream URLs. */
export function xtreamAlternate(url: string): { url: string; from: "ts" | "m3u8"; to: "ts" | "m3u8" } | null {
  const m = XTREAM_LIVE.exec(url);
  if (!m) return null;
  const from = m[2].toLowerCase() as "ts" | "m3u8";
  const to = from === "ts" ? "m3u8" : "ts";
  return { url: `${m[1]}.${to}${m[3] ?? ""}`, from, to };
}

const keyOf = (c: Channel) => (c.tvgId ? "id:" + c.tvgId : "n:" + c.name.trim().toLowerCase());

/** Rewrites Xtream TS URLs, then drops a .ts/other variant when the same channel also has an .m3u8 entry. */
export function preferHlsChannels(channels: Channel[]): Channel[] {
  const mapped = channels.map((c) => ({ ...c, url: preferHlsUrl(c.url) }));
  const hasHls = new Set<string>();
  for (const c of mapped) if (isHls(c.url)) hasHls.add(keyOf(c) + "|" + c.group);
  return mapped.filter((c) => isHls(c.url) || !hasHls.has(keyOf(c) + "|" + c.group));
}

// ---------- save-without-test validation ----------
export function validateSource(src: Source): string | null {
  const isHttp = (u: string) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
  if (src.kind === "m3u") return isHttp(src.url) ? null : "Enter a valid http(s) playlist URL.";
  if (!isHttp(src.server)) return "Enter a valid server URL (http://host:port).";
  if (!src.user.trim()) return "Username is required.";
  if (!src.pass) return "Password is required.";
  return null;
}

// ---------- video proxy (Cloudflare Worker or any ?url= proxy) ----------
/** Accepts "https://w.example", "https://w.example/" or "https://w.example/?url=" and returns a prefix ending in "url=". */
export function normalizeProxyPrefix(p: string): string {
  const t = p.trim();
  if (!t) return "";
  if (/url=$/i.test(t)) return t;
  return t.replace(/[?&]+$/, "").replace(/\/+$/, "") + "/?url=";
}

export function buildProxied(proxy: string, token: string, url: string): string {
  const prefix = normalizeProxyPrefix(proxy);
  if (!prefix) return url;
  return prefix + encodeURIComponent(url) + (token.trim() ? "&token=" + encodeURIComponent(token.trim()) : "");
}
