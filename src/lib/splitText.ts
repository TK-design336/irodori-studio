export type SplitMode = "strict" | "pack";

/** 標準句読点プリセット */
export const PRESET_PUNCTUATION = [
  "。」",
  "。",
  "．",
  "？",
  "?",
  "！",
  "!",
] as const;

/** 改行のみプリセット */
export const PRESET_NEWLINE = ["\n"] as const;

/** チップ候補（トグル可能） */
export const ALL_SPLIT_CANDIDATES = [
  "。」",
  "。",
  "．",
  "？",
  "?",
  "！",
  "!",
  "、",
  "，",
  ",",
  ".",
  "；",
  ";",
  "：",
  ":",
  "\n",
  " ",
  "　",
] as const;

export function displayDelimiter(d: string): string {
  if (d === "\n") return "↵";
  if (d === " ") return "␣";
  if (d === "　") return "全角␣";
  return d;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 区切り文字でテキストを分割する。
 * 区切りは直前のチャンクに含める（「こんにちは。」→ 1 行）。
 * 長い区切りを優先するため、。」 と 。 が両方あるときは 。」 で切る。
 */
export function splitText(
  text: string,
  delimiters: string[],
  mode: SplitMode,
  packLimit = 80,
): string[] {
  const trimmedAll = text.replace(/^\uFEFF/, "");
  if (!trimmedAll.trim()) return [];

  if (delimiters.length === 0) {
    const t = trimmedAll.trim();
    return t ? [t] : [];
  }

  // 長い区切りを先に置く（。」 が 。 より先にマッチする）
  const unique = [...new Set(delimiters.filter((d) => d.length > 0))];
  const escaped = unique
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  const re = new RegExp(`(${escaped.join("|")})`, "g");

  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmedAll)) !== null) {
    const end = m.index + m[0].length;
    const chunk = trimmedAll.slice(last, end).trim();
    if (chunk) parts.push(chunk);
    last = end;
  }
  const rest = trimmedAll.slice(last).trim();
  if (rest) parts.push(rest);

  if (mode === "strict" || packLimit <= 0) return parts;

  const packed: string[] = [];
  let buf = "";
  for (const p of parts) {
    if (!buf) {
      buf = p;
      continue;
    }
    if (buf.length + p.length <= packLimit) {
      buf += p;
    } else {
      packed.push(buf);
      buf = p;
    }
  }
  if (buf) packed.push(buf);
  return packed;
}
