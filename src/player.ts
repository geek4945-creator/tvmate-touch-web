import Hls from "hls.js";
import { levelCapIndex, type QualityCap } from "./profiles";
import { isFormatRelated, type PlayFailure } from "./diag";

export interface PlayOpts { bufferSec: number; cap: QualityCap }

export type PlayerState = "closed" | "open" | "mini";

/** Single shared <video> that is restyled between full-width dock, fullscreen and mini bar. */
export class Player {
  readonly video: HTMLVideoElement;
  private hls: Hls | null = null;
  private ts: { destroy(): void } | null = null;
  /** Called once per failed attempt (after in-player retries). */
  onFail: (f: PlayFailure) => void = () => {};
  private retries = 0;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.autoplay = true;
    video.controls = false;
  }

  play(url: string, opts: PlayOpts = { bufferSec: 15, cap: "auto" }) {
    this.stop();
    const v = this.video;
    const isHls = /\.m3u8(\?|$)/i.test(url) || url.includes("m3u8");
    if (isHls && Hls.isSupported()) {
      // Buffer-ahead from the active network profile. Adaptive start: begin on the lowest variant
      // (fast first frame) and let ABR ramp up; a quality cap limits the ceiling.
      const hls = new Hls({
        lowLatencyMode: false,
        maxBufferLength: opts.bufferSec,
        maxMaxBufferLength: opts.bufferSec,
        backBufferLength: 10,
        startLevel: 0,
        abrEwmaDefaultEstimate: 500_000,
        capLevelToPlayerSize: false,
      });
      this.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
        const idx = levelCapIndex(d.levels, opts.cap);
        hls.autoLevelCapping = idx; // -1 = no cap
      });
      this.retries = 0;
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        const status = (d.response as { code?: number } | undefined)?.code;
        const detail = String(d.details);
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && this.retries++ < 2) { hls.recoverMediaError(); return; }
        // An HTTP error status (404, 403, ...) will not fix itself: report it now. Only status-less network
        // errors (timeouts, dropped connections) get a couple of retries.
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !(status && status >= 400) && this.retries++ < 2) { hls.startLoad(); return; }
        this.stop();
        this.onFail({ status: status || undefined, detail, formatRelated: isFormatRelated(status, detail) });
      });
      hls.loadSource(url);
      hls.attachMedia(v);
    } else {
      // Safari/iOS: native HLS (buffer and quality are chosen by the OS player; settings do not apply)
      v.src = url;
    }
    v.play().catch(() => { /* needs user gesture; tap handles it */ });
  }

  /** Raw MPEG-TS (live) through mpegts.js, loaded on demand. Returns false when this browser cannot do it (e.g. iPhone Safari). */
  async playTs(url: string): Promise<boolean> {
    const mod = await import("mpegts.js");
    const mpegts = (mod as unknown as { default: any }).default ?? mod;
    if (!mpegts.isSupported()) return false;
    this.stop();
    const p = mpegts.createPlayer({ type: "mpegts", isLive: true, url }, { enableWorker: false, liveBufferLatencyChasing: false });
    this.ts = p;
    p.attachMediaElement(this.video);
    p.on(mpegts.Events.ERROR, (_t: string, detail: string, info: { code?: number } | undefined) => {
      const status = info?.code && info.code >= 100 ? info.code : undefined;
      this.stop();
      this.onFail({ status, detail: String(detail), formatRelated: false });
    });
    p.load();
    void this.video.play().catch(() => {});
    return true;
  }

  stop() {
    try { this.ts?.destroy(); } catch { /* ignore */ }
    this.ts = null;
    this.hls?.destroy();
    this.hls = null;
    this.video.removeAttribute("src");
    this.video.load();
  }

  toggle() { this.video.paused ? void this.video.play() : this.video.pause(); }

  pip() {
    const v = this.video as any;
    if (document.pictureInPictureEnabled && (v.requestPictureInPicture)) {
      if ((document as any).pictureInPictureElement) void (document as any).exitPictureInPicture();
      else void v.requestPictureInPicture().catch(() => {});
    } else if (v.webkitSetPresentationMode) {
      v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
    }
  }

  fullscreen() {
    const v = this.video as any;
    if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone Safari
    else if (v.requestFullscreen) void v.requestFullscreen();
  }
}
