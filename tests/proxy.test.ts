import { describe, expect, it } from "vitest";
import { LOCAL_URL, PROXY_TEST_TARGET, WORKER_URL, inferMode, resolveProxy, testProxy } from "../src/proxy";
import { viaProxy } from "../src/net";
import { DEFAULT_PROFILES } from "../src/profiles";
import type { Settings } from "../src/types";

const base: Settings = {
  proxyMode: "none", proxy: "", workerToken: "", proxyToken: "", proxyStreams: false, epgHours: 12, netMode: "auto", profiles: DEFAULT_PROFILES,
};
const S = (o: Partial<Settings>): Settings => ({ ...base, ...o });
const res = (status: number, body = "") => new Response(body, { status });

describe("inferMode (legacy single proxy URL)", () => {
  it("maps URLs onto the dropdown", () => {
    expect(inferMode("")).toBe("none");
    expect(inferMode(WORKER_URL)).toBe("worker");
    expect(inferMode(WORKER_URL + "/?url=")).toBe("worker");
    expect(inferMode("http://localhost:8787/?url=")).toBe("local");
    expect(inferMode("https://my.proxy/?url=")).toBe("custom");
  });
});

describe("resolveProxy / viaProxy", () => {
  it("none and unconfigured worker go direct", () => {
    expect(resolveProxy(S({})).base).toBe("");
    const w = resolveProxy(S({ proxyMode: "worker" }));
    expect(w.base).toBe("");
    expect(w.needsToken).toBe(true);
    expect(viaProxy("https://p.tv/a.m3u8", S({ proxyMode: "worker" }))).toBe("https://p.tv/a.m3u8");
  });
  it("worker uses its own token, not the custom one", () => {
    const s = S({ proxyMode: "worker", workerToken: " wt ", proxyToken: "custom" });
    expect(viaProxy("http://p.tv/a", s)).toBe(`${WORKER_URL}/?url=http%3A%2F%2Fp.tv%2Fa&token=wt`);
  });
  it("local has no token and custom uses its URL + token", () => {
    expect(viaProxy("http://p.tv/a", S({ proxyMode: "local", workerToken: "x" }))).toBe(`${LOCAL_URL}/?url=http%3A%2F%2Fp.tv%2Fa`);
    expect(viaProxy("http://p.tv/a", S({ proxyMode: "custom", proxy: "https://c.io", proxyToken: "k" }))).toBe("https://c.io/?url=http%3A%2F%2Fp.tv%2Fa&token=k");
  });
  it("streams only go through the proxy when proxyStreams is on", () => {
    const s = S({ proxyMode: "local" });
    expect(viaProxy("http://p.tv/s.m3u8", s, true)).toBe("http://p.tv/s.m3u8");
    expect(viaProxy("http://p.tv/s.m3u8", { ...s, proxyStreams: true }, true)).toContain(LOCAL_URL);
  });
});

describe("testProxy", () => {
  it("none is trivially ok; missing token/url explained", async () => {
    expect((await testProxy(S({}))).ok).toBe(true);
    expect((await testProxy(S({ proxyMode: "worker" }))).message).toMatch(/token/i);
    expect((await testProxy(S({ proxyMode: "custom" }))).message).toMatch(/url/i);
  });
  it("worker: health then token-checked HEAD", async () => {
    const calls: string[] = [];
    const ok = await testProxy(S({ proxyMode: "worker", workerToken: "t" }), async (u, o) => {
      calls.push(`${o?.method ?? "GET"} ${u}`);
      return u.endsWith("/health") ? res(200, "ok") : res(200);
    });
    expect(ok.ok).toBe(true);
    expect(calls[0]).toBe(`GET ${WORKER_URL}/health`);
    expect(calls[1]).toBe(`HEAD ${WORKER_URL}/?url=${encodeURIComponent(PROXY_TEST_TARGET)}&token=t`);
  });
  it("worker: 401 means bad token; unreachable health is reported", async () => {
    const bad = await testProxy(S({ proxyMode: "worker", workerToken: "t" }), async (u) => (u.endsWith("/health") ? res(200, "ok") : res(401)));
    expect(bad).toEqual({ ok: false, message: expect.stringMatching(/token/i) });
    const down = await testProxy(S({ proxyMode: "worker", workerToken: "t" }), async () => { throw new TypeError("fail"); });
    expect(down.ok).toBe(false);
    expect(down.message).toMatch(/reach/i);
  });
  it("local and custom do a HEAD through the proxy", async () => {
    const seen: string[] = [];
    const f = async (u: string) => { seen.push(u); return res(200); };
    expect((await testProxy(S({ proxyMode: "local" }), f)).ok).toBe(true);
    expect((await testProxy(S({ proxyMode: "custom", proxy: "https://c.io/?url=" }), f)).ok).toBe(true);
    expect(seen[0].startsWith(LOCAL_URL + "/?url=")).toBe(true);
    expect(seen[1].startsWith("https://c.io/?url=")).toBe(true);
    const err = await testProxy(S({ proxyMode: "local" }), async () => { throw new TypeError("x"); });
    expect(err.message).toMatch(/localhost:8787/);
  });
});
