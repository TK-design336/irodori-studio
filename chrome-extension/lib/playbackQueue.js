/**
 * Prefetch + playback coordination.
 * Service worker owns the session; talks to offscreen via chrome.runtime.
 */

import { cacheKey, getCached, putCached } from "./cache.js";
import { ensureOffscreen } from "./offscreenDoc.js";

const PREFETCH = 3;
const CHARS_PER_SEC = 8;

export class PlaybackController {
  /**
   * @param {{ apiFetch: Function, onStatus: Function, tabId: number|null }} opts
   */
  constructor(opts) {
    this.apiFetch = opts.apiFetch;
    this.onStatus = opts.onStatus || (() => {});
    this.tabId = opts.tabId;
    this.chunks = [];
    this.title = "";
    this.url = "";
    this.speakerId = "";
    this.speed = 1;
    this.volume = 0.8;
    this.jobId = null;
    this._jobOffset = 0;
    this.index = 0;
    this.playing = false;
    this.paused = false;
    this.waiting = false;
    this.aborted = false;
    this.durations = [];
    this.buffersReady = new Set();
    this.episodesRead = 1;
    this._skipToken = 0;
  }

  async ensureOffscreen() {
    await ensureOffscreen();
  }

  invalidateOffscreenBuffers() {
    this.buffersReady.clear();
  }

  async sendOffscreen(msg) {
    await this.ensureOffscreen();
    let lastErr;
    for (let i = 0; i < 8; i++) {
      try {
        const res = await chrome.runtime.sendMessage(msg);
        return res;
      } catch (e) {
        lastErr = e;
        await sleep(100);
      }
    }
    throw lastErr || new Error("Offscreen に接続できません");
  }

  emit() {
    const played = this.durations
      .slice(0, this.index)
      .reduce((a, d) => a + (d || 0), 0);
    let total = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.durations[i] != null) total += this.durations[i];
      else total += Math.max(1, this.chunks[i].length / CHARS_PER_SEC / this.speed);
    }
    this.onStatus({
      title: this.title,
      index: this.index,
      total: this.chunks.length,
      currentText: this.chunks[this.index] || "",
      nextText: this.chunks[this.index + 1] || "",
      playedSecs: played / this.speed,
      totalSecs: total,
      playing: this.playing && !this.paused,
      paused: this.paused,
      waiting: this.waiting,
      stopped: this.aborted && !this.playing,
      episodesRead: this.episodesRead,
      jobId: this.jobId,
    });
  }

  async start({ title, url, chunks, speakerId, speed, volume, episodesRead }) {
    await this.stop(false);
    this.aborted = false;
    this.title = title || "";
    this.url = url || "";
    this.chunks = chunks.filter((c) => c && String(c).trim());
    this.speakerId = speakerId;
    this.speed = speed || 1;
    this.volume = volume ?? 0.8;
    this.index = 0;
    this._jobOffset = 0;
    this.durations = new Array(this.chunks.length).fill(null);
    this.buffersReady = new Set();
    this.playing = true;
    this.paused = false;
    this.waiting = false;
    this.episodesRead = episodesRead || 1;

    if (this.chunks.length === 0) throw new Error("読み上げる本文がありません");

    const lines = this.chunks.map((text) => ({
      text,
      speaker: this.speakerId,
    }));
    try {
      await this.sendOffscreen({
        type: "OFFSCREEN_SESSION_START",
        rate: this.speed,
        gain: this.volume,
      });
      const job = await this.apiFetch("/v1/jobs", {
        method: "POST",
        body: { lines, format: "wav" },
      });
      this.jobId = job.jobId;
      this.emit();
      return await this.runLoop();
    } catch (e) {
      try {
        await this.stop(true);
      } catch (_) {
        /* ignore */
      }
      throw e;
    }
  }

  async runLoop() {
    while (!this.aborted && this.index < this.chunks.length) {
      if (this.paused) {
        await sleep(100);
        continue;
      }
      await this.prefetchAround(this.index);

      const skipAtStart = this._skipToken;
      try {
        const ready = await this.waitForChunk(this.index);
        if (!ready || this.aborted) break;
      } catch (e) {
        this.playing = false;
        this.waiting = false;
        this.emit();
        throw e;
      }

      this.waiting = false;
      this.emit();
      await this.highlight(this.index);

      if (this._skipToken !== skipAtStart) continue;

      const playToken = this._skipToken;
      await this.playChunk(this.index);
      if (this.aborted) break;
      if (this._skipToken !== playToken) {
        // seek/skip adjusted index already
        continue;
      }
      this.index += 1;
      this.emit();
    }

    if (!this.aborted && this.index >= this.chunks.length) {
      this.playing = false;
      this.emit();
      await this.sendOffscreen({ type: "OFFSCREEN_SESSION_END" });
      await this.clearHighlight();
      return { done: true };
    }
    return { done: false };
  }

  async prefetchAround(from) {
    const end = Math.min(this.chunks.length, from + PREFETCH + 1);
    for (let i = from; i < end; i++) {
      if (this.buffersReady.has(i) || this.aborted) continue;
      void this.fetchChunk(i).catch(() => {});
    }
  }

  async fetchChunk(i) {
    if (this.buffersReady.has(i)) return true;
    const text = this.chunks[i];
    const key = await cacheKey({
      url: this.url,
      text,
      speakerId: this.speakerId,
      speed: 1,
    });
    let blob = await getCached(key);
    if (!blob) {
      if (!this.jobId) return false;
      const jobLine = i - this._jobOffset;
      if (jobLine < 0) return false;
      for (;;) {
        if (this.aborted) return false;
        const st = await this.apiFetch(`/v1/jobs/${this.jobId}`);
        const line = (st.lines || [])[jobLine];
        if (!line) return false;
        if (line.status === "failed") {
          throw new Error(line.error || `チャンク ${i} の合成に失敗しました`);
        }
        if (line.status === "cancelled") return false;
        if (line.status === "done" || line.ready) break;
        this.waiting = true;
        this.emit();
        await sleep(400);
      }
      const { buf } = await this.apiFetch(
        `/v1/jobs/${this.jobId}/lines/${jobLine}`,
        { expectBinary: true },
      );
      blob = new Blob([buf], { type: "audio/wav" });
      void putCached(key, blob);
      try {
        const st = await this.apiFetch(`/v1/jobs/${this.jobId}`);
        const line = (st.lines || [])[jobLine];
        if (line?.durationSecs != null) this.durations[i] = line.durationSecs;
      } catch (_) {
        /* ignore */
      }
    }

    const ab = await blob.arrayBuffer();
    await this.sendOffscreen({
      type: "OFFSCREEN_QUEUE_CHUNK",
      index: i,
      audioBase64: arrayBufferToBase64(ab),
      mimeType: "audio/wav",
    });
    this.buffersReady.add(i);
    this.emit();
    return true;
  }

  async waitForChunk(i) {
    while (!this.aborted) {
      if (this.paused) {
        await sleep(100);
        continue;
      }
      if (this.buffersReady.has(i)) return true;
      this.waiting = true;
      this.emit();
      await this.fetchChunk(i);
      if (this.buffersReady.has(i)) return true;
      await sleep(300);
    }
    return false;
  }

  async playChunk(i) {
    const res = await this.sendOffscreen({
      type: "OFFSCREEN_PLAY_INDEX",
      index: i,
    });
    if (res && res.ok === false) throw new Error(res.error || "再生失敗");
    return this.waitUntilChunkDone(i);
  }

  async waitUntilChunkDone(i) {
    const token = this._skipToken;
    let sawPlaying = false;
    for (;;) {
      if (this.aborted || this._skipToken !== token) return false;
      if (this.paused) {
        await sleep(100);
        continue;
      }
      const st = await this.sendOffscreen({ type: "OFFSCREEN_GET_STATE" });
      if (st?.durationSecs != null && this.durations[i] == null) {
        this.durations[i] = st.durationSecs;
      }
      if (st?.paused) {
        await sleep(60);
        continue;
      }
      if (st && st.chunkPlaying && st.currentIndex === i) {
        sawPlaying = true;
        await sleep(60);
        continue;
      }
      if (st && st.lastFinishedIndex === i) return true;
      if (sawPlaying && st && !st.chunkPlaying && !st.paused) return true;
      await sleep(60);
    }
  }

  async highlight(i) {
    if (this.tabId == null) return;
    try {
      await chrome.tabs.sendMessage(this.tabId, {
        type: "IRODORI_HIGHLIGHT",
        index: i,
        text: this.chunks[i],
        total: this.chunks.length,
      });
    } catch (_) {
      /* ignore */
    }
  }

  async clearHighlight() {
    if (this.tabId == null) return;
    try {
      await chrome.tabs.sendMessage(this.tabId, {
        type: "IRODORI_CLEAR_HIGHLIGHT",
      });
    } catch (_) {
      /* ignore */
    }
  }

  async pause() {
    this.paused = true;
    await this.sendOffscreen({ type: "OFFSCREEN_PAUSE" });
    this.emit();
  }

  async resume() {
    this.paused = false;
    await this.sendOffscreen({ type: "OFFSCREEN_RESUME" });
    this.emit();
  }

  async togglePause() {
    if (this.paused) await this.resume();
    else await this.pause();
  }

  async stop(cancelJob = true) {
    this.aborted = true;
    this.playing = false;
    this.paused = false;
    this._skipToken++;
    if (cancelJob && this.jobId) {
      try {
        await this.apiFetch(`/v1/jobs/${this.jobId}/cancel`, { method: "POST" });
      } catch (_) {
        /* ignore */
      }
    }
    this.jobId = null;
    try {
      await this.sendOffscreen({ type: "OFFSCREEN_STOP" });
    } catch (_) {
      /* ignore */
    }
    await this.clearHighlight();
    this.waiting = false;
    this.chunks = [];
    this.title = "";
    this.index = 0;
    this.durations = [];
    this.buffersReady = new Set();
    this.episodesRead = 1;
    this.emit();
  }

  async next() {
    if (this.index >= this.chunks.length - 1) return;
    this._skipToken++;
    this.index = Math.min(this.chunks.length - 1, this.index + 1);
    await this.sendOffscreen({ type: "OFFSCREEN_STOP_CHUNK" });
    this.emit();
  }

  async prev() {
    this._skipToken++;
    this.index = Math.max(0, this.index - 1);
    await this.sendOffscreen({ type: "OFFSCREEN_STOP_CHUNK" });
    this.emit();
  }

  async seekTo(index) {
    if (index < 0 || index >= this.chunks.length) return;
    this._skipToken++;
    this.index = index;
    await this.sendOffscreen({ type: "OFFSCREEN_STOP_CHUNK" });
    this.emit();
  }

  async setRate(rate) {
    this.speed = rate;
    await this.sendOffscreen({ type: "OFFSCREEN_SET_RATE", rate });
    this.emit();
  }

  async setGain(gain) {
    this.volume = gain;
    await this.sendOffscreen({ type: "OFFSCREEN_SET_GAIN", gain });
  }

  async changeSpeaker(speakerId) {
    this.speakerId = speakerId;
    if (!this.playing) return;
    if (this.jobId) {
      try {
        await this.apiFetch(`/v1/jobs/${this.jobId}/cancel`, { method: "POST" });
      } catch (_) {
        /* ignore */
      }
    }
    this.buffersReady = new Set(
      [...this.buffersReady].filter((i) => i < this.index),
    );
    const remain = this.chunks.slice(this.index);
    const lines = remain.map((text) => ({ text, speaker: speakerId }));
    if (lines.length === 0) return;
    const job = await this.apiFetch("/v1/jobs", {
      method: "POST",
      body: { lines, format: "wav" },
    });
    this.jobId = job.jobId;
    this._jobOffset = this.index;
    this.emit();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
