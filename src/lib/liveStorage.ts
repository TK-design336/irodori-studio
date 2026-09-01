import type { SamplingParams } from "../types";
import { defaultSampling } from "../types";

export type LiveItemStatus =
  | "queued"
  | "synthesizing"
  | "playing"
  | "done"
  | "error"
  | "cancelled";

export type LiveHistoryItem = {
  id: string;
  text: string;
  speakerEmbedPath: string;
  caption: string;
  sampling: SamplingParams;
  createdAt: string;
  status: LiveItemStatus;
  error?: string;
};

const HISTORY_KEY = "irodori-studio-live-history-v1";
const PREFS_KEY = "irodori-studio-live-prefs-v3";
export const MAX_HISTORY = 120;

export type LiveQualityPreset = "fast" | "standard" | "quality";

/** Enter = enqueue vs Ctrl/Cmd+Enter = enqueue */
export type LiveEnterKeyMode = "enter" | "ctrlEnter";

/** Hand-typed text vs continuous microphone input */
export type LiveInputMode = "text" | "mic";

/** Local sherpa-onnx vs browser Web Speech API */
export type LiveAsrEngine = "native" | "web-speech";

export type LivePrefs = {
  speakerEmbedPath: string;
  caption: string;
  qualityPreset: LiveQualityPreset;
  durationScale: number;
  cfgScaleSpeaker: number;
  volume: number;
  speed: number;
  enterKeyMode: LiveEnterKeyMode;
  inputMode: LiveInputMode;
  asrEngine: LiveAsrEngine;
  micAutoEnqueue: boolean;
  /** TTS 再生中にマイク認識を止める（オフ＝連続聞き取り優先） */
  micPauseDuringTts: boolean;
  micInputDeviceId: string;
};

export function liveSamplingForPreset(preset: LiveQualityPreset): SamplingParams {
  const base = defaultSampling();
  if (preset === "fast") return { ...base, numSteps: 25 };
  if (preset === "quality") return { ...base, numSteps: 50 };
  return base;
}

export function buildLiveSampling(prefs: LivePrefs): SamplingParams {
  const base = liveSamplingForPreset(prefs.qualityPreset);
  return {
    ...base,
    durationScale: prefs.durationScale,
    cfgScaleSpeaker: prefs.cfgScaleSpeaker,
  };
}

function clampVolume(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  // migrate legacy 0–200 percent storage
  const n = v > 3 ? v / 100 : v;
  return Math.min(2, Math.max(0, n));
}

function clampSpeed(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.min(2, Math.max(0.5, v));
}

function clampDurationScale(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return defaultSampling().durationScale;
  return Math.min(1.5, Math.max(0.5, v));
}

function clampCfgScaleSpeaker(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return defaultSampling().cfgScaleSpeaker;
  return Math.min(10, Math.max(0, v));
}

function parseInputMode(v: unknown): LiveInputMode {
  return v === "mic" ? "mic" : "text";
}

function parseAsrEngine(v: unknown): LiveAsrEngine {
  return v === "web-speech" ? "web-speech" : "native";
}

export function defaultLivePrefs(): LivePrefs {
  const d = defaultSampling();
  return {
    speakerEmbedPath: "",
    caption: "",
    qualityPreset: "standard",
    durationScale: d.durationScale,
    cfgScaleSpeaker: d.cfgScaleSpeaker,
    volume: 1,
    speed: 1,
    enterKeyMode: "enter",
    inputMode: "text",
    asrEngine: "native",
    micAutoEnqueue: true,
    micPauseDuringTts: false,
    micInputDeviceId: "",
  };
}

function parseEnterKeyMode(v: unknown): LiveEnterKeyMode {
  return v === "ctrlEnter" ? "ctrlEnter" : "enter";
}

export function loadLivePrefs(): LivePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      const legacy = localStorage.getItem("irodori-studio-live-prefs-v1");
      if (legacy) {
        const parsed = JSON.parse(legacy) as Partial<LivePrefs & { volume?: number }>;
        const preset = parsed.qualityPreset;
        return {
          ...defaultLivePrefs(),
          speakerEmbedPath:
            typeof parsed.speakerEmbedPath === "string" ? parsed.speakerEmbedPath : "",
          caption: typeof parsed.caption === "string" ? parsed.caption : "",
          qualityPreset:
            preset === "fast" || preset === "quality" || preset === "standard"
              ? preset
              : "standard",
          volume: clampVolume(parsed.volume),
        };
      }
      return defaultLivePrefs();
    }
    const parsed = JSON.parse(raw) as Partial<LivePrefs>;
    const preset = parsed.qualityPreset;
    return {
      speakerEmbedPath: typeof parsed.speakerEmbedPath === "string" ? parsed.speakerEmbedPath : "",
      caption: typeof parsed.caption === "string" ? parsed.caption : "",
      qualityPreset:
        preset === "fast" || preset === "quality" || preset === "standard"
          ? preset
          : "standard",
      durationScale: clampDurationScale(parsed.durationScale),
      cfgScaleSpeaker: clampCfgScaleSpeaker(parsed.cfgScaleSpeaker),
      volume: clampVolume(parsed.volume),
      speed: clampSpeed(parsed.speed),
      enterKeyMode: parseEnterKeyMode(parsed.enterKeyMode),
      inputMode: parseInputMode(parsed.inputMode),
      asrEngine: parseAsrEngine(parsed.asrEngine),
      micAutoEnqueue: parsed.micAutoEnqueue !== false,
      micPauseDuringTts: parsed.micPauseDuringTts === true,
      micInputDeviceId:
        typeof parsed.micInputDeviceId === "string" ? parsed.micInputDeviceId : "",
    };
  } catch {
    return defaultLivePrefs();
  }
}

export function saveLivePrefs(prefs: LivePrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function normalizeHistoryItem(raw: unknown): LiveHistoryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<LiveHistoryItem>;
  if (typeof o.id !== "string" || typeof o.text !== "string") return null;
  const status = o.status;
  const safeStatus: LiveItemStatus =
    status === "queued" ||
    status === "synthesizing" ||
    status === "playing" ||
    status === "done" ||
    status === "error" ||
    status === "cancelled"
      ? status
      : "done";
  const sampling =
    o.sampling && typeof o.sampling === "object"
      ? { ...defaultSampling(), ...(o.sampling as SamplingParams) }
      : defaultSampling();
  return {
    id: o.id,
    text: o.text,
    speakerEmbedPath: typeof o.speakerEmbedPath === "string" ? o.speakerEmbedPath : "",
    caption: typeof o.caption === "string" ? o.caption : "",
    sampling,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date().toISOString(),
    status:
      safeStatus === "queued" || safeStatus === "synthesizing" || safeStatus === "playing"
        ? "cancelled"
        : safeStatus,
    error: typeof o.error === "string" ? o.error : undefined,
  };
}

function chronologicalHistory(items: LiveHistoryItem[]): LiveHistoryItem[] {
  if (items.length < 2) return items;
  const first = Date.parse(items[0].createdAt);
  const last = Date.parse(items[items.length - 1].createdAt);
  if (Number.isFinite(first) && Number.isFinite(last) && first > last) {
    return items.slice().reverse();
  }
  return items;
}

export function loadLiveHistory(): LiveHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return chronologicalHistory(
      parsed.map(normalizeHistoryItem).filter((x): x is LiveHistoryItem => x != null),
    ).slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

export function saveLiveHistory(items: LiveHistoryItem[]): void {
  const trimmed = items.slice(-MAX_HISTORY).map((item) => ({
    ...item,
    status:
      item.status === "queued" || item.status === "synthesizing" || item.status === "playing"
        ? "cancelled"
        : item.status,
  }));
  localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
}
