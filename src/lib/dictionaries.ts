import type { AnnotationKind } from "./annotations";
import type { ReplaceEntry } from "./replaceApply";

export type ReadingDictEntry = {
  id: string;
  kind: AnnotationKind;
  surface: string;
  /** Extra reading candidates, `/` or `／` separated. */
  reading: string;
  enabled: boolean;
};

/** @deprecated migrated into reading dict (kind=heteronym) */
export type HomographEntry = {
  id: string;
  surface: string;
  note?: string;
  readings?: string;
  enabled: boolean;
};

export type Dictionaries = {
  replace: ReplaceEntry[];
  reading: ReadingDictEntry[];
  /** @deprecated migrated into reading */
  homograph?: HomographEntry[];
  /**
   * Seeded version of default symbol→empty replace entries.
   * Bump in lockstep with `REPLACE_DEFAULTS_VERSION` in dictionary.rs.
   */
  replaceDefaultsVersion?: number;
};

/**
 * Decorative symbols that TTS tends to read as words (くろしかく, ほし, …).
 * Default 一括置換 candidates with empty `to`. Keep in sync with
 * `default_symbol_replace_entries` in src-tauri/src/dictionary.rs.
 */
export const DEFAULT_SYMBOL_REPLACE_FROMS = [
  "■",
  "□",
  "▪",
  "▫",
  "●",
  "○",
  "◆",
  "◇",
  "★",
  "☆",
  "▲",
  "▼",
  "△",
  "▽",
  "※",
  "♪",
  "♫",
  "♡",
  "♥",
  "◎",
  "〓",
  "＊",
  "＃",
] as const;

export const REPLACE_DEFAULTS_VERSION = 1;

export function defaultSymbolReplaceEntries(): ReplaceEntry[] {
  return DEFAULT_SYMBOL_REPLACE_FROMS.map((from) => ({
    id: `default-sym-${from}`,
    from,
    to: "",
    enabled: true,
    autoReplace: false,
  }));
}

export const emptyDictionaries = (): Dictionaries => ({
  replace: [],
  reading: [],
  replaceDefaultsVersion: 0,
});

export function newDictId(): string {
  return crypto.randomUUID();
}

export function parseReadingList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[/／]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function joinReadingList(readings: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of readings) {
    const t = r.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join("/");
}

/** Append a novel extra reading. Same array if unchanged. */
export function upsertReadingDictExtra(
  entries: ReadingDictEntry[],
  kind: AnnotationKind,
  surface: string,
  reading: string,
): ReadingDictEntry[] {
  const surf = surface.trim();
  const trimmed = reading.trim();
  if (!surf || !trimmed) return entries;
  const idx = entries.findIndex((e) => e.kind === kind && e.surface === surf);
  if (idx >= 0) {
    const parts = parseReadingList(entries[idx].reading);
    if (parts.includes(trimmed)) return entries;
    const next = [...entries];
    next[idx] = {
      ...next[idx],
      reading: joinReadingList([...parts, trimmed]),
      enabled: true,
    };
    return next;
  }
  return [
    ...entries,
    {
      id: newDictId(),
      kind,
      surface: surf,
      reading: trimmed,
      enabled: true,
    },
  ];
}

export const DICTS_CHANGED_EVENT = "irodori-dictionaries-changed";

export function emitDictionariesChanged(): void {
  window.dispatchEvent(new Event(DICTS_CHANGED_EVENT));
}
