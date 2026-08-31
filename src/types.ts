import type { AppliedReading } from "./lib/annotations";

export type IrodoriVersion = "v3" | "v4";

export type VersionPathSettings = {
  irodoriRoot: string;
  checkpointPath: string;
  outputsRoot: string;
  pythonExe: string;
};

/** Tokens for individual WAV export filenames (order configurable). */
export type ExportFilenamePart =
  | "project"
  | "index"
  | "speaker"
  | "utterance";

export type ExportAudioFormat = "wav" | "mp3" | "opus";

/** Slice review pipeline mode: skip / manual (default) / auto. */
export type SliceReviewMode = "skip" | "manual" | "auto";

export type SliceReviewAspectId =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J";

export type SliceReviewAspectFlags = Partial<
  Record<SliceReviewAspectId, boolean>
>;

/** Per-aspect thresholds (only relevant keys used per aspect). */
export type SliceReviewThresholds = {
  /** Shared |z| cutoff for C/D/F/H/I */
  outlierZ?: number;
  /** A: |z-score| above this → outlier */
  durationZ?: number;
  /** A/C/…: IQR multiplier (Tukey) */
  durationIqrMult?: number;
  /** B: mora/sec z-score */
  speedZ?: number;
  /** G: spectral centroid z-score */
  centroidZ?: number;
};

export type SliceReviewSettings = {
  mode: SliceReviewMode;
  aspects: SliceReviewAspectFlags;
  thresholds: SliceReviewThresholds;
  /** auto: exclude at least this % by outlier score (0–90, 0 = off) */
  autoRemovePercent?: number;
  /** auto: keep at most this many slices (0 = no cap) */
  autoKeepMax?: number;
  /** Non-generative WPE / tilt / denoise on sliced clips before review. */
  autoFix: SliceAutoFixSettings;
};

export type SliceAutoFixSettings = {
  enabled: boolean;
  /** WPE + late-reverb suppression when the session/slice sounds wet. */
  reverb: boolean;
  /** Spectral tilt / boxiness EQ for muffled takes. */
  muffle: boolean;
  /** High-pass, light Wiener denoise, soft declip. */
  enhance: boolean;
};

export const DEFAULT_SLICE_AUTO_FIX: SliceAutoFixSettings = {
  enabled: true,
  reverb: true,
  muffle: true,
  enhance: true,
};

export function sliceAutoFixSettings(
  raw?: Partial<SliceAutoFixSettings> | null,
): SliceAutoFixSettings {
  return {
    enabled: raw?.enabled !== false,
    reverb: raw?.reverb !== false,
    muffle: raw?.muffle !== false,
    enhance: raw?.enhance !== false,
  };
}

export const DEFAULT_SLICE_REVIEW: SliceReviewSettings = {
  mode: "manual",
  aspects: {
    A: true,
    B: true,
    C: true,
    D: true,
    E: false,
    F: true,
    G: true,
    H: true,
    I: true,
    J: false,
  },
  thresholds: {
    outlierZ: 3,
    durationZ: 3,
    durationIqrMult: 1.5,
    speedZ: 3,
    centroidZ: 3,
  },
  autoRemovePercent: 0,
  autoKeepMax: 0,
  autoFix: { ...DEFAULT_SLICE_AUTO_FIX },
};

export function sliceReviewSettings(
  settings: AppSettings,
): SliceReviewSettings {
  const raw = settings.sliceReview;
  if (!raw) {
    return {
      ...DEFAULT_SLICE_REVIEW,
      aspects: { ...DEFAULT_SLICE_REVIEW.aspects },
      thresholds: { ...DEFAULT_SLICE_REVIEW.thresholds },
      autoFix: { ...DEFAULT_SLICE_AUTO_FIX },
    };
  }
  const pct = Number(raw.autoRemovePercent);
  const keep = Number(raw.autoKeepMax);
  return {
    mode:
      raw.mode === "skip" || raw.mode === "auto" || raw.mode === "manual"
        ? raw.mode
        : "manual",
    aspects: { ...DEFAULT_SLICE_REVIEW.aspects, ...(raw.aspects || {}) },
    thresholds: {
      ...DEFAULT_SLICE_REVIEW.thresholds,
      ...(raw.thresholds || {}),
    },
    autoRemovePercent: Number.isFinite(pct)
      ? Math.min(90, Math.max(0, pct))
      : 0,
    autoKeepMax: Number.isFinite(keep) ? Math.max(0, Math.floor(keep)) : 0,
    autoFix: sliceAutoFixSettings(raw.autoFix),
  };
}

export type AppSettings = {
  irodoriVersion: IrodoriVersion | string;
  pathsV3: VersionPathSettings;
  pathsV4: VersionPathSettings;
  modelPrecision: string;
  codecPrecision: string;
  modelDevice: string;
  codecDevice: string;
  projectsRoot: string;
  /** Legacy; ignored. Bundled ffmpeg is always used. */
  ffmpegPath?: string;
  theme: "light" | "dark" | string;
  /** Light-mode accent palette id (see `src/lib/accent.ts`). */
  accentLight?: string;
  /** Dark-mode accent palette id (see `src/lib/accent.ts`). */
  accentDark?: string;
  /** Generate view: unselected lines use a single-row compact layout. Default ON. */
  generateCompactLines?: boolean;
  /** Batch play gap / concat-save default (ms). */
  chunkSilenceMs: number;
  /** Max utterance chars in export filenames. */
  utteranceMaxChars: number;
  /**
   * Ordered tokens for individual export filenames.
   * Must include `index`; other parts optional.
   */
  exportFilenameParts?: ExportFilenamePart[];
  /** Default audio format for line / batch export. */
  exportAudioFormat?: ExportAudioFormat;
  /** CBR kbps for MP3 export. */
  exportMp3BitrateKbps?: number;
  /** Target kbps for Opus export. */
  exportOpusBitrateKbps?: number;
  /** CER above this → transcription-verify warning (0–1). */
  asrCerWarnThreshold?: number;
  /** Gacha batch size per row (3–9). */
  gachaCount?: number;
  /** audio-separator model filename for optional vocal separation. */
  vocalSeparatorModel?: string;
  /** Slice review after speed, before dataset. */
  sliceReview?: SliceReviewSettings;
  /** Local HTTP API server (Chrome extension / external clients). */
  httpServerEnabled?: boolean;
  /** Bind address — do not hardcode; use this setting. */
  httpBindAddress?: string;
  /** Preferred listen port (tries next if busy). */
  httpPort?: number;
  /** Bearer token for all HTTP API requests. */
  httpToken?: string;
  /** Extra CORS allowlist origins. */
  httpCorsOrigins?: string[];
  /** Allow any chrome-extension:// Origin. */
  httpAllowChromeExtensions?: boolean;
  /** Default max chars per pack chunk for HTTP auto-split (when split=true). */
  httpMaxChars?: number;
};

/** Runtime status of the local HTTP API server. */
export type HttpServerStatus = {
  running: boolean;
  bindAddress: string;
  port: number | null;
  preferredPort: number;
};

export const DEFAULT_VOCAL_SEPARATOR_MODEL =
  "model_bs_roformer_ep_317_sdr_12.9755.ckpt";

export type VocalSeparatorModelInfo = {
  arch: string;
  name: string;
  filename: string;
  stems?: string[];
  targetStem?: string | null;
};

export const MAX_LINE_VARIANTS = 10;

/** Clamp per-line candidate / generate count to the line variant cap. */
export function clampCandidateCount(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.min(MAX_LINE_VARIANTS, Math.max(1, Math.floor(n)));
}

export function asrCerWarnThreshold(settings: AppSettings): number {
  const v = settings.asrCerWarnThreshold;
  return typeof v === "number" && Number.isFinite(v) ? v : 0.15;
}

/** Unselected generate lines use compact layout. Missing flag = ON. */
export function generateCompactLinesOf(settings: AppSettings): boolean {
  return settings.generateCompactLines !== false;
}

export function activePaths(settings: AppSettings): VersionPathSettings {
  return settings.irodoriVersion === "v4"
    ? settings.pathsV4
    : settings.pathsV3;
}

export function isIrodoriV4(settings: AppSettings): boolean {
  return settings.irodoriVersion === "v4";
}

export type InferredPaths = {
  irodoriRoot: string;
  outputsRoot: string;
  pythonExe: string;
  checkpointPath: string;
  pythonFound: boolean;
  checkpointFound: boolean;
};

export type PathValidation = {
  irodoriRootOk: boolean;
  pythonOk: boolean;
  checkpointOk: boolean;
  outputsOk: boolean;
  ffmpegOk: boolean;
  ffmpegPath: string | null;
  irodoriVersion?: string;
  trainConfigOk?: boolean;
  studioScriptsOk?: boolean;
  studioPythonDir?: string | null;
};

/** `"trained" | "blend" | "ref" | "caption"` */
export type SpeakerKind = "trained" | "blend" | "ref" | "caption" | string;

export type SpeakerInfo = {
  name: string;
  /** Unique id: embedding path, or `_profiles/*.json` for ref/caption. */
  embedPath: string;
  kind: SpeakerKind;
  /** Primary (or only) reference WAV path. Kept for back-compat. */
  refWav?: string | null;
  /** All reference WAV paths (v4: multiple allowed). */
  refWavs?: string[] | null;
  caption?: string | null;
  /** `"female" | "male" | "other"` */
  gender?: string | null;
  /** `"child" | "teen" | "adult" | "middle" | "senior"` */
  ageRange?: string | null;
  tags?: string[] | null;
  /** Actor / voice-actor name. Falls back to `name` when empty. */
  realName?: string | null;
};

export function speakerRealName(s: Pick<SpeakerInfo, "name" | "realName">): string {
  const n = (s.realName ?? "").trim();
  return n || s.name;
}

/** Conditioning fingerprint for dirty-check / cache keys. */
export function speakerConditionKey(
  speakers: SpeakerInfo[],
  speakerId: string,
): string {
  const sp = speakers.find((s) => s.embedPath === speakerId);
  if (!sp) return speakerId;
  if (sp.kind === "ref") return `ref\0${sp.embedPath}\0${sp.refWav ?? ""}`;
  if (sp.kind === "caption")
    return `caption\0${sp.embedPath}\0${sp.caption ?? ""}`;
  return sp.embedPath;
}

export function speakerOptionLabel(s: SpeakerInfo): string {
  if (s.kind === "blend") return `${s.name} (blend)`;
  if (s.kind === "ref") return `${s.name} (参照)`;
  if (s.kind === "caption") return `${s.name} (caption)`;
  return s.name;
}

/** How multiple WAVs are produced for a line. */
export type MultiGenerateMode = "candidates" | "individual";

export type SamplingParams = {
  numSteps: number;
  numCandidates: number;
  /** Missing / unknown → Num Candidate batch. */
  multiGenerateMode?: MultiGenerateMode;
  seed: number | null;
  seconds: number | null;
  durationScale: number;
  tScheduleMode: string;
  swayCoeff: number;
  cfgGuidanceMode: string;
  cfgScaleText: number;
  cfgScaleSpeaker: number;
};

export function multiGenerateModeOf(
  s: SamplingParams | null | undefined,
): MultiGenerateMode {
  return s?.multiGenerateMode === "individual" ? "individual" : "candidates";
}

export type LineVariant = {
  id: string;
  seed: number;
  wavPath: string;
  /** Snapshot of inputs used for this WAV. Missing → inherit line-level snapshot. */
  generatedText?: string | null;
  generatedSpeakerEmbedPath?: string | null;
  generatedCaption?: string | null;
  generatedCfgScaleCaption?: number | null;
  generatedSampling?: SamplingParams | null;
};

export type ProjectLine = {
  id: string;
  text: string;
  /** Position-specific readings for TTS (display text unchanged). */
  readings?: AppliedReading[];
  speakerName: string;
  speakerEmbedPath: string;
  sampling: SamplingParams;
  wavPath: string | null;
  /** Ordered WAV candidates; index 0 = primary (batch play / export). */
  variants?: LineVariant[];
  /** Snapshot of inputs used for the current wavPath */
  generatedText: string | null;
  generatedSpeakerEmbedPath: string | null;
  /** Snapshot of sampling used for the current wavPath */
  generatedSampling?: SamplingParams | null;
  /** v4: style caption paired with a 参照音源 speaker. */
  caption?: string | null;
  /** Snapshot of line caption used for the current wavPath */
  generatedCaption?: string | null;
  /** v4: CFG scale for line caption (default 0.75). */
  cfgScaleCaption?: number | null;
  /** Snapshot of cfgScaleCaption used for the current wavPath */
  generatedCfgScaleCaption?: number | null;
  volume: number;
  speed: number;
  /** Post-generation tone / denoise. Missing → all off. */
  audioFx?: AudioFx;
};

/** Line post-FX amounts in 0..1 (0 = bypass). Keep in sync with Rust `AudioFx`. */
export type AudioFx = {
  highpass: number;
  muffle: number;
  clarity: number;
  air: number;
  flatten: number;
  deesser: number;
  denoise: number;
};

export function defaultAudioFx(): AudioFx {
  return {
    highpass: 0,
    muffle: 0,
    clarity: 0,
    air: 0,
    flatten: 0,
    deesser: 0,
    denoise: 0,
  };
}

function clampFx01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export function audioFxOf(
  line: { audioFx?: AudioFx | null } | null | undefined,
): AudioFx {
  const raw = line?.audioFx;
  if (!raw) return defaultAudioFx();
  return {
    highpass: clampFx01(raw.highpass),
    muffle: clampFx01(raw.muffle),
    clarity: clampFx01(raw.clarity),
    air: clampFx01(raw.air),
    flatten: clampFx01(raw.flatten),
    deesser: clampFx01(raw.deesser),
    denoise: clampFx01(raw.denoise),
  };
}

export function audioFxActive(fx: AudioFx): boolean {
  return (
    fx.highpass > 0.001 ||
    fx.muffle > 0.001 ||
    fx.clarity > 0.001 ||
    fx.air > 0.001 ||
    fx.flatten > 0.001 ||
    fx.deesser > 0.001 ||
    fx.denoise > 0.001
  );
}

/** Stable compare for dirty-check / cache keys. */
export function samplingEqual(
  a: SamplingParams | null | undefined,
  b: SamplingParams | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare sampling for dirty-check.
 * Seed and candidate count do not invalidate existing WAVs.
 */
export function samplingEqualIgnoringSeed(
  a: SamplingParams | null | undefined,
  b: SamplingParams | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const strip = (s: SamplingParams) => {
    const {
      seed: _seed,
      numCandidates: _n,
      multiGenerateMode: _m,
      ...rest
    } = s;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export function normalizeLineVariants(line: ProjectLine): LineVariant[] {
  if (line.variants && line.variants.length > 0) return line.variants;
  if (line.wavPath) {
    return [{ id: line.id, seed: 0, wavPath: line.wavPath }];
  }
  return [];
}

export function primaryVariant(line: ProjectLine): LineVariant | undefined {
  return normalizeLineVariants(line)[0];
}

export function syncLineWavPath(line: ProjectLine): ProjectLine {
  if (line.variants) {
    return { ...line, wavPath: line.variants[0]?.wavPath ?? null };
  }
  const primary = primaryVariant(line);
  return { ...line, wavPath: primary?.wavPath ?? null };
}

export function wavPathBelongsToLine(
  line: ProjectLine,
  wavPath: string,
): boolean {
  const norm = wavPath.replace(/\//g, "\\").toLowerCase();
  const id = line.id.toLowerCase();
  if (norm.endsWith(`\\${id}.wav`)) {
    return true;
  }
  return normalizeLineVariants(line).some((v) => {
    const vn = v.wavPath.replace(/\//g, "\\").toLowerCase();
    const vid = v.id.toLowerCase();
    return vn === norm || norm.endsWith(`\\${id}\\${vid}.wav`);
  });
}

function variantHasOwnGeneration(v: LineVariant): boolean {
  return (
    v.generatedText !== undefined ||
    v.generatedSpeakerEmbedPath !== undefined ||
    v.generatedCaption !== undefined ||
    v.generatedCfgScaleCaption !== undefined ||
    v.generatedSampling !== undefined
  );
}

export function inheritLineGeneration(
  line: ProjectLine,
  variant: LineVariant,
): LineVariant {
  if (variantHasOwnGeneration(variant)) return variant;
  return {
    ...variant,
    generatedText: line.generatedText,
    generatedSpeakerEmbedPath: line.generatedSpeakerEmbedPath,
    generatedCaption: line.generatedCaption,
    generatedCfgScaleCaption: line.generatedCfgScaleCaption,
    generatedSampling: line.generatedSampling
      ? { ...line.generatedSampling }
      : line.generatedSampling,
  };
}

export function backfillLineVariants(p: Project): Project {
  let changed = false;
  const lines = p.lines.map((l) => {
    let line = l;
    if (!line.variants || line.variants.length === 0) {
      if (line.wavPath) {
        changed = true;
        line = syncLineWavPath({
          ...line,
          variants: [{ id: line.id, seed: 0, wavPath: line.wavPath }],
        });
      } else {
        return line;
      }
    }
    const variants = line.variants ?? [];
    let variantsChanged = false;
    const stamped = variants.map((v) => {
      const next = inheritLineGeneration(line, v);
      if (next !== v) variantsChanged = true;
      return next;
    });
    const synced = syncLineWavPath(
      variantsChanged ? { ...line, variants: stamped } : line,
    );
    if (synced.wavPath !== l.wavPath || variantsChanged) changed = true;
    return synced;
  });
  return changed ? { ...p, lines } : p;
}

export function newVariantId(): string {
  return crypto.randomUUID();
}

export const DEFAULT_CFG_SCALE_CAPTION = 0.75;

export function lineCfgScaleCaption(line: {
  cfgScaleCaption?: number | null;
}): number {
  const v = line.cfgScaleCaption;
  return typeof v === "number" && Number.isFinite(v)
    ? v
    : DEFAULT_CFG_SCALE_CAPTION;
}

export type Project = {
  name: string;
  createdAt: string;
  lines: ProjectLine[];
  defaultSampling: SamplingParams;
};

export const defaultSampling = (): SamplingParams => ({
  numSteps: 40,
  numCandidates: 1,
  multiGenerateMode: "candidates",
  seed: null,
  seconds: null,
  durationScale: 1.0,
  tScheduleMode: "linear",
  swayCoeff: -1.0,
  cfgGuidanceMode: "independent",
  cfgScaleText: 3.0,
  cfgScaleSpeaker: 5.0,
});

export function newLineId(): string {
  return crypto.randomUUID();
}
