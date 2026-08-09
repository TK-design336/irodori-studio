export type KatakanaHit = {
  word: string;
  kana: string | null;
  start: number;
  end: number;
};

export type KatakanaEdit = KatakanaHit & {
  accepted: boolean;
  /** 手動編集含む適用カナ（空ならスキップ） */
  editKana: string;
};

/** Unicode コードポイント単位で置換（Python の start/end と対応） */
export function applyKatakanaEdits(
  text: string,
  edits: KatakanaEdit[],
): string {
  const chars = [...text];
  const accepted = edits
    .filter((e) => e.accepted && e.editKana.trim().length > 0)
    .sort((a, b) => b.start - a.start);

  for (const e of accepted) {
    const repl = [...e.editKana.trim()];
    chars.splice(e.start, e.end - e.start, ...repl);
  }
  return chars.join("");
}

export function hitsToEdits(hits: KatakanaHit[]): KatakanaEdit[] {
  return hits.map((h) => ({
    ...h,
    accepted: h.kana != null && h.kana.length > 0,
    editKana: h.kana ?? "",
  }));
}
