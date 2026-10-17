export interface Channel {
  id: string;        // stable id (tvg-id or url hash)
  name: string;
  url: string;
  logo?: string;
  group: string;
  tvgId?: string;
  num?: number;
}
export interface Programme { channel: string; start: number; stop: number; title: string; desc?: string }
export type Source =
  | { kind: "m3u"; name: string; url: string; epgUrl?: string }
  | { kind: "xtream"; name: string; server: string; user: string; pass: string };
import type { NetMode, Profiles } from "./profiles";
export interface Settings { proxy: string; proxyStreams: boolean; epgHours: number; netMode: NetMode; profiles: Profiles }
