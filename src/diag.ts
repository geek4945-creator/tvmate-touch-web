/** Playback failure description shared by the player and the UI. */
export interface PlayFailure {
  /** HTTP status from the server (or proxy) when there was a response. */
  status?: number;
  /** hls.js / mpegts.js error detail, e.g. manifestLoadError. */
  detail: string;
  /** True when the failure could be fixed by trying the other container (HTTP error, unparsable playlist). */
  formatRelated: boolean;
}

export interface DiagCtx {
  proxyHost?: string;
  targetHost: string;
  format?: string;
  fellBackFrom?: string;
  net: "wifi" | "mobile";
  cap: string;
  bufferSec: number;
  note?: string;
}

export const hostOf = (u: string): string => { try { return new URL(u).hostname; } catch { return "?"; } };

export function isFormatRelated(status: number | undefined, detail: string): boolean {
  if (status !== undefined && status >= 400) return true;
  return /manifestParsingError|manifestIncompatible|levelEmptyError|manifestLoadError.*404/i.test(detail);
}

/** e.g. `HTTP 404 | via proxy tvmate-proxy.x.workers.dev -> prov.tv | format ts (m3u8 failed first) | Mobile data saver, cap 720p, 15 s buffer` */
export function describeFailure(f: PlayFailure, c: DiagCtx): string {
  const parts: string[] = [];
  parts.push(f.status !== undefined && f.status > 0
    ? `HTTP ${f.status}`
    : `no HTTP response (${f.detail}): blocked by CORS or mixed content, offline, or the provider is unreachable`);
  parts.push(c.proxyHost ? `via proxy ${c.proxyHost} -> ${c.targetHost}` : `direct to ${c.targetHost}`);
  if (c.format) parts.push(`format ${c.format}` + (c.fellBackFrom ? ` (${c.fellBackFrom} failed first)` : ""));
  parts.push(`${c.net === "mobile" ? "Mobile data saver" : "Wi-Fi"}, cap ${c.cap}, ${c.bufferSec} s buffer`);
  if (c.note) parts.push(c.note);
  return parts.join(" | ");
}
