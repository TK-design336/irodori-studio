export type ReplaceEntry = {
  id: string;
  from: string;
  to: string;
  /** 一括語句置換の対象（デフォルト ON） */
  enabled: boolean;
  /** 入力時に自動置換（デフォルト OFF） */
  autoReplace?: boolean;
};

export type ReplaceMatch = {
  /** Index in the original (before) text */
  start: number;
  end: number;
  from: string;
  to: string;
};

function runReplacements(
  text: string,
  active: ReplaceEntry[],
): { text: string; count: number; matches: ReplaceMatch[] } {
  if (active.length === 0) return { text, count: 0, matches: [] };

  let count = 0;
  let out = "";
  let i = 0;
  const matches: ReplaceMatch[] = [];
  while (i < text.length) {
    let hit: ReplaceEntry | null = null;
    for (const e of active) {
      if (text.startsWith(e.from, i)) {
        hit = e;
        break;
      }
    }
    if (hit) {
      matches.push({
        start: i,
        end: i + hit.from.length,
        from: hit.from,
        to: hit.to,
      });
      out += hit.to;
      i += hit.from.length;
      count += 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return { text: out, count, matches };
}

function sortLongestFirst(entries: ReplaceEntry[]): ReplaceEntry[] {
  return entries
    .slice()
    .sort((a, b) => b.from.length - a.from.length);
}

/** Map a caret index in `before` through replacement matches. */
export function mapCaretThroughMatches(
  matches: ReplaceMatch[],
  caret: number,
): number {
  let delta = 0;
  for (const m of matches) {
    if (caret <= m.start) break;
    const fromLen = m.end - m.start;
    if (caret >= m.end) {
      delta += m.to.length - fromLen;
    } else {
      return m.start + delta + m.to.length;
    }
  }
  return caret + delta;
}

/** Longest-match-first global replace using enabled dictionary entries. */
export function applyReplacements(
  text: string,
  entries: ReplaceEntry[],
): { text: string; count: number; matches: ReplaceMatch[] } {
  const active = sortLongestFirst(
    entries.filter((e) => e.enabled && e.from.length > 0),
  );
  return runReplacements(text, active);
}

/** Input-time auto replace (`autoReplace` entries only). */
export function applyAutoReplacements(
  text: string,
  entries: ReplaceEntry[],
  caret: number,
): { text: string; count: number; caret: number } {
  const active = sortLongestFirst(
    entries.filter((e) => e.enabled && e.autoReplace && e.from.length > 0),
  );
  const { text: next, count, matches } = runReplacements(text, active);
  if (count === 0) return { text, count: 0, caret };
  return {
    text: next,
    count,
    caret: mapCaretThroughMatches(matches, caret),
  };
}

/** Sentence / clause bounds around [start, end) using 。！？ and newlines. */
export function sentenceBounds(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const sep = /[。！？\n\r]/;
  let s = start;
  while (s > 0 && !sep.test(text[s - 1]!)) s -= 1;
  let e = end;
  while (e < text.length && !sep.test(text[e]!)) e += 1;
  if (e < text.length && sep.test(text[e]!)) e += 1;
  return { start: s, end: e };
}

export type ReplaceSnippet = {
  before: string;
  after: string;
  /** Local offsets of the replaced span within `before` */
  beforeHi: { start: number; end: number };
  /** Local offsets of the replacement span within `after` */
  afterHi: { start: number; end: number };
};

/** One snippet per match, clipped to the containing sentence. */
export function snippetsForMatches(
  before: string,
  matches: ReplaceMatch[],
): ReplaceSnippet[] {
  const snippets: ReplaceSnippet[] = [];
  for (const m of matches) {
    const { start: ss, end: se } = sentenceBounds(before, m.start, m.end);
    const sentenceBefore = before.slice(ss, se);
    const localStart = m.start - ss;
    const localEnd = m.end - ss;
    const afterSentence =
      sentenceBefore.slice(0, localStart) +
      m.to +
      sentenceBefore.slice(localEnd);
    snippets.push({
      before: sentenceBefore,
      after: afterSentence,
      beforeHi: { start: localStart, end: localEnd },
      afterHi: {
        start: localStart,
        end: localStart + m.to.length,
      },
    });
  }
  return snippets;
}

export function previewReplacements(
  lines: { id: string; text: string }[],
  entries: ReplaceEntry[],
): {
  lineId: string;
  before: string;
  after: string;
  count: number;
  matches: ReplaceMatch[];
  snippets: ReplaceSnippet[];
}[] {
  const results: {
    lineId: string;
    before: string;
    after: string;
    count: number;
    matches: ReplaceMatch[];
    snippets: ReplaceSnippet[];
  }[] = [];
  for (const line of lines) {
    const { text, count, matches } = applyReplacements(line.text, entries);
    if (count > 0) {
      results.push({
        lineId: line.id,
        before: line.text,
        after: text,
        count,
        matches,
        snippets: snippetsForMatches(line.text, matches),
      });
    }
  }
  return results;
}
