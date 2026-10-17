import type { Channel, Programme } from "./types";

export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function parseM3U(text: string): { channels: Channel[]; epgUrl?: string } {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  let epgUrl: string | undefined;
  let cur: Partial<Channel> | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTM3U")) {
      const m = /(?:url-tvg|x-tvg-url)="([^"]+)"/i.exec(line);
      if (m) epgUrl = m[1].split(",")[0];
    } else if (line.startsWith("#EXTINF")) {
      const attr = (k: string) => new RegExp(k + '="([^"]*)"', "i").exec(line)?.[1];
      const name = line.slice(line.lastIndexOf(",") + 1).trim();
      cur = {
        name: name || attr("tvg-name") || "Channel",
        logo: attr("tvg-logo") || undefined,
        group: attr("group-title") || "Ungrouped",
        tvgId: attr("tvg-id") || undefined,
        num: Number(attr("tvg-chno")) || undefined,
      };
    } else if (line.startsWith("#EXTGRP:") && cur) {
      cur.group = line.slice(8).trim() || cur.group;
    } else if (!line.startsWith("#") && cur) {
      channels.push({ ...(cur as Channel), url: line, id: hash((cur.tvgId || "") + cur.name + line) });
      cur = null;
    }
  }
  return { channels, epgUrl };
}

/** Parse XMLTV timestamps like 20261016180000 +0200 */
export function parseXmltvTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s.trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se, tz] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0));
  if (tz) {
    const sign = tz[0] === "-" ? -1 : 1;
    t -= sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) * 60000;
  }
  return t;
}

export function parseXMLTV(xml: string, wanted: Set<string>, from: number, to: number): Programme[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const out: Programme[] = [];
  doc.querySelectorAll("programme").forEach((p) => {
    const ch = p.getAttribute("channel") || "";
    if (!wanted.has(ch)) return;
    const start = parseXmltvTime(p.getAttribute("start") || "");
    const stop = parseXmltvTime(p.getAttribute("stop") || "");
    if (!isFinite(start) || !isFinite(stop) || stop < from || start > to) return;
    out.push({
      channel: ch, start, stop,
      title: p.querySelector("title")?.textContent || "",
      desc: p.querySelector("desc")?.textContent || undefined,
    });
  });
  return out.sort((a, b) => a.start - b.start);
}
