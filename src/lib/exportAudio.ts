import type { AppSettings, ExportAudioFormat } from "../types";

export type { ExportAudioFormat };

export const EXPORT_AUDIO_FORMATS = ["wav", "mp3", "opus"] as const;

export const DEFAULT_EXPORT_AUDIO_FORMAT: ExportAudioFormat = "wav";

export const MP3_BITRATE_OPTIONS = [128, 160, 192, 256, 320] as const;
export const OPUS_BITRATE_OPTIONS = [32, 48, 64, 96, 128] as const;
export const DEFAULT_MP3_BITRATE_KBPS = 192;
export const DEFAULT_OPUS_BITRATE_KBPS = 64;

export const EXPORT_AUDIO_FORMAT_LABELS: Record<ExportAudioFormat, string> = {
  wav: "WAV",
  mp3: "MP3",
  opus: "Opus",
};

const FORMAT_SET = new Set<string>(EXPORT_AUDIO_FORMATS);

export function isExportAudioFormat(v: unknown): v is ExportAudioFormat {
  return typeof v === "string" && FORMAT_SET.has(v);
}

export function normalizeExportAudioFormat(v: unknown): ExportAudioFormat {
  return isExportAudioFormat(v) ? v : DEFAULT_EXPORT_AUDIO_FORMAT;
}

export function exportAudioExt(format: ExportAudioFormat): string {
  return format;
}

export function exportAudioFormatOf(settings: AppSettings): ExportAudioFormat {
  return normalizeExportAudioFormat(settings.exportAudioFormat);
}

function snapBitrate(value: unknown, allowed: readonly number[], fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return allowed.reduce((best, cur) =>
    Math.abs(cur - n) < Math.abs(best - n) ? cur : best,
  );
}

export function normalizeMp3BitrateKbps(v: unknown): number {
  return snapBitrate(v, MP3_BITRATE_OPTIONS, DEFAULT_MP3_BITRATE_KBPS);
}

export function normalizeOpusBitrateKbps(v: unknown): number {
  return snapBitrate(v, OPUS_BITRATE_OPTIONS, DEFAULT_OPUS_BITRATE_KBPS);
}

export function exportMp3BitrateKbps(settings: AppSettings): number {
  return normalizeMp3BitrateKbps(settings.exportMp3BitrateKbps);
}

export function exportOpusBitrateKbps(settings: AppSettings): number {
  return normalizeOpusBitrateKbps(settings.exportOpusBitrateKbps);
}

export function exportBitrateKbps(
  format: ExportAudioFormat,
  settings: AppSettings,
): number | undefined {
  if (format === "mp3") return exportMp3BitrateKbps(settings);
  if (format === "opus") return exportOpusBitrateKbps(settings);
  return undefined;
}

export function formatFromDestPath(
  dest: string,
  fallback: ExportAudioFormat = DEFAULT_EXPORT_AUDIO_FORMAT,
): ExportAudioFormat {
  const m = dest.match(/\.([^.\\/]+)$/);
  const ext = (m?.[1] ?? "").toLowerCase();
  if (ext === "mp3") return "mp3";
  if (ext === "opus" || ext === "ogg") return "opus";
  if (ext === "wav") return "wav";
  return fallback;
}

export function withAudioExt(path: string, format: ExportAudioFormat): string {
  const ext = exportAudioExt(format);
  if (/\.(wav|mp3|opus|ogg)$/i.test(path)) {
    return path.replace(/\.(wav|mp3|opus|ogg)$/i, `.${ext}`);
  }
  return `${path}.${ext}`;
}

export function exportDialogFilters(preferred: ExportAudioFormat): {
  name: string;
  extensions: string[];
}[] {
  const all = [
    { name: "WAV", extensions: ["wav"] },
    { name: "MP3", extensions: ["mp3"] },
    { name: "Opus", extensions: ["opus"] },
  ];
  const i = all.findIndex((f) => f.extensions[0] === exportAudioExt(preferred));
  if (i <= 0) return all;
  const [pref] = all.splice(i, 1);
  return [pref, ...all];
}
