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
};

export const emptyDictionaries = (): Dictionaries => ({
  replace: [],
  reading: [],
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
