/**
 * Strip non-speech junk before TTS (scene breaks, URLs, placeholders, …).
 * Keep in sync with chrome-extension/content/fetchers.js `stripSpeech`.
 */

/** Letters / numbers — if a string has none, TTS would only produce noise. */
export function hasSpeakable(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

const IMAGE_PLACEHOLDER =
  /［(?:挿絵|画像|図)］|【(?:挿絵|画像|図)】|\[(?:挿絵|画像|図|image|img|pic)\]/gi;

const AD_PLACEHOLDER =
  /［(?:広告|ＡＤ|AD|PR|ＰＲ)］|【(?:広告|ＡＤ|AD|PR|ＰＲ)】|\[(?:PR|AD|広告)\]/gi;

/** Scene-break / decoration (not 長音ー, not linguistic … ・ 。). */
const DECOR_CLASS = "[-–—―─━=_＊*☆★●○◆◇■□▪▫※~～♡♥♪♫#＃▲▼△▽]";

/**
 * Geometry / dingbats / emoji that TTS tends to read as words
 * (くろしかく, ほし, …). Keep in sync with fetchers.js `stripSpeech`.
 * Does not include linguistic punctuation (。・…ー―) or ASCII - = * #.
 */
const NOISY_SYMBOLS = /[\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF※＊＃〓]/g;

function stripNoisySymbols(t) {
  return t
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0E\uFE0F]/g, "")
    .replace(NOISY_SYMBOLS, "");
}

/**
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForSpeech(text) {
  let t = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060]/g, "")
    .replace(/https?:\/\/[^\s]+/gi, " ")
    .replace(/\bwww\.[^\s]+/gi, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, " ")
    .replace(/\[\d+\]/g, "")
    .replace(/※\s*\d+/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(IMAGE_PLACEHOLDER, " ")
    .replace(AD_PLACEHOLDER, " ");

  t = stripNoisySymbols(t);

  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Markdown / ASCII horizontal rules and long symbol runs (---, ***, ===, ━━━)
  t = t
    .replace(/-{3,}/g, " ")
    .replace(/={3,}/g, " ")
    .replace(/~{3,}/g, " ")
    .replace(/～{3,}/g, " ")
    .replace(/\*{3,}/g, " ")
    .replace(/＊{3,}/g, " ")
    .replace(/_{3,}/g, " ")
    .replace(/[─━]{3,}/g, " ")
    .replace(/[―—]{3,}/g, " ")
    .replace(/[☆★●○◆◇■□▪▫※♡♥♪♫]{3,}/g, " ");

  // Markdown heading / quote / fence leftovers
  t = t
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^>[ \t]+/gm, "")
    .replace(/^`{3,}[^\n]*$/gm, "");

  // Markdown table separator rows
  t = t.replace(/^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-+:?[ \t]*\|?[ \t]*$/gm, "");

  // Whitespace-bounded leftover decorations (* * *, ◆ ◆, etc.)
  const boundedDecor = new RegExp(
    `(?:^|\\n)[ \\t]*(?:${DECOR_CLASS}[ \\t]*){2,}(?=\\n|$)`,
    "g",
  );
  t = t.replace(boundedDecor, "\n");

  // After sentence punctuation: ASCII/box/star runs (keep 「。――」 Japanese dash)
  t = t.replace(
    /([。．！？!?）」』】］])[ \t]*[-–─━=_＊*☆★●○◆◇■□▪▫※~～♡♥♪♫#＃▲▼△▽]{2,}[ \t]*/g,
    "$1",
  );
  // 「終わった。 * * * 始まった。」— 3+ spaced decoration tokens
  t = t.replace(
    new RegExp(`([。．！？!?）」』】］])[ \\t]*(?:${DECOR_CLASS}[ \\t]*){3,}`, "g"),
    "$1",
  );

  t = t
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && hasSpeakable(line))
    .join("\n");

  return t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
