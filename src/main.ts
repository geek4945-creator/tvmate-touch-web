import "./style.css";
import type { Channel, Programme, Settings, Source } from "./types";
import { store } from "./store";
import { describeFailure, hostOf, type PlayFailure } from "./diag";
import { WORKER_URL, resolveProxy, testProxy, type ProxyMode } from "./proxy";
import { MIXED_MSG, fetchEpgText, isMixedContent, loadSource, viaProxy } from "./net";
import { parseM3U, parseXMLTV } from "./parse";
import { Player, type PlayerState } from "./player";
import { BUFFER_MAX, BUFFER_MIN, activeNetwork, clampBuffer, preferHlsChannels, preferHlsUrl, validateSource, xtreamAlternate, type NetMode, type QualityCap } from "./profiles";

const conn = () => (navigator as unknown as { connection?: object }).connection as Parameters<typeof activeNetwork>[1];
const activeNet = () => activeNetwork(st.settings.netMode, conn());
const activeProfile = () => st.settings.profiles[activeNet()];

type Tab = "live" | "guide" | "favs" | "settings";
const PAGE = 150;
const PX_PER_MIN = 4;

const st = {
  tab: "live" as Tab,
  channels: store.channels(),
  favs: store.favorites(),
  settings: store.settings(),
  epg: store.epg(),
  group: "All",
  guideGroup: "",
  query: "",
  limit: PAGE,
  guideLimit: 40,
  cur: null as Channel | null,
  pstate: "closed" as PlayerState,
  status: "",
  statusErr: false,
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const app = document.getElementById("app")!;
app.innerHTML = `
  <header id="hdr"></header>
  <main id="main"></main>
  <div id="player">
    <video id="video"></video>
    <div class="ovl" id="ovl">
      <div class="row top miniHide">
        <button class="ib" data-a="minimize" title="Minimize">⌄</button>
        <div class="title" id="ptitle"></div>
        <button class="ib" data-a="pip" title="Picture in picture">⧉</button>
        <button class="ib" data-a="fs" title="Fullscreen">⛶</button>
      </div>
      <div class="row miniOnly" style="flex:1;min-width:0">
        <div class="title" id="mtitle" data-a="expand"></div>
      </div>
      <div class="row bot">
        <button class="ib" data-a="prev">⏮</button>
        <div class="sub" style="flex:1;text-align:center" id="psub">swipe ◀ ▶ to change channel</div>
        <button class="ib" data-a="next">⏭</button>
      </div>
      <button class="ib" data-a="toggle" id="pp">⏯</button>
      <button class="ib miniOnly" data-a="close">✕</button>
    </div>
    <div class="toast" id="toast"></div>
  </div>
  <nav id="nav">
    <button data-tab="live"><span class="i">📺</span>Live</button>
    <button data-tab="guide"><span class="i">▦</span>Guide</button>
    <button data-tab="favs"><span class="i">★</span>Favorites</button>
    <button data-tab="settings"><span class="i">⚙</span>Settings</button>
  </nav>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $("main"), hdr = $("hdr"), playerEl = $("player"), toastEl = $("toast");
const player = new Player($<HTMLVideoElement>("video"));
player.onFail = (f) => void onPlayFailure(f);

function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("on");
  setTimeout(() => toastEl.classList.remove("on"), 1400);
}

// ---------- derived data ----------
const groups = () => [...new Set(st.channels.map((c) => c.group))].sort((a, b) => a.localeCompare(b));
const progMap = (): Map<string, Programme[]> => {
  const m = new Map<string, Programme[]>();
  for (const p of st.epg) {
    let a = m.get(p.channel);
    if (!a) { a = []; m.set(p.channel, a); }
    a.push(p);
  }
  return m;
};
let pm = progMap();
const nowProg = (c: Channel): Programme | undefined => {
  if (!c.tvgId) return;
  const t = Date.now();
  return pm.get(c.tvgId)?.find((p) => p.start <= t && p.stop > t);
};
const visible = (): Channel[] => {
  let list = st.tab === "favs" ? st.channels.filter((c) => st.favs.has(c.id)) : st.channels;
  if (st.tab === "live" && st.group === "★ Favorites") list = list.filter((c) => st.favs.has(c.id));
  else if (st.tab === "live" && st.group !== "All") list = list.filter((c) => c.group === st.group);
  const q = st.query.trim().toLowerCase();
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
  return list;
};

// ---------- player control ----------
function setPState(s: PlayerState) {
  st.pstate = s;
  playerEl.className = s === "closed" ? "" : s;
  document.body.classList.toggle("playing-open", s === "open");
  document.body.classList.toggle("playing-mini", s === "mini");
  if (s === "closed") player.stop();
}
interface Attempt { ch: Channel; url: string; format?: string; fellBackFrom?: string; tried: string[] }
let attempt: Attempt | null = null;
const fmtOf = (u: string) => /\.m3u8(\?|$)/i.test(u) ? "m3u8" : /\.ts(\?|$)/i.test(u) ? "ts" : undefined;

function playAttempt(a: Attempt) {
  const prof = activeProfile();
  const routed = viaProxy(a.url, st.settings, true);
  if (a.format === "ts") {
    void player.playTs(routed).then((ok) => {
      if (!ok) showFailure({ detail: "raw TS is not supported in this browser", formatRelated: false }, "this browser cannot play raw TS (needs MSE; not iPhone Safari)");
    });
  } else {
    player.play(routed, { bufferSec: prof.bufferSec, cap: prof.cap });
  }
}

function showFailure(f: PlayFailure, note?: string) {
  const a = attempt;
  if (!a) return;
  const r = resolveProxy(st.settings);
  const routed = viaProxy(a.url, st.settings, true);
  const msg = describeFailure(f, {
    proxyHost: routed !== a.url ? hostOf(r.base) : undefined,
    targetHost: hostOf(a.url), format: a.format, fellBackFrom: a.fellBackFrom,
    net: activeNet(), cap: activeProfile().cap, bufferSec: activeProfile().bufferSec, note,
  });
  const el = document.getElementById("psub");
  if (el) { el.textContent = "Playback error: " + msg; el.classList.add("err"); }
  toast("Playback error: " + msg.split(" | ")[0]);
  console.warn("[tvmate] playback error:", msg);
}

async function onPlayFailure(f: PlayFailure) {
  const a = attempt;
  if (!a) return;
  // Prefer-HLS safety net: some Xtream panels do not serve /live/u/p/id.m3u8 (404). Try the other format once.
  const alt = f.formatRelated ? xtreamAlternate(a.url) : null;
  if (alt && !a.tried.includes(alt.to)) {
    a.tried.push(alt.to);
    a.fellBackFrom = alt.from;
    a.url = alt.url;
    a.format = alt.to;
    if (alt.to === "ts" && !(await tsPlayable())) {
      showFailure(f, `${alt.from} failed; the ts fallback needs a browser with MSE (not iPhone Safari)`);
      return;
    }
    playAttempt(a);
    return;
  }
  showFailure(f, a.fellBackFrom ? `${a.fellBackFrom} failed first, then ${a.format} failed` : undefined);
}
async function tsPlayable(): Promise<boolean> {
  try { const m: any = await import("mpegts.js"); return !!(m.default ?? m).isSupported(); } catch { return false; }
}

function tune(c: Channel) {
  if (isMixedContent(c.url, st.settings, true)) {
    alert(MIXED_MSG + "\n\nPick a proxy in Settings and tick 'Also route video streams through the proxy'.");
    return;
  }
  st.cur = c;
  store.setLast(c.id);
  const url = preferHlsUrl(c.url);
  attempt = { ch: c, url, format: fmtOf(url), tried: [fmtOf(url) ?? ""] };
  const sub = document.getElementById("psub");
  sub?.classList.remove("err");
  playAttempt(attempt);
  $("ptitle").textContent = c.name;
  $("mtitle").textContent = c.name;
  const np = nowProg(c);
  $("psub").textContent = np ? `${np.title} · ${fmt(np.start)}–${fmt(np.stop)}` : c.group;
  setPState("open");
  renderMain(false);
}
function step(dir: 1 | -1) {
  if (!st.cur) return;
  const list = st.tab === "live" || st.tab === "favs" ? visible() : st.channels;
  const base = list.length ? list : st.channels;
  const i = base.findIndex((c) => c.id === st.cur!.id);
  const n = base[(i + dir + base.length) % base.length];
  if (n) { tune(n); toast(n.name); }
}

playerEl.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("[data-a]")?.getAttribute("data-a");
  if (a === "minimize") setPState("mini");
  else if (a === "expand") setPState("open");
  else if (a === "close") setPState("closed");
  else if (a === "prev") step(-1);
  else if (a === "next") step(1);
  else if (a === "toggle") player.toggle();
  else if (a === "pip") player.pip();
  else if (a === "fs") player.fullscreen();
  else if (st.pstate === "mini") setPState("open");
});
// swipe gestures: left/right = channel change, down = minimize, up on mini = expand
{
  let x0 = 0, y0 = 0, t0 = 0;
  playerEl.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  playerEl.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Date.now() - t0 > 700) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    else if (dy > 60 && Math.abs(dy) > Math.abs(dx) * 1.5 && st.pstate === "open") setPState("mini");
    else if (dy < -40 && Math.abs(dy) > Math.abs(dx) && st.pstate === "mini") setPState("open");
  }, { passive: true });
}

// ---------- rendering ----------
function renderNav() {
  document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === st.tab));
}
function chRow(c: Channel): string {
  const np = nowProg(c);
  const fav = st.favs.has(c.id);
  return `<div class="ch ${st.cur?.id === c.id ? "cur" : ""}" data-ch="${c.id}">
    <div class="logo" style="${c.logo ? `background-image:url('${esc(c.logo)}')` : ""}"></div>
    <div class="meta"><div class="name">${c.num ? c.num + " · " : ""}${esc(c.name)}</div>
    <div class="now">${np ? esc(np.title) : esc(c.group)}</div></div>
    <button class="star ${fav ? "on" : ""}" data-fav="${c.id}" aria-label="Favorite">${fav ? "★" : "☆"}</button></div>`;
}

function renderMain(resetScroll = true) {
  renderNav();
  const sc = main.scrollTop;
  if (st.tab === "settings") renderSettings();
  else if (st.tab === "guide") renderGuide();
  else renderList();
  main.scrollTop = resetScroll ? 0 : sc;
}

function renderList() {
  const list = visible();
  const shown = list.slice(0, st.limit);
  const chips = st.tab === "live"
    ? `<div class="chips">${["All", "★ Favorites", ...groups()].map((g) => `<button class="chip ${g === st.group ? "on" : ""}" data-group="${esc(g)}">${esc(g)}</button>`).join("")}</div>` : "";
  hdr.innerHTML = `<input class="search" id="q" type="search" placeholder="Search channels" value="${esc(st.query)}" />${chips}`;
  main.innerHTML = st.channels.length === 0
    ? `<div class="empty">No channels yet.<br>Open Settings to add an M3U or Xtream playlist.</div>`
    : list.length === 0 ? `<div class="empty">${st.tab === "favs" ? "Tap ☆ on a channel to add favorites." : "No matches."}</div>`
    : shown.map(chRow).join("") + (list.length > shown.length ? `<button class="more" id="more">Show more (${list.length - shown.length})</button>` : "");
  const q = $<HTMLInputElement>("q");
  q.oninput = () => { st.query = q.value; st.limit = PAGE; const pos = q.selectionStart; renderListBodyOnly(); q.setSelectionRange(pos, pos); };
}
function renderListBodyOnly() {
  const list = visible();
  const shown = list.slice(0, st.limit);
  main.innerHTML = list.length === 0 ? `<div class="empty">No matches.</div>`
    : shown.map(chRow).join("") + (list.length > shown.length ? `<button class="more" id="more">Show more (${list.length - shown.length})</button>` : "");
}

function renderGuide() {
  const gs = groups();
  if (!st.guideGroup || (st.guideGroup !== "★" && !gs.includes(st.guideGroup))) st.guideGroup = gs[0] ?? "";
  hdr.innerHTML = `<div class="guidehead"><select id="gg">
      <option value="★" ${st.guideGroup === "★" ? "selected" : ""}>★ Favorites</option>
      ${gs.map((g) => `<option ${g === st.guideGroup ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>
      <button class="chip" id="jump">Now</button></div>`;
  $("gg").onchange = (e) => { st.guideGroup = (e.target as HTMLSelectElement).value; st.guideLimit = 40; renderMain(); };
  $("jump").onclick = () => scrollGuideToNow();
  if (!st.channels.length) { main.innerHTML = `<div class="empty">No channels yet. Add a playlist in Settings.</div>`; return; }
  const list = st.channels.filter((c) => (st.guideGroup === "★" ? st.favs.has(c.id) : c.group === st.guideGroup));
  const hours = st.settings.epgHours;
  const t0 = Math.floor((Date.now() - 30 * 60000) / (30 * 60000)) * 30 * 60000;
  const t1 = t0 + hours * 3600000;
  const width = ((t1 - t0) / 60000) * PX_PER_MIN;
  let times = "";
  for (let t = t0; t < t1; t += 30 * 60000) times += `<div class="t" style="width:${30 * PX_PER_MIN}px">${fmt(t)}</div>`;
  const rows = list.slice(0, st.guideLimit).map((c) => {
    const progs = (c.tvgId ? pm.get(c.tvgId) : undefined) ?? [];
    const now = Date.now();
    const blocks = progs.filter((p) => p.stop > t0 && p.start < t1).map((p) => {
      const s = Math.max(p.start, t0), e = Math.min(p.stop, t1);
      return `<button class="gp ${p.start <= now && p.stop > now ? "now" : ""}" data-ch="${c.id}" style="left:${((s - t0) / 60000) * PX_PER_MIN}px;width:${Math.max(((e - s) / 60000) * PX_PER_MIN - 2, 2)}px">${esc(p.title)}</button>`;
    }).join("") || `<button class="gp" data-ch="${c.id}" style="left:0;width:${width - 2}px;color:var(--dim)">No guide data · tap to play</button>`;
    return `<div class="grow"><div class="gch" data-ch="${c.id}"><div class="logo" style="${c.logo ? `background-image:url('${esc(c.logo)}')` : ""}"></div><span>${esc(c.name)}</span></div>
      <div class="gprogs" style="width:${width}px">${blocks}</div></div>`;
  }).join("");
  const nowX = ((Date.now() - t0) / 60000) * PX_PER_MIN + 84;
  main.innerHTML = `<div class="guide" id="guide" data-t0="${t0}">
      <div class="gtimes"><div class="corner"></div>${times}</div>
      <div style="position:relative"><div class="nowline" style="left:${nowX}px"></div>${rows}</div></div>
      ${list.length > st.guideLimit ? `<button class="more" id="gmore">Show more channels (${list.length - st.guideLimit})</button>` : ""}
      ${st.epg.length ? "" : `<div class="small" style="padding:8px">No EPG loaded. Use Settings → Load guide.</div>`}`;
  scrollGuideToNow();
}
function scrollGuideToNow() {
  const g = document.getElementById("guide");
  if (!g) return;
  const t0 = Number(g.dataset.t0);
  g.scrollLeft = Math.max(0, ((Date.now() - t0) / 60000) * PX_PER_MIN - 20);
}

function renderSettings() {
  hdr.innerHTML = `<h2 style="margin:4px 0">Settings</h2>`;
  const src = store.source();
  main.innerHTML = `
  <div class="card"><h3>Playlist ${src ? `· ${esc(src.name)}` : ""}</h3>
    <div class="chips" style="padding-top:0"><button class="chip on" data-st="m3u">M3U URL</button><button class="chip" data-st="xtream">Xtream</button><button class="chip" data-st="paste">Paste / file</button></div>
    <div id="srcform"></div>
    <div class="status ${st.statusErr ? "err" : ""}" id="status">${esc(st.status)}</div></div>
  <div class="card"><h3>Guide (EPG)</h3>
    <label>XMLTV URL (optional, auto-filled from playlist)</label><input type="url" id="epgurl" placeholder="https://…/xmltv.php" value="${esc(src?.kind === "m3u" ? src.epgUrl ?? "" : "")}" />
    <label>Hours shown in grid</label><input type="number" id="epghours" min="3" max="48" value="${st.settings.epgHours}" />
    <button class="btn" id="loadepg">Load guide</button>
    <div class="small">${st.epg.length} programmes loaded</div></div>
  <div class="card"><h3>Network profiles</h3>
    <label>Network mode (detected now: ${activeNet() === "mobile" ? "Mobile data" : "Wi-Fi"}${conn() ? "" : "; this browser cannot detect it, choose manually"})</label>
    <select id="netmode"><option value="auto" ${st.settings.netMode === "auto" ? "selected" : ""}>Auto-detect</option>
      <option value="wifi" ${st.settings.netMode === "wifi" ? "selected" : ""}>Wi-Fi</option>
      <option value="mobile" ${st.settings.netMode === "mobile" ? "selected" : ""}>Mobile data saver</option></select>
    ${(["wifi", "mobile"] as const).map((k) => profileFields(k)).join("")}
    <button class="btn alt" id="saveprof">Save profiles</button>
    <div class="small">Applies to hls.js playback. iPhone Safari plays HLS with its built-in player, which ignores buffer and quality settings.</div></div>
  <div class="card"><h3>Proxy (fixes CORS / blocked networks)</h3>
    <label for="pxmode">Proxy</label>
    <select id="pxmode">
      ${([["none", "None (direct)"], ["worker", "TVmate Cloudflare Worker (recommended)"], ["local", "Local proxy (http://localhost:8787)"], ["custom", "Custom URL"]] as const)
        .map(([v, t]) => `<option value="${v}" ${st.settings.proxyMode === v ? "selected" : ""}>${t}</option>`).join("")}
    </select>
    <div id="px-worker" ${st.settings.proxyMode === "worker" ? "" : "hidden"}>
      <label for="wtoken">Worker access token (stored only on this device)</label>
      <input type="password" id="wtoken" autocomplete="off" placeholder="paste the token once" value="${esc(st.settings.workerToken)}" />
      <div class="small">Uses ${esc(WORKER_URL)}. Without a token the Worker is not used.</div></div>
    <div id="px-local" ${st.settings.proxyMode === "local" ? "" : "hidden"}>
      <div class="small">Run <code>node proxy/server.mjs</code> on this device (see README). Works from desktop Chrome/Firefox; iPhone Safari blocks http://localhost from an HTTPS page.</div></div>
    <div id="px-custom" ${st.settings.proxyMode === "custom" ? "" : "hidden"}>
      <label for="proxy">Proxy URL, e.g. https://proxy.example.com/?url=</label>
      <input type="url" id="proxy" value="${esc(st.settings.proxy)}" />
      <label for="proxytoken">Access token (optional)</label>
      <input type="password" id="proxytoken" autocomplete="off" value="${esc(st.settings.proxyToken)}" /></div>
    <label><input type="checkbox" id="pxs" ${st.settings.proxyStreams ? "checked" : ""}/> Also route video streams through the proxy</label>
    <div class="row"><button class="btn alt" id="saveproxy">Save</button><button class="btn alt" id="testproxy">Test proxy</button></div>
    <div class="status" id="pxstatus"></div>
    <div class="small">Browsers block most IPTV servers (no CORS headers) and plain http:// ones on this HTTPS site; a proxy fixes both.
      Public CORS proxies (corsproxy.io and similar) are deliberately not offered: they log your traffic and often break streams. See README.</div></div>
  <div class="card"><h3>Data</h3>
    <button class="btn alt" id="clear">Clear everything</button>
    <div class="small">TVmate Touch Web · MIT · original design</div></div>`;
  showSrcForm("m3u");
}
function profileFields(k: "wifi" | "mobile"): string {
  const p = st.settings.profiles[k];
  const caps: [QualityCap, string][] = [["auto", "Auto"], ["480", "480p"], ["720", "720p"], ["1080", "1080p"]];
  return `<h4 style="margin:14px 0 0">${k === "wifi" ? "Wi-Fi" : "Mobile data saver"}</h4>
    <label>Buffer ahead: <b id="bv-${k}">${p.bufferSec}</b> s</label>
    <input type="range" id="buf-${k}" min="${BUFFER_MIN}" max="${BUFFER_MAX}" value="${p.bufferSec}" style="width:100%" oninput="document.getElementById('bv-${k}').textContent=this.value" />
    <label>Quality cap</label>
    <select id="cap-${k}">${caps.map(([v, l]) => `<option value="${v}" ${p.cap === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
}

function showSrcForm(kind: "m3u" | "xtream" | "paste") {
  const f = $("srcform");
  document.querySelectorAll<HTMLElement>("[data-st]").forEach((b) => b.classList.toggle("on", b.dataset.st === kind));
  const cur = store.source();
  if (kind === "m3u") {
    f.innerHTML = `<label>M3U / M3U8 URL</label><input type="url" id="m3u" placeholder="https://…/playlist.m3u" value="${esc(cur?.kind === "m3u" ? cur.url : "")}" />
      <button class="btn" id="go-m3u">Test connection</button><button class="btn alt" id="save-m3u">Save</button>`;
  } else if (kind === "xtream") {
    const x = cur?.kind === "xtream" ? cur : null;
    f.innerHTML = `<label>Server (http://host:port)</label><input type="url" id="xs" value="${esc(x?.server ?? "")}" />
      <label>Username</label><input type="text" id="xu" autocapitalize="off" autocorrect="off" value="${esc(x?.user ?? "")}" />
      <label>Password</label><input type="password" id="xp" value="${esc(x?.pass ?? "")}" />
      <button class="btn" id="go-x">Test connection</button><button class="btn alt" id="save-x">Save</button>`;
  } else {
    f.innerHTML = `<label>Paste M3U text or choose a file (no network needed)</label><textarea id="ptxt" rows="4"></textarea>
      <input type="file" id="pfile" accept=".m3u,.m3u8,text/plain" style="margin-top:8px" />
      <button class="btn" id="go-p">Import</button>`;
  }
}

function safeHost(u: string): string { try { return new URL(u).hostname; } catch { return u || "playlist"; } }

/** Save without testing: validates the fields only, never touches the network. */
function saveSource(src: Source) {
  const err = validateSource(src);
  if (err) return setStatus(err, true);
  store.setSource(src);
  setStatus(`Saved "${src.name}". Tap Test connection to load channels now, or load later.`);
}

function setStatus(msg: string, err = false) {
  st.status = msg; st.statusErr = err;
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.className = "status" + (err ? " err" : ""); }
}

function applyChannels(chs: Channel[]) {
  st.channels = chs;
  store.setChannels(chs);
  pm = progMap();
  st.group = "All";
}

async function doLoad(src: Source) {
  setStatus("Loading…");
  try {
    const { channels, epgUrl } = await loadSource(src, st.settings);
    if (!channels.length) throw new Error("No channels found in playlist");
    if (src.kind === "m3u" && epgUrl && !src.epgUrl) src = { ...src, epgUrl };
    store.setSource(src);
    applyChannels(channels);
    setStatus(`Loaded ${channels.length} channels in ${groups().length} groups.`);
    if (epgUrl) { sessionStorage.setItem("tm.epg", epgUrl); void doEpg(epgUrl); }
  } catch (e) { setStatus(String((e as Error).message || e), true); }
}
async function doEpg(url: string) {
  setStatus("Loading guide…");
  try {
    const wanted = new Set(st.channels.map((c) => c.tvgId).filter(Boolean) as string[]);
    const now = Date.now();
    const xml = await fetchEpgText(url, st.settings);
    st.epg = parseXMLTV(xml, wanted, now - 3 * 3600000, now + 48 * 3600000);
    store.setEpg(st.epg);
    pm = progMap();
    setStatus(`Guide loaded: ${st.epg.length} programmes.`);
  } catch (e) { setStatus(String((e as Error).message || e), true); }
}

// ---------- events ----------
document.getElementById("nav")!.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-tab]") as HTMLElement | null;
  if (!t) return;
  st.tab = t.dataset.tab as Tab; st.limit = PAGE; st.query = "";
  renderMain();
});
hdr.addEventListener("click", (e) => {
  const g = (e.target as HTMLElement).closest("[data-group]") as HTMLElement | null;
  if (g) { st.group = g.dataset.group!; st.limit = PAGE; renderMain(); }
});
main.addEventListener("click", async (e) => {
  const el = e.target as HTMLElement;
  const fav = el.closest("[data-fav]") as HTMLElement | null;
  if (fav) {
    const id = fav.dataset.fav!;
    st.favs.has(id) ? st.favs.delete(id) : st.favs.add(id);
    store.setFavorites(st.favs);
    if (st.tab === "favs") renderMain(false);
    else { fav.classList.toggle("on"); fav.textContent = st.favs.has(id) ? "★" : "☆"; }
    return;
  }
  const ch = el.closest("[data-ch]") as HTMLElement | null;
  if (ch) { const c = st.channels.find((x) => x.id === ch.dataset.ch); if (c) tune(c); return; }
  const stBtn = el.closest("[data-st]") as HTMLElement | null;
  if (stBtn) return showSrcForm(stBtn.dataset.st as "m3u" | "xtream" | "paste");
  switch (el.id) {
    case "more": st.limit += PAGE; return renderMain(false);
    case "gmore": st.guideLimit += 40; return renderMain(false);
    case "go-m3u": {
      const url = $<HTMLInputElement>("m3u").value.trim();
      const epgUrl = $<HTMLInputElement>("epgurl").value.trim() || undefined;
      if (url) await doLoad({ kind: "m3u", name: safeHost(url), url, epgUrl });
      return;
    }
    case "save-m3u": {
      const url = $<HTMLInputElement>("m3u").value.trim();
      const epgUrl = $<HTMLInputElement>("epgurl").value.trim() || undefined;
      const src: Source = { kind: "m3u", name: safeHost(url), url, epgUrl };
      return saveSource(src);
    }
    case "save-x": {
      const server = $<HTMLInputElement>("xs").value.trim(), user = $<HTMLInputElement>("xu").value.trim(), pass = $<HTMLInputElement>("xp").value;
      return saveSource({ kind: "xtream", name: user + "@" + safeHost(server), server, user, pass });
    }
    case "go-x": {
      const server = $<HTMLInputElement>("xs").value.trim(), user = $<HTMLInputElement>("xu").value.trim(), pass = $<HTMLInputElement>("xp").value;
      if (server && user) await doLoad({ kind: "xtream", name: user + "@" + safeHost(server), server, user, pass });
      return;
    }
    case "go-p": {
      let text = $<HTMLTextAreaElement>("ptxt").value;
      const file = $<HTMLInputElement>("pfile").files?.[0];
      if (file) text = await file.text();
      const parsed = parseM3U(text);
      const channels = preferHlsChannels(parsed.channels);
      const epgUrl = parsed.epgUrl;
      if (!channels.length) return setStatus("No channels found", true);
      store.setSource({ kind: "m3u", name: "Imported", url: "", epgUrl });
      applyChannels(channels);
      return setStatus(`Imported ${channels.length} channels.`);
    }
    case "loadepg": {
      const url = $<HTMLInputElement>("epgurl").value.trim() || sessionStorage.getItem("tm.epg") || "";
      const hrs = Number($<HTMLInputElement>("epghours").value) || 12;
      st.settings = { ...st.settings, epgHours: Math.min(48, Math.max(3, hrs)) };
      store.setSettings(st.settings);
      const s = store.source();
      const target = url || (s?.kind === "xtream" ? `${s.server.replace(/\/+$/, "")}/xmltv.php?username=${encodeURIComponent(s.user)}&password=${encodeURIComponent(s.pass)}` : "");
      if (!target) return setStatus("Enter an XMLTV URL", true);
      await doEpg(target);
      return;
    }
    case "saveprof": {
      const read = (k: "wifi" | "mobile") => ({
        bufferSec: clampBuffer(Number($<HTMLInputElement>("buf-" + k).value)),
        cap: $<HTMLSelectElement>("cap-" + k).value as QualityCap,
      });
      st.settings = { ...st.settings, netMode: $<HTMLSelectElement>("netmode").value as NetMode, profiles: { wifi: read("wifi"), mobile: read("mobile") } };
      store.setSettings(st.settings);
      return setStatus(`Profiles saved. Active: ${activeNet() === "mobile" ? "Mobile data saver" : "Wi-Fi"} (${activeProfile().bufferSec}s buffer).`);
    }
    case "saveproxy": {
      const next = readProxyForm();
      if (next.proxyMode === "custom" && !/^https?:\/\//i.test(next.proxy)) return setPxStatus("Custom proxy URL should look like https://host/?url=", true);
      st.settings = next;
      store.setSettings(st.settings);
      const r = resolveProxy(st.settings);
      return setPxStatus(r.needsToken ? "Saved, but the Worker stays off until you enter its access token." : "Proxy saved.", r.needsToken);
    }
    case "testproxy": {
      setPxStatus("Testing…");
      const res = await testProxy(readProxyForm());
      return setPxStatus(res.message, !res.ok);
    }
    case "clear":
      if (confirm("Remove playlist, favorites, guide and settings?")) { localStorage.clear(); sessionStorage.clear(); location.reload(); }
  }
});
main.addEventListener("input", () => { /* placeholder for future inline filters */ });
main.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
  if (t.id !== "pxmode") return;
  const mode = (t as HTMLSelectElement).value as ProxyMode;
  for (const m of ["worker", "local", "custom"]) document.getElementById("px-" + m)!.toggleAttribute("hidden", m !== mode);
  // One selection should fix CORS: routing streams too is the sensible default for a real proxy.
  if (mode !== "none") $<HTMLInputElement>("pxs").checked = true;
});
function readProxyForm(): Settings {
  return {
    ...st.settings,
    proxyMode: $<HTMLSelectElement>("pxmode").value as ProxyMode,
    workerToken: $<HTMLInputElement>("wtoken").value.trim(),
    proxy: $<HTMLInputElement>("proxy").value.trim(),
    proxyToken: $<HTMLInputElement>("proxytoken").value.trim(),
    proxyStreams: $<HTMLInputElement>("pxs").checked,
  };
}
function setPxStatus(msg: string, err = false) {
  const el = document.getElementById("pxstatus");
  if (el) { el.textContent = msg; el.className = "status" + (err ? " err" : ""); }
}

// refresh "now" lines every minute
setInterval(() => { if (st.tab !== "settings" && document.activeElement?.tagName !== "INPUT") renderMain(false); }, 60000);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
// If served by the bundled proxy (STATIC_DIR mode), auto-enable the same-origin proxy once.
if (!localStorage.getItem("tm.settings") && location.protocol.startsWith("http")) {
  fetch(new URL("./__proxy", location.href)).then((r) => (r.ok ? r.text() : "")).then((t) => {
    if (t === "ok") {
      st.settings = { ...st.settings, proxyMode: "custom", proxy: new URL("./?url=", location.href).href, proxyStreams: true };
      store.setSettings(st.settings);
      if (st.tab === "settings") renderMain(false);
    }
  }).catch(() => {});
}
renderMain();
