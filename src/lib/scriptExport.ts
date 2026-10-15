import type { ProjectLine, SpeakerInfo } from "../types";

export type ScriptExportLine = Pick<
  ProjectLine,
  "text" | "speakerName" | "speakerEmbedPath"
>;

function looksLikePath(name: string): boolean {
  return /[\\/]/.test(name) || /^[a-zA-Z]:/.test(name);
}

/** Prefer the line's speaker name; fall back to the speaker list. */
export function resolveLineSpeakerName(
  line: ScriptExportLine,
  speakers: SpeakerInfo[] = [],
): string {
  const raw = line.speakerName.trim();
  if (raw && !looksLikePath(raw)) return raw;
  const sp = speakers.find((s) => s.embedPath === line.speakerEmbedPath);
  return (sp?.name ?? "").trim();
}

function sanitizeDialogue(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Build a re-importable script: one `話者名: セリフ` row per line.
 * Lines without a speaker name are written as dialogue only.
 */
export function buildSpeakerDialogueScript(
  lines: ScriptExportLine[],
  speakers: SpeakerInfo[] = [],
): string {
  const rows = lines
    .map((line) => {
      const text = sanitizeDialogue(line.text);
      if (!text) return "";
      const speaker = resolveLineSpeakerName(line, speakers);
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean);
  return rows.length ? `${rows.join("\n")}\n` : "";
}
