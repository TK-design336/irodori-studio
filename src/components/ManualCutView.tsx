import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useTauriFileDrop } from "../lib/tauriFileDrop";
import type { AppSettings } from "../types";
import { DEFAULT_VOCAL_SEPARATOR_MODEL } from "../types";

type Props = {
  settings: AppSettings;
};

type CutSpeaker = {
  id: string;
  name: string;
  color: string;
};

type CutClip = {
  id: string;
  startSec: number;
  endSec: number;
  speakerId: string;
};

/** 基本: 終了でマーク解除 / 分割: 終了位置が次クリップの開始になる */
type CutMode = "basic" | "split";

type WaveformData = {
  peaks: Float32Array;
  durationSec: number;
};

type ManualCutWorkspace = {
  schemaVersion: number;
  sourcePath: string;
  vocalsRel?: string | null;
  separatedVideo: boolean;
  speakers: CutSpeaker[];
  activeSpeakerId: string;
  clips: CutClip[];
  playbackRate: number;
  currentTimeSec: number;
  zoomOriginSec: number;
  selectedClipId?: string | null;
  markInSec?: number | null;
};

const ZOOM_WINDOW_OPTIONS = [15, 10, 5] as const;
type ZoomWindowSec = (typeof ZOOM_WINDOW_OPTIONS)[number];
const DEFAULT_ZOOM_WINDOW_SEC: ZoomWindowSec = 15;
const MIN_CLIP_SEC = 0.05;
const FINE_STEP = 0.05;
const COARSE_STEP = 0.5;
const WAVE_PEAKS_PER_SEC = 200;
const WAVE_BINS_MIN = 4096;
const WAVE_BINS_MAX = 500_000;
const VIDEO_EXT_RE = /\.(mp4|mkv|webm|mov|m4v)$/i;

/** テーマごとの実色は App.css の --cut-speaker-N で定義 */
const SPEAKER_COLORS = [
  "var(--cut-speaker-1)",
  "var(--cut-speaker-2)",
  "var(--cut-speaker-3)",
  "var(--cut-speaker-4)",
  "var(--cut-speaker-5)",
  "var(--cut-speaker-6)",
];

/** 旧作業ファイルの color-mix 色などを現行パレットへ置き換える */
function normalizeSpeakerColors(list: CutSpeaker[]): CutSpeaker[] {
  return list.map((s, i) =>
    SPEAKER_COLORS.includes(s.color)
      ? s
      : { ...s, color: SPEAKER_COLORS[i % SPEAKER_COLORS.length] },
  );
}

const MEDIA_EXTENSIONS = [
  "mp3",
  "mp4",
  "wav",
  "m4a",
  "flac",
  "ogg",
  "webm",
  "mkv",
  "aac",
] as const;

const MEDIA_FILTERS = [
  {
    name: "音声・動画",
    extensions: [...MEDIA_EXTENSIONS],
  },
];

const WORKSPACE_FILTERS = [
  { name: "Irodori Cut JSON", extensions: ["json"] },
];

const MEDIA_EXT_RE = new RegExp(
  `\\.(${MEDIA_EXTENSIONS.join("|")})$`,
  "i",
);

function isMediaFilePath(path: string): boolean {
  return MEDIA_EXT_RE.test(path);
}

function isWorkspaceFilePath(path: string): boolean {
  return /\.json$/i.test(path);
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.000";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function nextSpeakerName(existing: CutSpeaker[]): string {
  const used = new Set(existing.map((s) => s.name));
  for (let i = 0; i < 26; i++) {
    const name = `話者${String.fromCharCode(65 + i)}`;
    if (!used.has(name)) return name;
  }
  return `話者${existing.length + 1}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function isVideoFile(path: string): boolean {
  return VIDEO_EXT_RE.test(path);
}

/** `C:\a\b\foo.bar.mp3` → `foo.bar` */
function pathFileStem(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() || "";
  if (!base) return "manual-cut";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function applyPitchPreserve(el: HTMLMediaElement, rate: number) {
  el.playbackRate = rate;
  (el as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = true;
  // @ts-expect-error vendor
  el.mozPreservesPitch = true;
  // @ts-expect-error vendor
  el.webkitPreservesPitch = true;
}

async function waitSeeked(
  el: HTMLMediaElement,
  t: number,
  timeoutMs = 900,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("seeked", onSeeked);
      resolve();
    };
    const onSeeked = () => finish();
    el.addEventListener("seeked", onSeeked);
    try {
      el.currentTime = t;
    } catch {
      finish();
      return;
    }
    window.setTimeout(finish, timeoutMs);
  });
}

/**
 * 短時間 RMS + ピークの振幅包絡。
 * ビン境界は floor(i * n / bins) で切り、末尾サンプル欠落と比例ズレを防ぐ。
 */
async function loadWavePeaks(path: string): Promise<WaveformData | null> {
  try {
    const url = convertFileSrc(path);
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      const ch = decoded.getChannelData(0);
      const sampleCount = ch.length;
      const bins = clamp(
        Math.ceil(decoded.duration * WAVE_PEAKS_PER_SEC),
        WAVE_BINS_MIN,
        WAVE_BINS_MAX,
      );
      const peaks = new Float32Array(bins);
      for (let i = 0; i < bins; i++) {
        const start = Math.floor((i * sampleCount) / bins);
        const end = Math.floor(((i + 1) * sampleCount) / bins);
        let peak = 0;
        let sumSquares = 0;
        const hi = Math.max(start + 1, end);
        for (let j = start; j < hi; j++) {
          const v = ch[j] ?? 0;
          peak = Math.max(peak, Math.abs(v));
          sumSquares += v * v;
        }
        const count = Math.max(1, hi - start);
        const rms = Math.sqrt(sumSquares / count);
        peaks[i] = rms * 0.72 + peak * 0.28;
      }
      return { peaks, durationSec: decoded.duration };
    } finally {
      void ctx.close();
    }
  } catch {
    return null;
  }
}

export function ManualCutView({ settings }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const clipsListRef = useRef<HTMLDivElement | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [vocalsPath, setVocalsPath] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [showVideo, setShowVideo] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playlistPlaying, setPlaylistPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [cutMode, setCutMode] = useState<CutMode>("basic");
  const [speakers, setSpeakers] = useState<CutSpeaker[]>(() => [
    { id: "sp-a", name: "話者A", color: SPEAKER_COLORS[0] },
  ]);
  const [activeSpeakerId, setActiveSpeakerId] = useState("sp-a");
  const [clips, setClips] = useState<CutClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [zoomOrigin, setZoomOrigin] = useState(0);
  const [zoomWindowSec, setZoomWindowSec] = useState<ZoomWindowSec>(
    DEFAULT_ZOOM_WINDOW_SEC,
  );
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const clipStopRef = useRef<number | null>(null);
  const playlistActiveRef = useRef(false);
  const playlistClipIdRef = useRef<string | null>(null);
  const clipsRef = useRef<CutClip[]>([]);
  const selectedClipIdRef = useRef<string | null>(null);
  const dragModeRef = useRef<null | "seek" | "start" | "end">(null);
  const dragClipIdRef = useRef<string | null>(null);
  /** `,`/`<` または `.`/`>` 押下中（選択クリップの端移動用） */
  const edgeHoldRef = useRef<{ start: boolean; end: boolean }>({
    start: false,
    end: false,
  });
  /** Ctrl 押下中に他キーと組み合わせたか（単押し判定用） */
  const ctrlChordRef = useRef(false);
  const shortcutsWrapRef = useRef<HTMLDivElement | null>(null);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const zoomOriginRef = useRef(0);
  const zoomWindowSecRef = useRef<ZoomWindowSec>(DEFAULT_ZOOM_WINDOW_SEC);
  const rateRef = useRef(1);

  const timelinePath = vocalsPath || sourcePath;
  const audioUrl = timelinePath ? convertFileSrc(timelinePath) : "";
  const videoUrl =
    showVideo && sourcePath ? convertFileSrc(sourcePath) : "";

  currentTimeRef.current = currentTime;
  durationRef.current = duration;
  zoomOriginRef.current = zoomOrigin;
  zoomWindowSecRef.current = zoomWindowSec;
  rateRef.current = rate;
  clipsRef.current = clips;
  selectedClipIdRef.current = selectedClipId;

  const activeSpeaker = useMemo(
    () => speakers.find((s) => s.id === activeSpeakerId) ?? speakers[0],
    [activeSpeakerId, speakers],
  );

  const selectedClip = useMemo(
    () => clips.find((c) => c.id === selectedClipId) ?? null,
    [clips, selectedClipId],
  );

  const zoomWindow = useMemo(() => {
    if (!(duration > 0)) {
      return { start: 0, end: zoomWindowSec, width: zoomWindowSec };
    }
    const width = Math.min(zoomWindowSec, duration);
    const start = clamp(zoomOrigin, 0, Math.max(0, duration - width));
    return { start, end: start + width, width };
  }, [duration, zoomOrigin, zoomWindowSec]);

  const stopPlaylist = useCallback(() => {
    playlistActiveRef.current = false;
    playlistClipIdRef.current = null;
    setPlaylistPlaying(false);
  }, []);

  const pauseAll = useCallback(() => {
    audioRef.current?.pause();
    videoRef.current?.pause();
    setPlaying(false);
  }, []);

  const syncVideoToAudio = useCallback((t: number) => {
    const video = videoRef.current;
    if (!video || !showVideo) return;
    if (Math.abs(video.currentTime - t) > 0.04) {
      video.currentTime = t;
    }
  }, [showVideo]);

  const seekImmediate = useCallback(
    (t: number, opts?: { cancelPlaylist?: boolean }) => {
      const audio = audioRef.current;
      const dur = durationRef.current;
      if (!audio || !(dur > 0)) return;
      if (opts?.cancelPlaylist !== false) {
        stopPlaylist();
        clipStopRef.current = null;
      }
      const next = clamp(t, 0, dur);
      audio.currentTime = next;
      syncVideoToAudio(next);
      setCurrentTime(next);
    },
    [stopPlaylist, syncVideoToAudio],
  );

  const seekTo = useCallback(
    async (t: number, opts?: { cancelPlaylist?: boolean }) => {
      const audio = audioRef.current;
      const dur = durationRef.current;
      if (!audio || !(dur > 0)) return;
      if (opts?.cancelPlaylist !== false) {
        stopPlaylist();
        clipStopRef.current = null;
      }
      const next = clamp(t, 0, dur);
      const waits = [waitSeeked(audio, next)];
      const video = videoRef.current;
      if (video && showVideo) waits.push(waitSeeked(video, next));
      await Promise.all(waits);
      setCurrentTime(next);
    },
    [showVideo, stopPlaylist],
  );

  const stopAtClipEnd = useCallback(
    (stopAt: number) => {
      if (clipStopRef.current == null) return;
      clipStopRef.current = null;
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      videoRef.current?.pause();
      audio.currentTime = stopAt;
      syncVideoToAudio(stopAt);
      setCurrentTime(stopAt);
      setPlaying(false);

      if (!playlistActiveRef.current) return;
      const currentId = playlistClipIdRef.current;
      const list = clipsRef.current;
      const idx = currentId ? list.findIndex((c) => c.id === currentId) : -1;
      const next = idx >= 0 ? list[idx + 1] : null;
      if (!next) {
        stopPlaylist();
        setStatus("連続再生が完了しました");
        return;
      }
      void (async () => {
        playlistClipIdRef.current = next.id;
        setSelectedClipId(next.id);
        clipStopRef.current = next.endSec;
        await seekTo(next.startSec, { cancelPlaylist: false });
        try {
          const a = audioRef.current;
          const v = videoRef.current;
          if (!a) return;
          if (v && showVideo) {
            await Promise.all([a.play(), v.play()]);
          } else {
            await a.play();
          }
          setPlaying(true);
        } catch (e) {
          stopPlaylist();
          setStatus(`連続再生失敗: ${e}`);
        }
      })();
    },
    [seekTo, showVideo, stopPlaylist, syncVideoToAudio],
  );

  const loadMediaSource = useCallback(
    (path: string) => {
      stopPlaylist();
      pauseAll();
      setSourcePath(path);
      setVocalsPath("");
      setShowVideo(isVideoFile(path));
      setWaveform(null);
      setMarkIn(null);
      setClips([]);
      setSelectedClipId(null);
      setCurrentTime(0);
      setZoomOrigin(0);
      setDuration(0);
      setWorkspacePath("");
      setStatus(`読み込み: ${path}`);
    },
    [pauseAll, stopPlaylist],
  );

  const pickMedia = async () => {
    const selected = await open({
      multiple: false,
      filters: MEDIA_FILTERS,
    });
    if (!selected || Array.isArray(selected)) return;
    loadMediaSource(selected);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) applyPitchPreserve(audio, rate);
    const video = videoRef.current;
    if (video) applyPitchPreserve(video, rate);
  }, [rate, audioUrl, videoUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;

    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
        const resumeAt = clamp(currentTimeRef.current, 0, audio.duration);
        if (resumeAt > 0) {
          audio.currentTime = resumeAt;
          syncVideoToAudio(resumeAt);
        }
      }
    };
    const onTime = () => {
      const t = audio.currentTime;
      setCurrentTime(t);
      syncVideoToAudio(t);
      const stopAt = clipStopRef.current;
      if (stopAt != null && t >= stopAt) {
        stopAtClipEnd(stopAt);
        return;
      }
      if (durationRef.current > zoomWindowSecRef.current) {
        const windowSec = zoomWindowSecRef.current;
        const half = windowSec / 2;
        const next = clamp(
          t - half,
          0,
          Math.max(0, durationRef.current - windowSec),
        );
        if (Math.abs(next - zoomOriginRef.current) > 0.2) {
          setZoomOrigin(next);
        }
      }
    };
    const onPlay = () => {
      setPlaying(true);
      const video = videoRef.current;
      if (video && showVideo && video.paused) {
        video.currentTime = audio.currentTime;
        void video.play().catch(() => undefined);
      }
    };
    const onPause = () => {
      videoRef.current?.pause();
      setPlaying(false);
    };
    const onEnded = () => {
      const stopAt = clipStopRef.current;
      if (stopAt != null) {
        stopAtClipEnd(stopAt);
        return;
      }
      stopPlaylist();
      setPlaying(false);
    };

    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioUrl, showVideo, stopAtClipEnd, stopPlaylist, syncVideoToAudio]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      const t = audio.currentTime;
      setCurrentTime(t);
      syncVideoToAudio(t);
      const stopAt = clipStopRef.current;
      if (stopAt != null && t >= stopAt) {
        stopAtClipEnd(stopAt);
        return;
      }
      if (durationRef.current > zoomWindowSecRef.current) {
        const windowSec = zoomWindowSecRef.current;
        const half = windowSec / 2;
        const next = clamp(
          t - half,
          0,
          Math.max(0, durationRef.current - windowSec),
        );
        if (Math.abs(next - zoomOriginRef.current) > 0.2) {
          setZoomOrigin(next);
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, stopAtClipEnd, syncVideoToAudio]);

  useEffect(() => {
    let cancelled = false;
    if (!timelinePath) {
      setWaveform(null);
      return;
    }
    void (async () => {
      const data = await loadWavePeaks(timelinePath);
      if (cancelled) return;
      setWaveform(data);
      if (data && durationRef.current > 0) {
        const diff = Math.abs(data.durationSec - durationRef.current);
        if (diff > 0.25) {
          setStatus(
            `波形長と再生長に差があります（波形 ${data.durationSec.toFixed(2)}s / 再生 ${durationRef.current.toFixed(2)}s）`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [timelinePath]);

  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 1;
    const cssH = canvas.clientHeight || 1;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!waveform || waveform.peaks.length === 0 || !(duration > 0)) return;

    const wavePeaks = waveform.peaks;
    const bins = wavePeaks.length;
    const mid = cssH / 2;
    const halfHeight = cssH * 0.44;
    const rootStyle = getComputedStyle(canvas);
    const accent =
      rootStyle.getPropertyValue("--accent").trim() || "#6b4cff";
    ctx.strokeStyle = accent;
    const { start, width } = zoomWindow;
    // UI 時間軸（音声マスター duration）で換算し、波形長と UI を一致させる
    const timelineDur = Math.max(0.001, duration);
    const i0 = (start / timelineDur) * bins;
    const i1 = ((start + width) / timelineDur) * bins;
    const span = Math.max(1e-6, i1 - i0);

    const visible: number[] = [];
    const sampleStart = clamp(Math.floor(i0), 0, bins - 1);
    const sampleEnd = clamp(Math.ceil(i1), sampleStart + 1, bins);
    const stride = Math.max(1, Math.floor((sampleEnd - sampleStart) / 4000));
    for (let i = sampleStart; i < sampleEnd; i += stride) {
      visible.push(wavePeaks[i] ?? 0);
    }
    visible.sort((a, b) => a - b);
    const norm = Math.max(
      0.0001,
      visible[Math.floor((visible.length - 1) * 0.99)] ?? 1,
    );

    const amplitudes = new Float32Array(Math.ceil(cssW) + 1);
    for (let x = 0; x <= cssW; x++) {
      const binPos = i0 + (x / cssW) * span;
      const left = clamp(Math.floor(binPos), 0, bins - 1);
      const right = clamp(left + 1, 0, bins - 1);
      const mix = binPos - Math.floor(binPos);
      const value =
        (wavePeaks[left] ?? 0) * (1 - mix) + (wavePeaks[right] ?? 0) * mix;
      amplitudes[x] = clamp(value / norm, 0, 1) * halfHeight;
    }

    ctx.globalAlpha = 0.18;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x <= cssW; x++) ctx.lineTo(x, mid - amplitudes[x]);
    for (let x = Math.floor(cssW); x >= 0; x--) {
      ctx.lineTo(x, mid + amplitudes[x]);
    }
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= cssW; x++) {
      const y = mid - amplitudes[x];
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let x = Math.floor(cssW); x >= 0; x--) {
      ctx.lineTo(x, mid + amplitudes[x]);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [waveform, zoomWindow, duration, clips, selectedClipId]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    stopPlaylist();
    clipStopRef.current = null;
    if (audio.paused) {
      try {
        const video = videoRef.current;
        if (video && showVideo) {
          await waitSeeked(video, audio.currentTime);
          await Promise.all([audio.play(), video.play()]);
        } else {
          await audio.play();
        }
      } catch (e) {
        pauseAll();
        setStatus(`再生失敗: ${e}`);
      }
    } else {
      pauseAll();
    }
  }, [audioUrl, pauseAll, showVideo, stopPlaylist]);

  const nudgeTime = useCallback(
    (delta: number) => {
      seekImmediate(currentTimeRef.current + delta);
    },
    [seekImmediate],
  );

  const patchSelectedEdge = useCallback(
    (edge: "start" | "end", delta: number) => {
      const id = selectedClipIdRef.current;
      if (!id) return;
      setClips((prev) =>
        prev.map((c) => {
          if (c.id !== id) return c;
          if (edge === "start") {
            const start = clamp(
              c.startSec + delta,
              0,
              c.endSec - MIN_CLIP_SEC,
            );
            return { ...c, startSec: start };
          }
          const end = clamp(
            c.endSec + delta,
            c.startSec + MIN_CLIP_SEC,
            durationRef.current || c.endSec + delta,
          );
          return { ...c, endSec: end };
        }),
      );
    },
    [],
  );

  const sortedClips = useCallback((list: CutClip[]) => {
    return [...list].sort(
      (a, b) =>
        a.startSec - b.startSec ||
        a.endSec - b.endSec ||
        a.id.localeCompare(b.id),
    );
  }, []);

  const clipDistance = (t: number, c: CutClip) => {
    if (t < c.startSec) return c.startSec - t;
    if (t > c.endSec) return t - c.endSec;
    return 0;
  };

  const findNearestClip = useCallback(
    (direction: "past" | "future") => {
      const list = clipsRef.current;
      if (list.length === 0) return null;
      const t = currentTimeRef.current;
      if (direction === "past") {
        const past = list.filter((c) => c.endSec <= t);
        if (past.length > 0) {
          return past.reduce((best, c) =>
            c.endSec > best.endSec ? c : best,
          );
        }
      } else {
        const future = list.filter((c) => c.startSec >= t);
        if (future.length > 0) {
          return future.reduce((best, c) =>
            c.startSec < best.startSec ? c : best,
          );
        }
      }
      return list.reduce((best, c) =>
        clipDistance(t, c) < clipDistance(t, best) ? c : best,
      );
    },
    [],
  );

  const selectAdjacentClip = useCallback(
    (direction: "past" | "future") => {
      const list = clipsRef.current;
      if (list.length === 0) {
        setStatus("クリップがありません");
        return;
      }
      const ordered = sortedClips(list);
      const selectedId = selectedClipIdRef.current;
      let next: CutClip | null = null;
      if (selectedId) {
        const idx = ordered.findIndex((c) => c.id === selectedId);
        if (idx >= 0) {
          next =
            direction === "past"
              ? ordered[idx - 1] ?? null
              : ordered[idx + 1] ?? null;
          if (!next) {
            setStatus(
              direction === "past"
                ? "これより前のクリップはありません"
                : "これより後のクリップはありません",
            );
            return;
          }
        }
      }
      if (!next) {
        next = findNearestClip(direction);
      }
      if (!next) return;
      stopPlaylist();
      clipStopRef.current = null;
      setSelectedClipId(next.id);
      setMarkIn(null);
      seekImmediate(next.startSec);
      if (durationRef.current > zoomWindowSecRef.current) {
        setZoomOrigin(
          clamp(
            next.startSec - zoomWindowSecRef.current / 2,
            0,
            durationRef.current - zoomWindowSecRef.current,
          ),
        );
      }
      const sp = speakers.find((s) => s.id === next!.speakerId);
      setStatus(
        `選択 ${formatTime(next.startSec)}–${formatTime(next.endSec)}（${sp?.name ?? "?"}）`,
      );
      requestAnimationFrame(() => {
        const el = clipsListRef.current?.querySelector(
          `[data-clip-id="${next!.id}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      });
    },
    [findNearestClip, seekImmediate, sortedClips, speakers, stopPlaylist],
  );

  const clearClipSelection = useCallback(() => {
    if (!selectedClipIdRef.current) return;
    setSelectedClipId(null);
    setStatus("クリップ選択を解除");
  }, []);

  const setStartMark = useCallback(() => {
    const t = currentTimeRef.current;
    if (selectedClip) {
      const end = selectedClip.endSec;
      if (t >= end - MIN_CLIP_SEC) {
        setStatus("開始は終了より前にしてください");
        return;
      }
      setClips((prev) =>
        prev.map((c) =>
          c.id === selectedClip.id ? { ...c, startSec: t } : c,
        ),
      );
      setStatus(`開始を ${formatTime(t)} に更新`);
      return;
    }
    setMarkIn(t);
    setStatus(`開始 ${formatTime(t)}`);
  }, [selectedClip]);

  const commitEndMark = useCallback(() => {
    const t = currentTimeRef.current;
    if (selectedClip) {
      const start = selectedClip.startSec;
      if (t <= start + MIN_CLIP_SEC) {
        setStatus("終了は開始より後にしてください");
        return;
      }
      setClips((prev) =>
        prev.map((c) =>
          c.id === selectedClip.id ? { ...c, endSec: t } : c,
        ),
      );
      setStatus(`終了を ${formatTime(t)} に更新`);
      return;
    }
    if (!activeSpeaker) {
      setStatus("話者を追加してください");
      return;
    }
    const start = markIn;
    if (start == null) {
      setStatus("先に開始を押してください");
      return;
    }
    if (t <= start + MIN_CLIP_SEC) {
      setStatus("終了は開始より後にしてください");
      return;
    }
    const id = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setClips((prev) => [
      ...prev,
      { id, startSec: start, endSec: t, speakerId: activeSpeaker.id },
    ]);
    setSelectedClipId(null);
    if (cutMode === "split") {
      setMarkIn(t);
      setStatus(
        `切り出し ${formatTime(start)}–${formatTime(t)}（${activeSpeaker.name}）→ 次の開始 ${formatTime(t)}`,
      );
    } else {
      setMarkIn(null);
      setStatus(
        `切り出し ${formatTime(start)}–${formatTime(t)}（${activeSpeaker.name}）`,
      );
    }
    requestAnimationFrame(() => {
      const el = clipsListRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [activeSpeaker, cutMode, markIn, selectedClip]);

  useEffect(() => {
    const isTypingTarget = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const updateEdgeHold = (ev: KeyboardEvent, down: boolean) => {
      if (
        ev.code === "Comma" ||
        ev.key === "," ||
        ev.key === "<" ||
        ev.key === "＜"
      ) {
        edgeHoldRef.current.start = down;
      }
      if (
        ev.code === "Period" ||
        ev.key === "." ||
        ev.key === ">" ||
        ev.key === "＞"
      ) {
        edgeHoldRef.current.end = down;
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.isComposing || ev.key === "Process") return;
      if (isTypingTarget(ev)) return;

      updateEdgeHold(ev, true);

      if (ev.key === "Control") {
        ctrlChordRef.current = false;
        return;
      }
      if (ev.ctrlKey || ev.metaKey) {
        ctrlChordRef.current = true;
      }

      if (!audioUrl) return;

      const isStartKey =
        ev.code === "BracketLeft" ||
        ev.key === "[" ||
        ev.key === "［" ||
        ev.key === "「";
      const isEndKey =
        ev.code === "BracketRight" ||
        ev.key === "]" ||
        ev.key === "］" ||
        ev.key === "」";

      if (ev.key === " " || ev.code === "Space") {
        ev.preventDefault();
        void togglePlay();
        return;
      }

      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        const dir = ev.key === "ArrowLeft" ? -1 : 1;
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          selectAdjacentClip(dir < 0 ? "past" : "future");
          return;
        }
        ev.preventDefault();
        const step = ev.shiftKey ? COARSE_STEP : FINE_STEP;
        const hold = edgeHoldRef.current;
        if (selectedClipIdRef.current && (hold.start || hold.end)) {
          // <> は Shift 併用が多いので、端移動中は常に細かいステップ
          const edgeStep = FINE_STEP;
          if (hold.start) patchSelectedEdge("start", dir * edgeStep);
          if (hold.end) patchSelectedEdge("end", dir * edgeStep);
          return;
        }
        nudgeTime(dir * step);
        return;
      }

      if (isStartKey) {
        ev.preventDefault();
        setStartMark();
        return;
      }
      if (isEndKey) {
        ev.preventDefault();
        commitEndMark();
      }
    };

    const onKeyUp = (ev: KeyboardEvent) => {
      updateEdgeHold(ev, false);
      if (ev.key !== "Control") return;
      if (isTypingTarget(ev)) return;
      if (!audioUrl) return;
      if (ctrlChordRef.current) return;
      clearClipSelection();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    const onBlur = () => {
      edgeHoldRef.current = { start: false, end: false };
      ctrlChordRef.current = false;
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    audioUrl,
    clearClipSelection,
    commitEndMark,
    nudgeTime,
    patchSelectedEdge,
    selectAdjacentClip,
    setStartMark,
    togglePlay,
  ]);

  useEffect(() => {
    if (!shortcutsOpen) return;
    const onPointer = (ev: PointerEvent) => {
      const root = shortcutsWrapRef.current;
      if (root && !root.contains(ev.target as Node)) {
        setShortcutsOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setShortcutsOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [shortcutsOpen]);

  const changeZoomWindowSec = (sec: ZoomWindowSec) => {
    setZoomWindowSec(sec);
    if (duration > sec) {
      setZoomOrigin(
        clamp(currentTime - sec / 2, 0, Math.max(0, duration - sec)),
      );
    } else {
      setZoomOrigin(0);
    }
  };

  const selectClip = (
    clip: CutClip,
    opts?: { fromList?: boolean },
  ) => {
    stopPlaylist();
    clipStopRef.current = null;
    setSelectedClipId(clip.id);
    setMarkIn(null);
    const visibleInZoom =
      clip.endSec >= zoomWindow.start && clip.startSec <= zoomWindow.end;
    // 一覧クリックかつ拡大窓に一部でも見えているときはシークせず選択のみ
    if (opts?.fromList && visibleInZoom) {
      return;
    }
    seekImmediate(clip.startSec);
    if (duration > zoomWindowSec) {
      setZoomOrigin(
        clamp(
          clip.startSec - zoomWindowSec / 2,
          0,
          duration - zoomWindowSec,
        ),
      );
    }
  };

  const playClip = async (clip: CutClip) => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    stopPlaylist();
    setSelectedClipId(clip.id);
    clipStopRef.current = clip.endSec;
    try {
      await seekTo(clip.startSec, { cancelPlaylist: false });
      const video = videoRef.current;
      if (video && showVideo) {
        await Promise.all([audio.play(), video.play()]);
      } else {
        await audio.play();
      }
      setPlaying(true);
    } catch (e) {
      pauseAll();
      setStatus(`再生失敗: ${e}`);
    }
  };

  const startPlaylist = async () => {
    if (clips.length === 0 || !audioUrl) return;
    const first = clips[0];
    if (!first) return;
    playlistActiveRef.current = true;
    playlistClipIdRef.current = first.id;
    setPlaylistPlaying(true);
    setSelectedClipId(first.id);
    clipStopRef.current = first.endSec;
    try {
      await seekTo(first.startSec, { cancelPlaylist: false });
      const audio = audioRef.current;
      const video = videoRef.current;
      if (!audio) return;
      if (video && showVideo) {
        await Promise.all([audio.play(), video.play()]);
      } else {
        await audio.play();
      }
      setPlaying(true);
      setStatus("連続再生中…");
    } catch (e) {
      stopPlaylist();
      pauseAll();
      setStatus(`連続再生失敗: ${e}`);
    }
  };

  const togglePlaylist = () => {
    if (playlistPlaying) {
      stopPlaylist();
      clipStopRef.current = null;
      pauseAll();
      setStatus("連続再生を停止しました");
      return;
    }
    void startPlaylist();
  };

  const addSpeaker = () => {
    const id = `sp-${Date.now()}`;
    const color = SPEAKER_COLORS[speakers.length % SPEAKER_COLORS.length];
    const name = nextSpeakerName(speakers);
    setSpeakers((prev) => [...prev, { id, name, color }]);
    setActiveSpeakerId(id);
  };

  const removeActiveSpeaker = () => {
    if (speakers.length <= 1 || !activeSpeaker) return;
    const remaining = speakers.filter((s) => s.id !== activeSpeaker.id);
    const replacement = remaining[0];
    if (!replacement) return;
    const assignedCount = clips.filter(
      (c) => c.speakerId === activeSpeaker.id,
    ).length;
    if (
      assignedCount > 0 &&
      !window.confirm(
        `${activeSpeaker.name} を削除しますか？\n割り当て済みの ${assignedCount} 件は ${replacement.name} へ移動します。`,
      )
    ) {
      return;
    }
    setSpeakers(remaining);
    setActiveSpeakerId(replacement.id);
    setClips((prev) =>
      prev.map((c) =>
        c.speakerId === activeSpeaker.id
          ? { ...c, speakerId: replacement.id }
          : c,
      ),
    );
    setStatus(
      assignedCount > 0
        ? `${activeSpeaker.name} を削除し、${assignedCount} 件を ${replacement.name} へ移動しました`
        : `${activeSpeaker.name} を削除しました`,
    );
  };

  const renameSpeaker = (id: string, name: string) => {
    setSpeakers((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name: name || s.name } : s)),
    );
  };

  const cycleActiveSpeaker = () => {
    if (speakers.length === 0) return;
    const i = speakers.findIndex((s) => s.id === activeSpeakerId);
    const next = speakers[(i + 1) % speakers.length];
    if (next) setActiveSpeakerId(next.id);
  };

  const changeClipSpeaker = (clipId: string, speakerId: string) => {
    setClips((prev) =>
      prev.map((c) => (c.id === clipId ? { ...c, speakerId } : c)),
    );
  };

  const removeClip = (clipId: string) => {
    if (playlistClipIdRef.current === clipId) {
      stopPlaylist();
      clipStopRef.current = null;
      pauseAll();
    }
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    if (selectedClipId === clipId) setSelectedClipId(null);
  };

  const timeFromOverviewClientX = (clientX: number) => {
    const el = overviewRef.current;
    if (!el || !(duration > 0)) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return ratio * duration;
  };

  const timeFromZoomClientX = (clientX: number) => {
    const el = zoomRef.current;
    if (!el) return zoomWindow.start;
    const rect = el.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return zoomWindow.start + ratio * zoomWindow.width;
  };

  const hitClipAt = (t: number): CutClip | null => {
    let best: CutClip | null = null;
    let bestLen = Infinity;
    for (const c of clips) {
      if (t >= c.startSec && t <= c.endSec) {
        const len = c.endSec - c.startSec;
        if (len < bestLen) {
          best = c;
          bestLen = len;
        }
      }
    }
    return best;
  };

  const onOverviewPointerDown = (ev: React.PointerEvent) => {
    if (!(duration > 0)) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    const t = timeFromOverviewClientX(ev.clientX);
    const hit = hitClipAt(t);
    if (hit) {
      selectClip(hit);
    } else {
      setSelectedClipId(null);
      seekImmediate(t);
    }
    dragModeRef.current = "seek";
  };

  const onOverviewPointerMove = (ev: React.PointerEvent) => {
    if (dragModeRef.current !== "seek") return;
    seekImmediate(timeFromOverviewClientX(ev.clientX));
  };

  const endDrag = () => {
    dragModeRef.current = null;
    dragClipIdRef.current = null;
  };

  const onZoomPointerDown = (ev: React.PointerEvent) => {
    if (!(duration > 0)) return;
    const target = ev.target as HTMLElement;
    const handle = target.dataset.handle as "start" | "end" | undefined;
    const clipId = target.dataset.clipId;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    if (handle && clipId) {
      dragModeRef.current = handle;
      dragClipIdRef.current = clipId;
      setSelectedClipId(clipId);
      return;
    }
    const t = timeFromZoomClientX(ev.clientX);
    const hit = hitClipAt(t);
    if (hit) {
      selectClip(hit);
    } else {
      setSelectedClipId(null);
      seekImmediate(t);
    }
    dragModeRef.current = "seek";
  };

  const onZoomPointerMove = (ev: React.PointerEvent) => {
    const mode = dragModeRef.current;
    if (!mode) return;
    const t = timeFromZoomClientX(ev.clientX);
    if (mode === "seek") {
      seekImmediate(t);
      return;
    }
    const clipId = dragClipIdRef.current;
    if (!clipId) return;
    setClips((prev) =>
      prev.map((c) => {
        if (c.id !== clipId) return c;
        if (mode === "start") {
          return {
            ...c,
            startSec: clamp(t, 0, c.endSec - MIN_CLIP_SEC),
          };
        }
        return {
          ...c,
          endSec: clamp(t, c.startSec + MIN_CLIP_SEC, duration || t),
        };
      }),
    );
  };

  const onZoomWheel = (ev: React.WheelEvent) => {
    if (!(duration > 0)) return;
    ev.preventDefault();
    const delta =
      Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    const unit = ev.deltaMode === 1 ? 0.04 : ev.deltaMode === 2 ? 0.5 : 0.0025;
    const deltaSec = clamp(delta * unit, -1, 1);
    seekImmediate(currentTimeRef.current + deltaSec);
  };

  const runVocalSeparate = async () => {
    if (!sourcePath) {
      setStatus("先にファイルを指定してください");
      return;
    }
    setBusy(true);
    setStatus("ボーカル分離中…（UIは操作できます）");
    try {
      const res = await invoke<{
        playPath: string;
        vocalsPath: string;
        isVideo: boolean;
      }>("manual_cut_separate_cmd", { sourcePath });
      pauseAll();
      stopPlaylist();
      setVocalsPath(res.vocalsPath);
      setShowVideo(res.isVideo || isVideoFile(sourcePath));
      setStatus(
        res.isVideo
          ? "ボーカル分離しました（映像ミュート＋分離音声をマスター再生）"
          : "ボーカル分離しました（再生ソースを差し替え）",
      );
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportClips = async () => {
    const exportSource = timelinePath;
    if (!exportSource) {
      setStatus("再生ソースがありません");
      return;
    }
    if (clips.length === 0) {
      setStatus("クリップがありません");
      return;
    }
    const dest = await open({ directory: true, multiple: false });
    if (!dest || Array.isArray(dest)) return;
    setBusy(true);
    setStatus("エクスポート中…（UIは操作できます）");
    try {
      const payload = clips.map((c) => {
        const sp = speakers.find((s) => s.id === c.speakerId);
        return {
          startSec: c.startSec,
          endSec: c.endSec,
          speakerName: sp?.name || "speaker",
        };
      });
      const n = await invoke<number>("manual_cut_export_cmd", {
        sourcePath: exportSource,
        destDir: dest,
        clips: payload,
        // 分離後 vocals でも、クリップ名は元素材名ベースにする
        nameStem: pathFileStem(sourcePath),
      });
      setStatus(`WAV を ${n} 件書き出しました → ${dest}`);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  };

  const buildWorkspace = (): ManualCutWorkspace => ({
    schemaVersion: 1,
    sourcePath,
    vocalsRel: vocalsPath ? "vocals.wav" : null,
    separatedVideo: showVideo && !!vocalsPath,
    speakers,
    activeSpeakerId,
    clips,
    playbackRate: rate,
    currentTimeSec: currentTime,
    zoomOriginSec: zoomOrigin,
    selectedClipId,
    markInSec: markIn,
  });

  const saveWorkspace = async () => {
    if (!sourcePath) {
      setStatus("先にファイルを指定してください");
      return;
    }
    const dest =
      workspacePath ||
      (await save({
        defaultPath: `${pathFileStem(sourcePath)}.irodori-cut.json`,
        filters: WORKSPACE_FILTERS,
      }));
    if (!dest || Array.isArray(dest)) return;
    setBusy(true);
    try {
      await invoke("manual_cut_workspace_save_cmd", {
        path: dest,
        workspace: buildWorkspace(),
        vocalsSrc: vocalsPath || null,
      });
      setWorkspacePath(dest);
      setStatus(`作業を保存しました → ${dest}`);
    } catch (e) {
      setStatus(`保存失敗: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const loadWorkspaceFromPath = useCallback(
    async (selected: string) => {
      setBusy(true);
      try {
        const res = await invoke<{
          workspace: {
            schemaVersion: number;
            sourcePath: string;
            vocalsRel?: string | null;
            separatedVideo: boolean;
            speakers: CutSpeaker[];
            activeSpeakerId: string;
            clips: Array<{
              id: string;
              startSec: number;
              endSec: number;
              speakerId: string;
            }>;
            playbackRate: number;
            currentTimeSec: number;
            zoomOriginSec: number;
            selectedClipId?: string | null;
            markInSec?: number | null;
          };
          vocalsPath: string | null;
        }>("manual_cut_workspace_load_cmd", { path: selected });

        const ws = res.workspace;
        const sourceOk = await invoke<boolean>("file_exists", {
          path: ws.sourcePath,
        });
        if (!sourceOk) {
          setStatus(
            `元素材が見つかりません: ${ws.sourcePath}\n作業は読み込まず現状を維持します`,
          );
          return;
        }

        stopPlaylist();
        pauseAll();
        setWorkspacePath(selected);
        setSourcePath(ws.sourcePath);
        setVocalsPath(res.vocalsPath || "");
        setShowVideo(ws.separatedVideo || isVideoFile(ws.sourcePath));
        setSpeakers(
          ws.speakers.length > 0
            ? normalizeSpeakerColors(ws.speakers)
            : [{ id: "sp-a", name: "話者A", color: SPEAKER_COLORS[0] }],
        );
        setActiveSpeakerId(
          ws.activeSpeakerId || ws.speakers[0]?.id || "sp-a",
        );
        setClips(ws.clips || []);
        setSelectedClipId(ws.selectedClipId ?? null);
        setMarkIn(ws.markInSec ?? null);
        setRate(clamp(ws.playbackRate || 1, 0.5, 2));
        setCurrentTime(ws.currentTimeSec || 0);
        setZoomOrigin(ws.zoomOriginSec || 0);
        setWaveform(null);
        setStatus(
          res.vocalsPath
            ? `作業を読み込みました（分離音声あり）→ ${selected}`
            : `作業を読み込みました → ${selected}`,
        );
      } catch (e) {
        setStatus(`読込失敗: ${e}`);
      } finally {
        setBusy(false);
      }
    },
    [pauseAll, stopPlaylist],
  );

  const openWorkspace = async () => {
    const selected = await open({
      multiple: false,
      filters: WORKSPACE_FILTERS,
    });
    if (!selected || Array.isArray(selected)) return;
    await loadWorkspaceFromPath(selected);
  };

  const handlePathsDrop = useCallback(
    (paths: string[]) => {
      if (busy) return;
      const path = paths[0];
      if (!path) return;
      if (isMediaFilePath(path)) {
        loadMediaSource(path);
        return;
      }
      if (isWorkspaceFilePath(path)) {
        void loadWorkspaceFromPath(path);
        return;
      }
      setStatus(
        "対応形式: mp3 / mp4 / wav / m4a / flac / ogg / webm / mkv / aac、または作業 JSON",
      );
    },
    [busy, loadMediaSource, loadWorkspaceFromPath],
  );

  useTauriFileDrop(rootRef, {
    enabled: !busy,
    onHover: setDropOver,
    onDrop: handlePathsDrop,
  });

  const modelHint =
    settings.vocalSeparatorModel?.trim() || DEFAULT_VOCAL_SEPARATOR_MODEL;

  const playheadPct =
    duration > 0 ? clamp((currentTime / duration) * 100, 0, 100) : 0;
  const zoomPlayheadPct =
    zoomWindow.width > 0
      ? clamp(
          ((currentTime - zoomWindow.start) / zoomWindow.width) * 100,
          0,
          100,
        )
      : 0;
  const pendingClip =
    markIn != null && currentTime >= markIn
      ? { startSec: markIn, endSec: currentTime }
      : null;

  return (
    <div
      ref={rootRef}
      className={`manual-cut${dropOver ? " is-drop-over" : ""}`}
    >
      {dropOver && (
        <div className="manual-cut-drop-overlay" aria-hidden>
          音声・動画、または作業 JSON をドロップ
        </div>
      )}
      <div className="row manual-cut-toolbar">
        <button type="button" onClick={() => void pickMedia()}>
          ファイルを指定
        </button>
        <button type="button" disabled={busy} onClick={() => void openWorkspace()}>
          作業を開く
        </button>
        <button
          type="button"
          disabled={!sourcePath || busy}
          onClick={() => void saveWorkspace()}
        >
          作業を保存
        </button>
        <span
          className="hint manual-cut-path"
          title={workspacePath || sourcePath}
        >
          {workspacePath
            ? workspacePath
            : sourcePath || "ここにドロップ、または mp3 / mp4 / wav などを選択"}
        </span>
        <div className="manual-cut-shortcuts-wrap" ref={shortcutsWrapRef}>
          <button
            type="button"
            className={`hint manual-cut-shortcuts${shortcutsOpen ? " is-open" : ""}`}
            onClick={() => setShortcutsOpen((v) => !v)}
            aria-expanded={shortcutsOpen}
            aria-controls="manual-cut-cheatsheet"
            title="クリックで操作一覧"
          >
            Space · ←→ · Shift+←→ · [ ] · 操作一覧
          </button>
          {shortcutsOpen && (
            <div
              id="manual-cut-cheatsheet"
              className="manual-cut-cheatsheet"
              role="dialog"
              aria-label="手動切り出しの操作一覧"
            >
              <div className="manual-cut-cheatsheet-head">操作一覧</div>
              <dl className="manual-cut-cheatsheet-list">
                <div>
                  <dt>Space</dt>
                  <dd>再生 / 一時停止</dd>
                </div>
                <div>
                  <dt>← →</dt>
                  <dd>0.05 秒シーク</dd>
                </div>
                <div>
                  <dt>Shift + ← →</dt>
                  <dd>0.5 秒シーク</dd>
                </div>
                <div>
                  <dt>[</dt>
                  <dd>開始マーク（選択中は開始を更新）</dd>
                </div>
                <div>
                  <dt>]</dt>
                  <dd>終了マーク（選択中は終了を更新）</dd>
                </div>
                <div>
                  <dt>{"<"} + ← →</dt>
                  <dd>選択中: 開始端を左右へ（, キーでも可）</dd>
                </div>
                <div>
                  <dt>{">"} + ← →</dt>
                  <dd>選択中: 終了端を左右へ（. キーでも可）</dd>
                </div>
                <div>
                  <dt>Ctrl + ← →</dt>
                  <dd>直前 / 直後のクリップを選択（未選択時は最寄り）</dd>
                </div>
                <div>
                  <dt>Ctrl 単押し</dt>
                  <dd>クリップ選択を解除</dd>
                </div>
              </dl>
            </div>
          )}
        </div>
        {sourcePath && (
          <span
            className={`manual-cut-source-badge${vocalsPath ? " is-vocals" : ""}`}
          >
            {vocalsPath ? "ボーカル音源を再生中" : "元音源を再生中"}
          </span>
        )}
        <button
          type="button"
          className="manual-cut-separate-button"
          disabled={!sourcePath || busy}
          onClick={() => void runVocalSeparate()}
          title={`モデル: ${modelHint}`}
        >
          {busy ? "分離中…" : vocalsPath ? "ボーカル再分離" : "ボーカル分離"}
        </button>
      </div>

      <div className="manual-cut-layout">
        <div className="manual-cut-main">
          <div
            className={`manual-cut-player${audioUrl ? " is-interactive" : ""}`}
            onClick={() => {
              if (!audioUrl) return;
              void togglePlay();
            }}
            title={audioUrl ? "クリックで再生／一時停止" : undefined}
          >
            {showVideo && videoUrl ? (
              <video
                ref={videoRef}
                key={`video-${sourcePath}`}
                src={videoUrl}
                controls={false}
                muted
                playsInline
              />
            ) : audioUrl ? (
              <div className="manual-cut-player-empty hint">
                音声タイムライン再生中（映像なし）
              </div>
            ) : (
              <div className="manual-cut-player-empty hint">
                ファイルをドロップ、または「ファイルを指定」で読み込みます
              </div>
            )}
            {audioUrl && (
              <audio
                ref={audioRef}
                key={`audio-${timelinePath}`}
                src={audioUrl}
                preload="auto"
                onClick={(e) => e.stopPropagation()}
                onLoadedMetadata={(e) => {
                  applyPitchPreserve(e.currentTarget, rateRef.current);
                  const resume = clamp(
                    currentTimeRef.current,
                    0,
                    e.currentTarget.duration || 0,
                  );
                  if (resume > 0) e.currentTarget.currentTime = resume;
                }}
                onError={() => setStatus("タイムライン音声の読み込みに失敗しました")}
              />
            )}
          </div>

          <div className="row manual-cut-transport">
            <div
              className="manual-cut-mode-toggle"
              role="group"
              aria-label="切り出しモード"
            >
              <button
                type="button"
                className={cutMode === "basic" ? "chip active" : "chip"}
                onClick={() => setCutMode("basic")}
                title="終了でクリップを確定し、開始マークをクリアします"
              >
                基本
              </button>
              <button
                type="button"
                className={cutMode === "split" ? "chip active" : "chip"}
                onClick={() => setCutMode("split")}
                title="終了位置がそのまま次クリップの開始マークになります"
              >
                分割
              </button>
            </div>
            <button
              type="button"
              className="primary"
              disabled={!audioUrl}
              onClick={() => void togglePlay()}
            >
              {playing ? "一時停止" : "再生"}
            </button>
            <button
              type="button"
              disabled={!audioUrl}
              onClick={setStartMark}
              title={
                selectedClip
                  ? "選択中クリップの開始を現在位置に（[）"
                  : "現在位置を開始に（[）"
              }
            >
              {selectedClip ? "開始を更新" : "開始 ["}
            </button>
            <button
              type="button"
              disabled={!audioUrl}
              onClick={commitEndMark}
              title={
                selectedClip
                  ? "選択中クリップの終了を現在位置に（]）"
                  : cutMode === "split"
                    ? "現在位置を終了にしてクリップ追加し、次の開始も打つ（]）"
                    : "現在位置を終了にしてクリップ追加（]）"
              }
            >
              {selectedClip ? "終了を更新" : "終了 ]"}
            </button>
            {selectedClip && (
              <button
                type="button"
                onClick={() => setSelectedClipId(null)}
                title="新規切り出しモードに戻る"
              >
                選択解除
              </button>
            )}
            <button
              type="button"
              className="manual-cut-speaker-cycle"
              disabled={!audioUrl || speakers.length === 0}
              onClick={cycleActiveSpeaker}
              title="次の切り出しに使う話者を切り替え"
              style={{
                background: `color-mix(in srgb, ${
                  activeSpeaker?.color || "var(--accent)"
                } 24%, var(--bg-soft))`,
                borderColor: `color-mix(in srgb, ${
                  activeSpeaker?.color || "var(--accent)"
                } 42%, var(--line))`,
              }}
            >
              <span
                className="manual-cut-speaker-cycle-swatch"
                style={{ background: activeSpeaker?.color || "var(--accent)" }}
                aria-hidden
              />
              話者: {activeSpeaker?.name ?? "—"}
            </button>
            <div className="manual-cut-speed-control">
              <span className="manual-cut-speed-label">速度</span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.01}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                aria-label="再生速度"
              />
              <input
                className="manual-cut-speed-number"
                type="number"
                min={0.5}
                max={2}
                step={0.01}
                value={rate}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value)) {
                    setRate(clamp(value, 0.5, 2));
                  }
                }}
                aria-label="再生速度の数値"
              />
              <button
                type="button"
                className="icon-btn"
                title="速度をリセット"
                disabled={rate === 1}
                onClick={() => setRate(1)}
              >
                ↺
              </button>
            </div>
          </div>

          <div className="manual-cut-timeline">
            {duration > 0 && (
              <div className="manual-cut-zoom-wrap">
                <div className="manual-cut-zoom-meta">
                  <span className="hint">
                    拡大 {formatTime(zoomWindow.start)} –{" "}
                    {formatTime(zoomWindow.end)}（約{" "}
                    {zoomWindow.width.toFixed(0)} 秒）
                  </span>
                  <div
                    className="manual-cut-zoom-scale"
                    role="group"
                    aria-label="拡大スケール"
                  >
                    {ZOOM_WINDOW_OPTIONS.map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        className={
                          zoomWindowSec === sec ? "chip active" : "chip"
                        }
                        onClick={() => changeZoomWindowSec(sec)}
                        title={`拡大表示を約 ${sec} 秒幅に`}
                      >
                        {sec}秒
                      </button>
                    ))}
                  </div>
                </div>
                <div
                  ref={zoomRef}
                  className="manual-cut-zoom"
                  title="ドラッグでシーク・ホイールで時間移動"
                  onPointerDown={onZoomPointerDown}
                  onPointerMove={onZoomPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onWheel={onZoomWheel}
                >
                  <canvas ref={waveCanvasRef} className="manual-cut-wave" />
                  {pendingClip &&
                    pendingClip.endSec >= zoomWindow.start &&
                    pendingClip.startSec <= zoomWindow.end && (
                      <div
                        className="manual-cut-zoom-region is-pending"
                        style={{
                          left: `${clamp(
                            ((pendingClip.startSec - zoomWindow.start) /
                              zoomWindow.width) *
                              100,
                            0,
                            100,
                          )}%`,
                          width: `${Math.max(
                            0.35,
                            clamp(
                              ((pendingClip.endSec - zoomWindow.start) /
                                zoomWindow.width) *
                                100,
                              0,
                              100,
                            ) -
                              clamp(
                                ((pendingClip.startSec - zoomWindow.start) /
                                  zoomWindow.width) *
                                  100,
                                0,
                                100,
                              ),
                          )}%`,
                          background: `color-mix(in srgb, ${
                            activeSpeaker?.color || "var(--accent)"
                          } 28%, transparent)`,
                        }}
                      >
                        <span className="manual-cut-pending-label">仮範囲</span>
                      </div>
                    )}
                  {clips.map((c) => {
                    if (
                      c.endSec < zoomWindow.start ||
                      c.startSec > zoomWindow.end
                    ) {
                      return null;
                    }
                    const sp = speakers.find((s) => s.id === c.speakerId);
                    const left =
                      ((c.startSec - zoomWindow.start) / zoomWindow.width) *
                      100;
                    const right =
                      ((c.endSec - zoomWindow.start) / zoomWindow.width) * 100;
                    const selected = c.id === selectedClipId;
                    const base = sp?.color || "var(--accent)";
                    return (
                      <div
                        key={c.id}
                        className={`manual-cut-zoom-region${
                          selected ? " is-selected" : ""
                        }`}
                        style={{
                          left: `${left}%`,
                          width: `${Math.max(0.5, right - left)}%`,
                          background: `color-mix(in srgb, ${base} 48%, transparent)`,
                        }}
                      >
                        {selected && (
                          <>
                            <span
                              className="manual-cut-handle is-start"
                              data-handle="start"
                              data-clip-id={c.id}
                            />
                            <span
                              className="manual-cut-handle is-end"
                              data-handle="end"
                              data-clip-id={c.id}
                            />
                          </>
                        )}
                      </div>
                    );
                  })}
                  <div
                    className="manual-cut-playhead"
                    style={{ left: `${zoomPlayheadPct}%` }}
                  />
                </div>
              </div>
            )}

            <div
              ref={overviewRef}
              className="manual-cut-overview"
              role="slider"
              aria-label="再生位置"
              aria-valuemin={0}
              aria-valuemax={duration || 0}
              aria-valuenow={currentTime}
              tabIndex={0}
              onPointerDown={onOverviewPointerDown}
              onPointerMove={onOverviewPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <div className="manual-cut-overview-track" />
              {duration > 0 &&
                clips.map((c) => {
                  const sp = speakers.find((s) => s.id === c.speakerId);
                  const left = (c.startSec / duration) * 100;
                  const width = ((c.endSec - c.startSec) / duration) * 100;
                  const base = sp?.color || "var(--accent)";
                  return (
                    <div
                      key={c.id}
                      className={`manual-cut-region${
                        c.id === selectedClipId ? " is-selected" : ""
                      }`}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(0.2, width)}%`,
                        background: `color-mix(in srgb, ${base} 55%, transparent)`,
                      }}
                      title={`${sp?.name ?? "?"} ${formatTime(c.startSec)}–${formatTime(c.endSec)}`}
                      aria-hidden
                    />
                  );
                })}
              <div
                className="manual-cut-playhead"
                style={{ left: `${playheadPct}%` }}
              />
            </div>
            <div className="row manual-cut-time-row">
              <span className="hint">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              {selectedClip ? (
                <span className="hint">
                  編集中 {formatTime(selectedClip.startSec)}–
                  {formatTime(selectedClip.endSec)}
                </span>
              ) : markIn != null ? (
                <span className="hint">開始マーク {formatTime(markIn)}</span>
              ) : null}
            </div>
          </div>
        </div>

        <aside className="manual-cut-side">
          <div className="manual-cut-side-head">
            <strong>切り出し済み</strong>
            <div className="manual-cut-side-actions">
              <span className="hint">{clips.length} 件</span>
              <button
                type="button"
                className={playlistPlaying ? "chip active" : "chip"}
                disabled={!audioUrl || clips.length === 0}
                onClick={togglePlaylist}
              >
                {playlistPlaying ? "連続停止" : "連続再生"}
              </button>
            </div>
          </div>
          <div className="manual-cut-clips" ref={clipsListRef}>
            {clips.length === 0 ? (
              <p className="hint">
                {cutMode === "split"
                  ? "開始 → 終了で追加。終了位置が次の開始になります"
                  : "開始 → 終了でクリップを追加します"}
              </p>
            ) : (
              clips.map((c, i) => {
                const sp = speakers.find((s) => s.id === c.speakerId);
                const selected = c.id === selectedClipId;
                return (
                  <div
                    key={c.id}
                    data-clip-id={c.id}
                    className={`manual-cut-clip${selected ? " is-selected" : ""}`}
                    onClick={() => selectClip(c, { fromList: true })}
                  >
                    <span
                      className="manual-cut-clip-badge"
                      style={{ background: sp?.color || "var(--accent)" }}
                    >
                      {i + 1}
                    </span>
                    <div className="manual-cut-clip-meta">
                      <span>
                        {formatTime(c.startSec)} – {formatTime(c.endSec)}
                      </span>
                      <span className="hint">
                        {(c.endSec - c.startSec).toFixed(2)}s
                      </span>
                      <select
                        className="manual-cut-clip-speaker"
                        value={c.speakerId}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          changeClipSpeaker(c.id, e.target.value)
                        }
                        aria-label="クリップの話者"
                      >
                        {speakers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="row" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => void playClip(c)}
                        disabled={!audioUrl}
                      >
                        ▶
                      </button>
                      <button type="button" onClick={() => removeClip(c.id)}>
                        削除
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <button
            type="button"
            className="primary"
            disabled={busy || clips.length === 0}
            onClick={() => void exportClips()}
          >
            エクスポート
          </button>
        </aside>
      </div>

      <section className="manual-cut-speaker-card">
        <div className="manual-cut-section-head">
          <div>
            <strong>話者設定</strong>
            <span className="hint">切り出し先の話者を選択</span>
          </div>
          <div className="manual-cut-speaker-actions">
            <button
              type="button"
              className="danger"
              disabled={speakers.length <= 1}
              onClick={removeActiveSpeaker}
              title={
                speakers.length <= 1
                  ? "話者は1人以上必要です"
                  : `${activeSpeaker?.name ?? "選択中の話者"}を削除`
              }
            >
              選択中を削除
            </button>
            <button type="button" onClick={addSpeaker}>
              ＋ 話者を追加
            </button>
          </div>
        </div>
        <div className="manual-cut-speakers">
          {speakers.map((s) => (
            <div
              key={s.id}
              className={`manual-cut-speaker-row${
                s.id === activeSpeakerId ? " is-active" : ""
              }`}
            >
              <span
                className="manual-cut-swatch"
                style={{ background: s.color }}
                aria-hidden
              />
              <input
                value={s.name}
                onChange={(e) => renameSpeaker(s.id, e.target.value)}
                aria-label="話者名"
              />
              <button
                type="button"
                className={s.id === activeSpeakerId ? "chip active" : "chip"}
                onClick={() => setActiveSpeakerId(s.id)}
              >
                選択
              </button>
            </div>
          ))}
        </div>
      </section>

      {status && <p className="hint manual-cut-status">{status}</p>}
    </div>
  );
}
