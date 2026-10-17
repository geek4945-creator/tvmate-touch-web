import type { Channel, Settings, Source } from "./types";
import { hash, parseM3U } from "./parse";
import { preferHlsChannels, preferHlsPlaylistUrl } from "./profiles";

export function viaProxy(url: string, s: Settings, isStream = false): string {
  if (!s.proxy || (isStream && !s.proxyStreams)) return url;
  return s.proxy + encodeURIComponent(url);
}

/** True when this page is HTTPS and the target is plain http:// without a proxy: browsers block it (mixed content). */
export function isMixedContent(url: string, s: Settings, isStream = false): boolean {
  return location.protocol === "https:" && /^http:\/\//i.test(viaProxy(url, s, isStream));
}

const MIXED_MSG =
  "Blocked: this app is served over HTTPS but the provider URL is plain http:// (mixed content). " +
  "Set a Proxy URL in Settings (your own HTTPS proxy, see README), or use an https:// provider URL.";
const CORS_MSG =
  "The browser blocked the request (most likely CORS: the provider does not allow web pages to read it, " +
  "or the server is unreachable). Set a Proxy URL in Settings to route requests through a proxy you host. See README.";
export { MIXED_MSG, CORS_MSG };

async function fetchText(url: string, s: Settings): Promise<string> {
  if (isMixedContent(url, s)) throw new Error(MIXED_MSG);
  let res: Response;
  try {
    res = await fetch(viaProxy(url, s));
  } catch (e) {
    throw new Error(CORS_MSG);
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

export interface Loaded { channels: Channel[]; epgUrl?: string }

export async function loadSource(src: Source, s: Settings): Promise<Loaded> {
  if (src.kind === "m3u") {
    const { channels, epgUrl } = parseM3U(await fetchText(preferHlsPlaylistUrl(src.url), s));
    return { channels: preferHlsChannels(channels), epgUrl: src.epgUrl || epgUrl };
  }
  const base = src.server.replace(/\/+$/, "");
  const q = `username=${encodeURIComponent(src.user)}&password=${encodeURIComponent(src.pass)}`;
  const api = `${base}/player_api.php?${q}`;
  const [cats, streams] = await Promise.all([
    fetchText(`${api}&action=get_live_categories`, s).then((t) => JSON.parse(t) as { category_id: string; category_name: string }[]),
    fetchText(`${api}&action=get_live_streams`, s).then((t) => JSON.parse(t) as any[]),
  ]);
  const names = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
  const channels: Channel[] = streams.map((x) => ({
    id: hash("x" + x.stream_id),
    name: x.name,
    logo: x.stream_icon || undefined,
    group: names.get(String(x.category_id)) || "Ungrouped",
    tvgId: x.epg_channel_id || undefined,
    num: x.num,
    url: `${base}/live/${encodeURIComponent(src.user)}/${encodeURIComponent(src.pass)}/${x.stream_id}.m3u8`,
  }));
  return { channels, epgUrl: `${base}/xmltv.php?${q}` };
}

export async function fetchEpgText(url: string, s: Settings): Promise<string> {
  if (isMixedContent(url, s)) throw new Error(MIXED_MSG);
  let res: Response;
  try { res = await fetch(viaProxy(url, s)); } catch { throw new Error(CORS_MSG); }
  if (!res.ok) throw new Error("EPG HTTP " + res.status);
  const gz = /\.gz(\?|$)/i.test(url) && res.body && "DecompressionStream" in window;
  if (gz) {
    const ds = (res.body as ReadableStream).pipeThrough(new (window as any).DecompressionStream("gzip"));
    return new Response(ds).text();
  }
  return res.text();
}
