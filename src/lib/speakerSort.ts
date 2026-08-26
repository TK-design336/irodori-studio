import type { SpeakerInfo } from "../types";
import { speakerOptionLabel, speakerRealName } from "../types";

export type SortKey = "name" | "realName" | "gender" | "age";
export type SortDir = "asc" | "desc";
export type KindFilterKey = "trained" | "blend" | "ref" | "caption";

export type SpeakerSortState = {
  sortKey: SortKey;
  sortDir: SortDir;
  kindFilter: Record<KindFilterKey, boolean>;
  /**
   * `null` = all tags selected (no tag filter).
   * `string[]` = only speakers matching at least one of these tags.
   */
  tagFilter: string[] | null;
};

export const KIND_FILTERS: { key: KindFilterKey; label: string }[] = [
  { key: "trained", label: "埋め込み" },
  { key: "blend", label: "ブレンド" },
  { key: "ref", label: "参照音源" },
  { key: "caption", label: "キャプション" },
];

export const SORT_BUTTONS: { key: SortKey; label: string }[] = [
  { key: "name", label: "名前" },
  { key: "realName", label: "本名" },
  { key: "gender", label: "性別" },
  { key: "age", label: "年齢帯" },
];

export const GENDER_LABEL: Record<string, string> = {
  female: "女性",
  male: "男性",
  other: "その他",
};

export const AGE_LABEL: Record<string, string> = {
  child: "子供",
  teen: "青年",
  adult: "成人",
  middle: "中年",
  senior: "老年",
};

export const DEFAULT_KIND_FILTER: Record<KindFilterKey, boolean> = {
  trained: true,
  blend: true,
  ref: true,
  caption: true,
};

export const DEFAULT_SPEAKER_SORT: SpeakerSortState = {
  sortKey: "name",
  sortDir: "asc",
  kindFilter: { ...DEFAULT_KIND_FILTER },
  tagFilter: null,
};

const GENDER_ORDER: Record<string, number> = { female: 0, male: 1, other: 2 };
const AGE_ORDER: Record<string, number> = {
  child: 0,
  teen: 1,
  adult: 2,
  middle: 3,
  senior: 4,
};

export function foldSpeakerQuery(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s_\-・．.]/g, "");
}

export function speakerTags(sp: Pick<SpeakerInfo, "tags">): string[] {
  return (sp.tags ?? []).map((t) => t.trim()).filter(Boolean);
}

export function speakerMatchesQuery(sp: SpeakerInfo, query: string): boolean {
  const q = foldSpeakerQuery(query);
  if (!q) return true;
  if (foldSpeakerQuery(sp.name).includes(q)) return true;
  if (foldSpeakerQuery(speakerRealName(sp)).includes(q)) return true;
  if (foldSpeakerQuery(speakerOptionLabel(sp)).includes(q)) return true;
  for (const t of speakerTags(sp)) {
    if (foldSpeakerQuery(t).includes(q)) return true;
  }
  const g = (sp.gender ?? "").trim();
  if (g && foldSpeakerQuery(GENDER_LABEL[g] ?? g).includes(q)) return true;
  const a = (sp.ageRange ?? "").trim();
  if (a && foldSpeakerQuery(AGE_LABEL[a] ?? a).includes(q)) return true;
  return false;
}

export function collectSpeakerTags(speakers: SpeakerInfo[]): string[] {
  const set = new Set<string>();
  for (const s of speakers) {
    for (const t of speakerTags(s)) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

function cmpOptionalOrder(
  a: string | null | undefined,
  b: string | null | undefined,
  order: Record<string, number>,
  dir: number,
): number {
  const ae = !a;
  const be = !b;
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  return ((order[a] ?? 99) - (order[b] ?? 99)) * dir;
}

export type SpeakerOptionMetaTone = "realName" | "gender" | "age";

export function speakerSortMeta(
  sp: SpeakerInfo,
  sortKey: SortKey,
): { text: string; tone: SpeakerOptionMetaTone } | null {
  if (sortKey === "realName") {
    const rn = speakerRealName(sp);
    if (!rn || rn === sp.name) return null;
    return { text: rn, tone: "realName" };
  }
  if (sortKey === "gender") {
    const g = (sp.gender ?? "").trim();
    if (!g) return null;
    return { text: GENDER_LABEL[g] ?? g, tone: "gender" };
  }
  if (sortKey === "age") {
    const a = (sp.ageRange ?? "").trim();
    if (!a) return null;
    return { text: AGE_LABEL[a] ?? a, tone: "age" };
  }
  return null;
}

export function sortAndFilterSpeakers(
  speakers: SpeakerInfo[],
  state: SpeakerSortState,
  opts?: { keepEmbedPath?: string },
): SpeakerInfo[] {
  const { sortKey, sortDir, kindFilter, tagFilter } = state;
  const keep = opts?.keepEmbedPath?.trim() ?? "";
  const filtered = speakers.filter((s) => {
    if (keep && s.embedPath === keep) return true;
    const k = s.kind as KindFilterKey;
    if (!(kindFilter[k] ?? true)) return false;
    if (tagFilter !== null) {
      const tags = speakerTags(s);
      if (tags.length === 0) return false;
      if (!tags.some((t) => tagFilter.includes(t))) return false;
    }
    return true;
  });
  const dir = sortDir === "asc" ? 1 : -1;
  const copy = [...filtered];
  copy.sort((a, b) => {
    let primary = 0;
    if (sortKey === "name") {
      primary = a.name.localeCompare(b.name, "ja") * dir;
    } else if (sortKey === "realName") {
      primary = speakerRealName(a).localeCompare(speakerRealName(b), "ja") * dir;
    } else if (sortKey === "gender") {
      primary = cmpOptionalOrder(a.gender, b.gender, GENDER_ORDER, dir);
    } else {
      primary = cmpOptionalOrder(a.ageRange, b.ageRange, AGE_ORDER, dir);
    }
    return primary !== 0 ? primary : a.name.localeCompare(b.name, "ja");
  });
  return copy;
}
