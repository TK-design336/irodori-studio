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
  /** Batch play gap / concat-save default (ms). */
  chunkSilenceMs: number;
  /** Max utterance chars in export filenames. */
  utteranceMaxChars: number;
  /**
   * Ordered tokens for individual export filenames.
   * Must include `index`; other parts optional.
   */
  exportFilenameParts?: ExportFilenamePart[];
  /** CER above this → transcription-verify warning (0–1). */
  asrCerWarnThreshold?: number;
};

export function asrCerWarnThreshold(settings: AppSettings): number {
  const v = settings.asrCerWarnThreshold;
  return typeof v === "number" && Number.isFinite(v) ? v : 0.15;
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
  refWav?: string | null;
  caption?: string | null;
};

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

export type SamplingParams = {
  numSteps: number;
  numCandidates: number;
  seed: number | null;
  seconds: number | null;
  durationScale: number;
  tScheduleMode: string;
  swayCoeff: number;
  cfgGuidanceMode: string;
  cfgScaleText: number;
  cfgScaleSpeaker: number;
};

export type ProjectLine = {
  id: string;
  text: string;
  speakerName: string;
  speakerEmbedPath: string;
  sampling: SamplingParams;
  wavPath: string | null;
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
};

/** Stable compare for dirty-check / cache keys. */
export function samplingEqual(
  a: SamplingParams | null | undefined,
  b: SamplingParams | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
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
