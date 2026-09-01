import type { AudioFx } from "../types";
import { defaultAudioFx } from "../types";
import { applyAudioFxToNodes } from "./audioFx";

/** Single-source audio playback with seek + live volume (speed via pre-stretched buffer). */

export type PlaybackSnapshot = {
  lineId: string;
  variantId: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
};

type Listeners = {
  onChange: (snap: PlaybackSnapshot | null) => void;
};

export class LineAudioPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private lowshelf: BiquadFilterNode | null = null;
  private presence: BiquadFilterNode | null = null;
  private highshelf: BiquadFilterNode | null = null;
  private deess: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private makeup: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private lineId: string | null = null;
  private variantId: string | null = null;
  private startedAt = 0;
  private offset = 0;
  /** In-point for the next start after the clip ends (original buffer seconds). */
  private playFrom = 0;
  /** Out-point; playback stops here when set. */
  private playUntil: number | null = null;
  private playing = false;
  private volume = 1;
  private audioFx: AudioFx = defaultAudioFx();
  private raf = 0;
  private endedWaiters: Array<() => void> = [];
  private silenceSource: AudioBufferSourceNode | null = null;
  private silenceResolve: (() => void) | null = null;
  private listeners: Listeners;

  constructor(listeners: Listeners) {
    this.listeners = listeners;
  }

  private emit() {
    if (!this.lineId || !this.buffer) {
      this.listeners.onChange(null);
      return;
    }
    this.listeners.onChange({
      lineId: this.lineId,
      variantId: this.variantId,
      playing: this.playing,
      currentTime: this.getCurrentTime(),
      duration: this.buffer.duration,
    });
  }

  getCurrentTime(): number {
    if (!this.ctx || !this.buffer) return 0;
    if (!this.playing) return this.offset;
    const t = this.offset + (this.ctx.currentTime - this.startedAt);
    return Math.min(Math.max(0, t), this.buffer.duration);
  }

  private tick = () => {
    if (!this.playing) return;
    this.emit();
    const limit =
      this.playUntil != null && this.offset < this.playUntil - 0.02
        ? this.playUntil
        : (this.buffer?.duration ?? 0);
    if (this.getCurrentTime() >= limit - 0.02) {
      this.finishEnded();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private finishEnded() {
    this.disconnectSource();
    this.playing = false;
    this.offset = this.playFrom;
    this.emit();
    const waiters = this.endedWaiters.splice(0);
    waiters.forEach((w) => w());
  }

  private ensureCtx() {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** Route Web Audio output to a sink (Chrome / Edge). Empty id = system default. */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    const ctx = this.ensureCtx();
    const setSinkId = (
      ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    ).setSinkId;
    if (typeof setSinkId !== "function") return false;
    const sinkId = deviceId.trim() || "default";
    await setSinkId.call(ctx, sinkId);
    return true;
  }

  private fxNodes() {
    if (
      !this.highpass ||
      !this.lowshelf ||
      !this.presence ||
      !this.highshelf ||
      !this.deess ||
      !this.compressor ||
      !this.makeup
    ) {
      return null;
    }
    return {
      highpass: this.highpass,
      lowshelf: this.lowshelf,
      presence: this.presence,
      highshelf: this.highshelf,
      deess: this.deess,
      compressor: this.compressor,
      makeup: this.makeup,
    };
  }

  private ensureChain(ctx: AudioContext) {
    if (this.gain && this.fxNodes()) return;
    this.disconnectChain();
    const highpass = ctx.createBiquadFilter();
    const lowshelf = ctx.createBiquadFilter();
    const presence = ctx.createBiquadFilter();
    const highshelf = ctx.createBiquadFilter();
    const deess = ctx.createBiquadFilter();
    const compressor = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const gain = ctx.createGain();
    highpass.connect(lowshelf);
    lowshelf.connect(presence);
    presence.connect(highshelf);
    highshelf.connect(deess);
    deess.connect(compressor);
    compressor.connect(makeup);
    makeup.connect(gain);
    gain.connect(ctx.destination);
    this.highpass = highpass;
    this.lowshelf = lowshelf;
    this.presence = presence;
    this.highshelf = highshelf;
    this.deess = deess;
    this.compressor = compressor;
    this.makeup = makeup;
    this.gain = gain;
    this.applyFx();
    this.gain.gain.value = this.volume;
  }

  private applyFx() {
    const nodes = this.fxNodes();
    if (!nodes) return;
    applyAudioFxToNodes(nodes, this.audioFx);
  }

  private disconnectChain() {
    const nodes = [
      this.highpass,
      this.lowshelf,
      this.presence,
      this.highshelf,
      this.deess,
      this.compressor,
      this.makeup,
      this.gain,
    ];
    for (const n of nodes) {
      if (!n) continue;
      try {
        n.disconnect();
      } catch {
        /* */
      }
    }
    this.highpass = null;
    this.lowshelf = null;
    this.presence = null;
    this.highshelf = null;
    this.deess = null;
    this.compressor = null;
    this.makeup = null;
    this.gain = null;
  }

  private disconnectSource() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* */
      }
      try {
        this.source.disconnect();
      } catch {
        /* */
      }
      this.source = null;
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  /** Resolve waitUntilInactive waiters without stopping playback (e.g. cancel batch). */
  releaseEndedWaiters() {
    const waiters = this.endedWaiters.splice(0);
    waiters.forEach((w) => w());
  }

  /** Cancel an in-flight waitSilenceMs without affecting line playback. */
  cancelSilence() {
    if (this.silenceSource) {
      try {
        this.silenceSource.onended = null;
        this.silenceSource.stop();
      } catch {
        /* */
      }
      try {
        this.silenceSource.disconnect();
      } catch {
        /* */
      }
      this.silenceSource = null;
    }
    if (this.silenceResolve) {
      const resolve = this.silenceResolve;
      this.silenceResolve = null;
      resolve();
    }
  }

  /**
   * Play a silent AudioContext buffer for `ms` (batch-play gap).
   * Does not touch line playback snapshot state.
   */
  async waitSilenceMs(ms: number): Promise<void> {
    this.cancelSilence();
    const duration = Math.max(0, ms) / 1000;
    if (duration <= 0) return;

    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();

    const frames = Math.max(1, Math.ceil(duration * ctx.sampleRate));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(ctx.destination);

    await new Promise<void>((resolve) => {
      const finish = () => {
        if (this.silenceSource === src) this.silenceSource = null;
        if (this.silenceResolve === finish) this.silenceResolve = null;
        try {
          src.disconnect();
        } catch {
          /* */
        }
        try {
          gain.disconnect();
        } catch {
          /* */
        }
        resolve();
      };
      this.silenceSource = src;
      this.silenceResolve = finish;
      src.onended = finish;
      src.start();
    });
  }

  stop(clearLine = true) {
    this.cancelSilence();
    this.disconnectSource();
    this.playing = false;
    this.offset = 0;
    this.playFrom = 0;
    this.playUntil = null;
    this.releaseEndedWaiters();
    if (clearLine) {
      this.lineId = null;
      this.variantId = null;
      this.buffer = null;
      this.disconnectChain();
      this.listeners.onChange(null);
    } else {
      this.emit();
    }
  }

  /** Decode into the player without starting playback (for seek-while-paused). */
  async loadFromBytes(
    lineId: string,
    variantId: string | null,
    bytes: Uint8Array,
    volume: number,
  ) {
    this.stop(true);
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();

    // decodeAudioData detaches the buffer; pass an exact-sized copy
    const copy = bytes.slice();
    const audioBuf = await ctx.decodeAudioData(copy.buffer);

    this.lineId = lineId;
    this.variantId = variantId;
    this.buffer = audioBuf;
    this.volume = volume;
    this.offset = 0;
    this.playFrom = 0;
    this.playUntil = null;
    this.playing = false;
    this.ensureChain(ctx);
    this.applyFx();
    if (this.gain) this.gain.gain.value = volume;
    this.emit();
  }

  /** Play decoded PCM at rate 1 (pitch preserved). Speed must be baked into bytes. */
  async playFromBytes(
    lineId: string,
    variantId: string | null,
    bytes: Uint8Array,
    volume: number,
  ) {
    await this.loadFromBytes(lineId, variantId, bytes, volume);
    this.startSource();
  }

  private startSource() {
    if (!this.ctx || !this.buffer) return;
    this.disconnectSource();
    this.ensureChain(this.ctx);
    this.applyFx();
    if (this.gain) this.gain.gain.value = this.volume;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = 1;
    src.connect(this.highpass!);
    src.onended = () => {
      if (this.source === src) this.finishEnded();
    };
    this.source = src;
    this.startedAt = this.ctx.currentTime;
    this.playing = true;
    const useWindow =
      this.playUntil != null && this.offset < this.playUntil - 0.02;
    const endAt = useWindow
      ? this.playUntil!
      : this.buffer.duration;
    const remaining = endAt - this.offset;
    if (remaining <= 0.02) {
      this.finishEnded();
      return;
    }
    src.start(0, this.offset, remaining);
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.getCurrentTime();
    this.disconnectSource();
    this.playing = false;
    this.emit();
  }

  resume() {
    if (this.playing || !this.buffer || !this.lineId) return;
    void this.ensureCtx().resume();
    this.startSource();
  }

  togglePause() {
    if (this.playing) this.pause();
    else this.resume();
  }

  seek(time: number) {
    if (!this.buffer) return;
    this.offset = Math.min(Math.max(0, time), this.buffer.duration);
    if (this.playing) this.startSource();
    else this.emit();
  }

  /** Constrain the next play-through to [from, until) in buffer seconds. */
  setPlayWindow(from: number | null, until: number | null) {
    const dur = this.buffer?.duration ?? 0;
    const start = from != null && from > 0.001 ? Math.min(from, dur) : 0;
    this.playFrom = start;
    this.playUntil =
      until != null && until > start + 0.001 ? Math.min(until, dur) : null;
  }

  setVolume(volume: number) {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }

  setAudioFx(fx: AudioFx) {
    this.audioFx = { ...fx };
    this.applyFx();
  }

  /** Replace buffer while keeping playhead ratio (for pitch-preserving speed change). */
  async replaceBufferKeepPosition(bytes: Uint8Array) {
    if (!this.lineId) return;
    const wasPlaying = this.playing;
    const oldDur = this.buffer?.duration ?? 0;
    const ratio = oldDur > 0 ? this.getCurrentTime() / oldDur : 0;
    const ctx = this.ensureCtx();
    const copy = new Uint8Array(bytes);
    const audioBuf = await ctx.decodeAudioData(copy.buffer);
    this.disconnectSource();
    this.buffer = audioBuf;
    const scale = oldDur > 0 ? audioBuf.duration / oldDur : 1;
    this.playFrom *= scale;
    if (this.playUntil != null) this.playUntil *= scale;
    this.offset = ratio * audioBuf.duration;
    if (wasPlaying) this.startSource();
    else this.emit();
  }

  waitUntilInactive(): Promise<void> {
    if (!this.playing) return Promise.resolve();
    return new Promise((resolve) => {
      this.endedWaiters.push(resolve);
    });
  }

  get activeLineId() {
    return this.lineId;
  }

  get activeVariantId() {
    return this.variantId;
  }

  isActiveVariant(lineId: string, variantId: string | null) {
    return this.lineId === lineId && this.variantId === variantId;
  }

  get isPlaying() {
    return this.playing;
  }

  get hasBuffer() {
    return this.buffer != null;
  }
}
