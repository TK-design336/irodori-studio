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
  /** File extension without dot. Defaults to wav. */
  ext?: string;
  /**
   * 1-based take index within the line. Combined with `variantCount` > 1
   * so the number part becomes `001-1`, `001-2`, …
   */
  variantIndex?: number;
  /** Total takes on this line. Suffix is applied only when this is > 1. */
  variantCount?: number;
};

export function formatExportIndex(
  idx: number,
  variantIndex?: number,
  variantCount?: number,
): string {
  const indexStr = String(idx).padStart(3, "0");
  const count = Math.floor(Number(variantCount) || 0);
  const take = Math.floor(Number(variantIndex) || 0);
  if (count > 1 && take >= 1) return `${indexStr}-${take}`;
  return indexStr;
}

export function lineExportFileName({
  projectName,
  idx,
  speakerName,
  text,
  utteranceMaxChars = 20,
  parts,
  ext = "wav",
  variantIndex,
  variantCount,
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
  const indexStr = formatExportIndex(idx, variantIndex, variantCount);

  const values: Record<ExportFilenamePart, string> = {
    project: safeProject,
    index: indexStr,
    speaker: safeSpeaker,
    utterance: safeText,
  };

  const segments = order
    .map((p) => values[p])
    .filter((s) => s.length > 0);
  const safeExt =
    (ext.replace(/^\./, "").toLowerCase() || "wav").replace(
      /[^a-z0-9]/g,
      "",
    ) || "wav";
  // Index is always present and non-empty; keep at least that.
  return `${(segments.length > 0 ? segments : [indexStr]).join("_")}.${safeExt}`;
}

/** Example preview for settings UI. */
export function previewExportFileName(
  parts: readonly ExportFilenamePart[],
  utteranceMaxChars = 20,
  ext = "wav",
  variant?: { variantIndex: number; variantCount: number },
): string {
  return lineExportFileName({
    projectName: "サンプル",
    idx: 1,
    speakerName: "太郎",
    text: "こんにちは、今日はいい天気ですね",
    utteranceMaxChars,
    parts,
    ext,
    variantIndex: variant?.variantIndex,
    variantCount: variant?.variantCount,
  });
}
