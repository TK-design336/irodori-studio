import { splitText, type SplitMode } from "./splitText";

/** Parse optional "Speaker: dialogue" / "Speaker：dialogue" prefix. */
export function parseSpeakerLine(raw: string): {
  text: string;
  speakerName: string | null;
} {
  const trimmed = raw.replace(/^\uFEFF/, "");
  const m = trimmed.match(/^([^:：\n]{1,40})\s*[:：]\s*(.*)$/s);
  if (!m) return { text: trimmed, speakerName: null };
  const name = m[1].trim();
  const text = m[2];
  if (!name || name.length > 40) return { text: trimmed, speakerName: null };
  // Avoid treating URLs / times as speakers
  if (/^\d+$/.test(name) || /https?/i.test(name)) {
    return { text: trimmed, speakerName: null };
  }
  return { text, speakerName: name };
}

export type ImportedLine = {
  text: string;
  speakerName: string | null;
};

export function parseImportedLines(texts: string[]): ImportedLine[] {
  return texts.map((t) => parseSpeakerLine(t));
}

/** Colon delimiters would destroy "話者: セリフ" before we can parse it. */
function delimitersForDialogue(delimiters: string[]): string[] {
  return delimiters.filter((d) => d !== ":" && d !== "：");
}

/**
 * Pack segments up to `packLimit` chars, but never across an explicit
 * speaker label (a new "Name:" turn always starts a fresh packed line).
 */
export function packImportedLines(
  lines: ImportedLine[],
  packLimit: number,
): ImportedLine[] {
  if (packLimit <= 0) return lines;
  const packed: ImportedLine[] = [];
  let buf: ImportedLine | null = null;

  for (const line of lines) {
    if (!buf) {
      buf = { text: line.text, speakerName: line.speakerName };
      continue;
    }
    // Explicit speaker prefix = new turn; do not merge into previous.
    if (line.speakerName != null) {
      packed.push(buf);
      buf = { text: line.text, speakerName: line.speakerName };
      continue;
    }
    if (buf.text.length + line.text.length <= packLimit) {
      buf = { text: buf.text + line.text, speakerName: buf.speakerName };
    } else {
      packed.push(buf);
      buf = { text: line.text, speakerName: null };
    }
  }
  if (buf) packed.push(buf);
  return packed;
}

/**
 * Import a script: split by newlines (script rows), parse optional
 * "話者名: セリフ", then split/pack dialogue by delimiters.
 *
 * Mid-row speaker changes like `太郎: …。花子: …` are re-detected after
 * punctuation splits. Pack mode never joins across explicit speaker turns.
 */
export function importScriptLines(
  raw: string,
  delimiters: string[],
  mode: SplitMode,
  packLimit = 80,
): ImportedLine[] {
  const cleaned = raw.replace(/^\uFEFF/, "");
  if (!cleaned.trim()) return [];

  const delims = delimitersForDialogue(delimiters);
  const rows = cleaned.split(/\r?\n/);
  const segments: ImportedLine[] = [];

  for (const row of rows) {
    if (!row.trim()) continue;
    const parsed = parseSpeakerLine(row);
    const parts = splitText(parsed.text, delims, "strict");
    if (parts.length === 0) continue;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const again = parseSpeakerLine(part);
      if (again.speakerName) {
        segments.push(again);
      } else {
        segments.push({
          text: part,
          speakerName: i === 0 ? parsed.speakerName : null,
        });
      }
    }
  }

  if (mode === "pack") return packImportedLines(segments, packLimit);
  return segments;
}
