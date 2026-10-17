import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILES, activeNetwork, clampBuffer, detectNetwork, levelCapIndex,
  preferHlsChannels, preferHlsPlaylistUrl, preferHlsUrl, sanitizeProfiles, validateSource,
} from "../src/profiles";
import type { Channel } from "../src/types";

const ch = (name: string, url: string, extra: Partial<Channel> = {}): Channel =>
  ({ id: name + url, name, url, group: "G", ...extra });

describe("buffer + profiles", () => {
  it("clamps to 5..60", () => {
    expect(clampBuffer(1)).toBe(5);
    expect(clampBuffer(999)).toBe(60);
    expect(clampBuffer(NaN)).toBe(15);
    expect(clampBuffer(25.4)).toBe(25);
  });
  it("defaults: wifi 15s auto, mobile 25s 720p", () => {
    expect(DEFAULT_PROFILES.wifi).toEqual({ bufferSec: 15, cap: "auto" });
    expect(DEFAULT_PROFILES.mobile).toEqual({ bufferSec: 25, cap: "720" });
  });
  it("sanitizes junk", () => {
    const p = sanitizeProfiles({ wifi: { bufferSec: 500, cap: "4k" as never }, mobile: undefined });
    expect(p.wifi).toEqual({ bufferSec: 60, cap: "auto" });
    expect(p.mobile).toEqual(DEFAULT_PROFILES.mobile);
  });
});

describe("network detection", () => {
  it("cellular / slow / saveData -> mobile", () => {
    expect(detectNetwork({ type: "cellular" })).toBe("mobile");
    expect(detectNetwork({ effectiveType: "3g" })).toBe("mobile");
    expect(detectNetwork({ saveData: true })).toBe("mobile");
  });
  it("wifi, ethernet, 4g, unknown -> wifi", () => {
    expect(detectNetwork({ type: "wifi" })).toBe("wifi");
    expect(detectNetwork({ type: "ethernet" })).toBe("wifi");
    expect(detectNetwork({ effectiveType: "4g" })).toBe("wifi");
    expect(detectNetwork(undefined)).toBe("wifi");
  });
  it("manual override wins", () => {
    expect(activeNetwork("mobile", { type: "wifi" })).toBe("mobile");
    expect(activeNetwork("wifi", { type: "cellular" })).toBe("wifi");
    expect(activeNetwork("auto", { type: "cellular" })).toBe("mobile");
  });
});

describe("quality cap", () => {
  const levels = [{ height: 360 }, { height: 720 }, { height: 480 }, { height: 1080 }];
  it("auto = no cap", () => expect(levelCapIndex(levels, "auto")).toBe(-1));
  it("picks the tallest level under the cap", () => {
    expect(levelCapIndex(levels, "480")).toBe(2);
    expect(levelCapIndex(levels, "720")).toBe(1);
    expect(levelCapIndex(levels, "1080")).toBe(3);
  });
  it("falls back to the lowest when nothing fits", () => {
    expect(levelCapIndex([{ height: 1080 }, { height: 720 }], "480")).toBe(1);
  });
});

describe("prefer HLS", () => {
  it("rewrites xtream .ts to .m3u8", () => {
    expect(preferHlsUrl("http://h:80/live/u/p/123.ts")).toBe("http://h:80/live/u/p/123.m3u8");
    expect(preferHlsUrl("http://h/live/u/p/123.ts?x=1")).toBe("http://h/live/u/p/123.m3u8?x=1");
    expect(preferHlsUrl("http://h/other/stream.ts")).toBe("http://h/other/stream.ts");
  });
  it("asks Xtream playlists for m3u8 output", () => {
    expect(preferHlsPlaylistUrl("http://h/get.php?username=a&password=b&type=m3u_plus&output=ts"))
      .toBe("http://h/get.php?username=a&password=b&type=m3u_plus&output=m3u8");
    expect(preferHlsPlaylistUrl("http://h/list.m3u")).toBe("http://h/list.m3u");
  });
  it("drops the ts twin when an m3u8 variant exists, keeps lone ts", () => {
    const out = preferHlsChannels([
      ch("BBC", "http://h/bbc.ts", { tvgId: "bbc" }),
      ch("BBC", "http://h/bbc.m3u8", { tvgId: "bbc" }),
      ch("ITV", "http://h/itv.ts", { tvgId: "itv" }),
    ]);
    expect(out.map((c) => c.url)).toEqual(["http://h/bbc.m3u8", "http://h/itv.ts"]);
  });
});

describe("validateSource (Save without test)", () => {
  it("accepts good m3u/xtream", () => {
    expect(validateSource({ kind: "m3u", name: "n", url: "https://a/b.m3u" })).toBeNull();
    expect(validateSource({ kind: "xtream", name: "n", server: "http://h:8080", user: "u", pass: "p" })).toBeNull();
  });
  it("rejects bad fields with a message", () => {
    expect(validateSource({ kind: "m3u", name: "n", url: "nope" })).toMatch(/URL/);
    expect(validateSource({ kind: "xtream", name: "n", server: "x", user: "u", pass: "p" })).toMatch(/server/i);
    expect(validateSource({ kind: "xtream", name: "n", server: "http://h", user: "", pass: "p" })).toMatch(/Username/);
    expect(validateSource({ kind: "xtream", name: "n", server: "http://h", user: "u", pass: "" })).toMatch(/Password/);
  });
});

import { buildProxied, normalizeProxyPrefix } from "../src/profiles";
describe("video proxy url", () => {
  it("normalises worker URLs to a ?url= prefix", () => {
    expect(normalizeProxyPrefix("")).toBe("");
    expect(normalizeProxyPrefix("https://w.dev")).toBe("https://w.dev/?url=");
    expect(normalizeProxyPrefix("https://w.dev/")).toBe("https://w.dev/?url=");
    expect(normalizeProxyPrefix("https://w.dev/?url=")).toBe("https://w.dev/?url=");
    expect(normalizeProxyPrefix("https://w.dev/?")).toBe("https://w.dev/?url=");
  });
  it("builds proxied URLs with optional token", () => {
    expect(buildProxied("https://w.dev", "", "http://h/a.m3u8?x=1")).toBe("https://w.dev/?url=http%3A%2F%2Fh%2Fa.m3u8%3Fx%3D1");
    expect(buildProxied("https://w.dev/?url=", " t/1 ", "http://h/a")).toBe("https://w.dev/?url=http%3A%2F%2Fh%2Fa&token=t%2F1");
    expect(buildProxied("", "t", "http://h/a")).toBe("http://h/a");
  });
});
