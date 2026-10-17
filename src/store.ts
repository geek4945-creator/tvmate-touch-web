import type { Channel, Programme, Settings, Source } from "./types";
import { DEFAULT_PROFILES, sanitizeProfiles } from "./profiles";

const get = <T>(k: string, d: T): T => {
  try { const v = localStorage.getItem("tm." + k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
};
const set = (k: string, v: unknown) => {
  try { localStorage.setItem("tm." + k, JSON.stringify(v)); } catch { /* quota: ignore */ }
};

export const store = {
  source: () => get<Source | null>("source", null),
  setSource: (s: Source | null) => set("source", s),
  channels: () => get<Channel[]>("channels", []),
  setChannels: (c: Channel[]) => set("channels", c),
  favorites: () => new Set(get<string[]>("favs", [])),
  setFavorites: (f: Set<string>) => set("favs", [...f]),
  settings: (): Settings => {
    const s = get<Partial<Settings>>("settings", {});
    return {
      proxy: s.proxy ?? "", proxyStreams: s.proxyStreams ?? false, proxyToken: s.proxyToken ?? "", epgHours: s.epgHours ?? 12,
      netMode: s.netMode ?? "auto", profiles: sanitizeProfiles(s.profiles ?? DEFAULT_PROFILES),
    };
  },
  setSettings: (s: Settings) => set("settings", s),
  last: () => get<string | null>("last", null),
  setLast: (id: string) => set("last", id),
  epg: () => get<Programme[]>("epg", []),
  setEpg: (p: Programme[]) => set("epg", p),
};
