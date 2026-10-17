import { describe, expect, it } from "vitest";
import { describeFailure, hostOf, isFormatRelated } from "../src/diag";
import { xtreamAlternate } from "../src/profiles";

describe("xtreamAlternate", () => {
  it("swaps m3u8 <-> ts for Xtream live URLs and keeps the query", () => {
    expect(xtreamAlternate("http://p.tv:8080/live/u/p/123.m3u8")).toEqual({ url: "http://p.tv:8080/live/u/p/123.ts", from: "m3u8", to: "ts" });
    expect(xtreamAlternate("http://p.tv/live/u/p/9.TS?x=1")).toEqual({ url: "http://p.tv/live/u/p/9.m3u8?x=1", from: "ts", to: "m3u8" });
  });
  it("ignores other URLs", () => {
    expect(xtreamAlternate("http://p.tv/stream/abc.m3u8")).toBeNull();
    expect(xtreamAlternate("http://p.tv/movie/u/p/1.mp4")).toBeNull();
  });
});

describe("failure description", () => {
  it("format-related only for HTTP errors and unparsable playlists", () => {
    expect(isFormatRelated(404, "manifestLoadError")).toBe(true);
    expect(isFormatRelated(undefined, "manifestParsingError")).toBe(true);
    expect(isFormatRelated(undefined, "manifestLoadTimeOut")).toBe(false);
    expect(isFormatRelated(200, "fragParsingError")).toBe(false);
  });
  const ctx = { targetHost: "prov.tv", net: "mobile" as const, cap: "720", bufferSec: 25 };
  it("includes status, route, format and profile", () => {
    const s = describeFailure({ status: 404, detail: "manifestLoadError", formatRelated: true },
      { ...ctx, proxyHost: "w.dev", format: "ts", fellBackFrom: "m3u8" });
    expect(s).toBe("HTTP 404 | via proxy w.dev -> prov.tv | format ts (m3u8 failed first) | Mobile data saver, cap 720, 25 s buffer");
  });
  it("explains a status-less failure", () => {
    const s = describeFailure({ detail: "manifestLoadError", formatRelated: false }, { ...ctx, net: "wifi", bufferSec: 15 });
    expect(s).toMatch(/^no HTTP response \(manifestLoadError\).*CORS.*\| direct to prov\.tv \| Wi-Fi, cap 720, 15 s buffer$/);
  });
  it("hostOf is safe", () => { expect(hostOf("http://a.b:80/x")).toBe("a.b"); expect(hostOf("nope")).toBe("?"); });
});
