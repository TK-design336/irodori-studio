/** Single-source audio playback with seek + live volume (speed via pre-stretched buffer). */

export type PlaybackSnapshot = {
  lineId: string;
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
  private buffer: AudioBuffer | null = null;
  private lineId: string | null = null;
  private startedAt = 0;
  private offset = 0;
  private playing = false;
  private volume = 1;
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
    if (this.getCurrentTime() >= (this.buffer?.duration ?? 0) - 0.02) {
      this.finishEnded();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private finishEnded() {
    this.disconnectSource();
    this.playing = false;
    this.offset = 0;
    this.emit();
    const waiters = this.endedWaiters.splice(0);
    waiters.forEach((w) => w());
  }

  private ensureCtx() {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
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
    this.releaseEndedWaiters();
    if (clearLine) {
      this.lineId = null;
      this.buffer = null;
      this.gain = null;
      this.listeners.onChange(null);
    } else {
      this.emit();
    }
  }

  /** Play decoded PCM at rate 1 (pitch preserved). Speed must be baked into bytes. */
  async playFromBytes(lineId: string, bytes: Uint8Array, volume: number) {
    this.stop(true);
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();

    // decodeAudioData detaches the buffer; pass an exact-sized copy
    const copy = bytes.slice();
    const audioBuf = await ctx.decodeAudioData(copy.buffer);

    this.lineId = lineId;
    this.buffer = audioBuf;
    this.volume = volume;
    this.offset = 0;
    this.startSource();
  }

  private startSource() {
    if (!this.ctx || !this.buffer) return;
    this.disconnectSource();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = 1;
    src.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    src.onended = () => {
      if (this.source === src) this.finishEnded();
    };
    this.source = src;
    this.startedAt = this.ctx.currentTime;
    this.playing = true;
    src.start(0, this.offset);
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

  setVolume(volume: number) {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }

  /** Replace buffer while keeping playhead ratio (for pitch-preserving speed change). */
  async replaceBufferKeepPosition(bytes: Uint8Array) {
    if (!this.lineId) return;
    const wasPlaying = this.playing;
    const ratio =
      this.buffer && this.buffer.duration > 0
        ? this.getCurrentTime() / this.buffer.duration
        : 0;
    const ctx = this.ensureCtx();
    const copy = new Uint8Array(bytes);
    const audioBuf = await ctx.decodeAudioData(copy.buffer);
    this.disconnectSource();
    this.buffer = audioBuf;
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

  get isPlaying() {
    return this.playing;
  }

  get hasBuffer() {
    return this.buffer != null;
  }
}
