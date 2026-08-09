import type { ExportFilenamePart } from "../types";

export type { ExportFilenamePart };

export const EXPORT_FILENAME_PARTS: readonly ExportFilenamePart[] = [
  "project",
  "index",
  "speaker",
  "utterance",
] as const;

export const DEFAULT_EXPORT_FILENAME_PARTS: ExportFilenamePart[] = [
  "project",
  "index",
  "speaker",
  "utterance",
];

export const EXPORT_FILENAME_PART_LABELS: Record<ExportFilenamePart, string> = {
  project: "プロジェクト名",
  index: "番号",
  speaker: "話者名",
  utterance: "セリフ",
};

const PART_SET = new Set<string>(EXPORT_FILENAME_PARTS);

export function isExportFilenamePart(v: unknown): v is ExportFilenamePart {
  return typeof v === "string" && PART_SET.has(v);
}

/** Keep order, drop unknowns/dupes, always include index, never empty. */
export function normalizeExportFilenameParts(
  parts: unknown,
): ExportFilenamePart[] {
  const seen = new Set<ExportFilenamePart>();
  const out: ExportFilenamePart[] = [];
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (!isExportFilenamePart(p) || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  if (!seen.has("index")) {
    // Insert near the default position (after project if present, else front).
    const projectIdx = out.indexOf("project");
    if (projectIdx >= 0) out.splice(projectIdx + 1, 0, "index");
    else out.unshift("index");
  }
  return out.length > 0 ? out : [...DEFAULT_EXPORT_FILENAME_PARTS];
}

export type LineExportNameInput = {
  projectName: string;
  /** 1-based line index */
  idx: number;
  speakerName: string;
  text: string;
  utteranceMaxChars?: number;
  parts?: readonly ExportFilenamePart[];
};

export function lineExportFileName({
  projectName,
  idx,
  speakerName,
  text,
  utteranceMaxChars = 20,
  parts,
}: LineExportNameInput): string {
  const order = normalizeExportFilenameParts(
    parts ?? DEFAULT_EXPORT_FILENAME_PARTS,
  );
  const maxChars = Math.max(1, Math.floor(Number(utteranceMaxChars)) || 20);
  const safeProject =
    projectName.replace(/[<>:"/\\|?*\r\n]/g, "_").trim() || "project";
  const safeSpeaker =
    speakerName.replace(/[<>:"/\\|?*]/g, "_").trim() || "speaker";
  const safeText = text.replace(/[<>:"/\\|?*\r\n]/g, "").slice(0, maxChars);
  const indexStr = String(idx).padStart(3, "0");

  const values: Record<ExportFilenamePart, string> = {
    project: safeProject,
    index: indexStr,
    speaker: safeSpeaker,
    utterance: safeText,
  };

  const segments = order
    .map((p) => values[p])
    .filter((s) => s.length > 0);
  // Index is always present and non-empty; keep at least that.
  return `${(segments.length > 0 ? segments : [indexStr]).join("_")}.wav`;
}

/** Example preview for settings UI. */
export function previewExportFileName(
  parts: readonly ExportFilenamePart[],
  utteranceMaxChars = 20,
): string {
  return lineExportFileName({
    projectName: "サンプル",
    idx: 1,
    speakerName: "太郎",
    text: "こんにちは、今日はいい天気ですね",
    utteranceMaxChars,
    parts,
  });
}
