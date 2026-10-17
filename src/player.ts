import Hls from "hls.js";
import { levelCapIndex, type QualityCap } from "./profiles";

export interface PlayOpts { bufferSec: number; cap: QualityCap }

export type PlayerState = "closed" | "open" | "mini";

/** Single shared <video> that is restyled between full-width dock, fullscreen and mini bar. */
export class Player {
  readonly video: HTMLVideoElement;
  private hls: Hls | null = null;
  onError: (msg: string) => void = () => {};

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
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { this.onError("cors"); hls.startLoad(); }
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { this.onError("Playback failed"); this.stop(); }
      });
      hls.loadSource(url);
      hls.attachMedia(v);
    } else {
      // Safari/iOS: native HLS (buffer and quality are chosen by the OS player; settings do not apply)
      v.src = url;
    }
    v.play().catch(() => { /* needs user gesture; tap handles it */ });
  }

  stop() {
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
