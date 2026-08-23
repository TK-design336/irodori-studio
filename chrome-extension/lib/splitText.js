/** Split text like Studio src/lib/splitText.ts (pack mode). */

import { hasSpeakable, sanitizeForSpeech } from "./sanitizeSpeech.js";

export { hasSpeakable, sanitizeForSpeech } from "./sanitizeSpeech.js";

export const PRESET_PUNCTUATION = ["。」", "。", "．", "？", "?", "！", "!", "\n"];

export const DEFAULT_CHUNK_CHARS = 60;
export const MIN_CHUNK_CHARS = 16;
export const MAX_CHUNK_CHARS = 120;

export function clampChunkChars(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_CHUNK_CHARS;
  return Math.min(MAX_CHUNK_CHARS, Math.max(MIN_CHUNK_CHARS, v));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} text
 * @param {string[]} delimiters
 * @param {"strict"|"pack"} mode
 * @param {number} packLimit
 * @returns {string[]}
 */
export function splitText(text, delimiters, mode = "pack", packLimit = DEFAULT_CHUNK_CHARS) {
  const trimmedAll = text.replace(/^\uFEFF/, "");
  if (!trimmedAll.trim()) return [];

  if (!delimiters || delimiters.length === 0) {
    const t = trimmedAll.trim();
    return t ? [t] : [];
  }

  const unique = [...new Set(delimiters.filter((d) => d.length > 0))];
  const escaped = unique
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  const re = new RegExp(`(${escaped.join("|")})`, "g");

  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(trimmedAll)) !== null) {
    const end = m.index + m[0].length;
    const chunk = trimmedAll.slice(last, end).trim();
    if (chunk) parts.push(chunk);
    last = end;
  }
  const rest = trimmedAll.slice(last).trim();
  if (rest) parts.push(rest);

  if (mode === "strict" || packLimit <= 0) return parts;

  const packed = [];
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

/** Merge extremely short chunks into neighbors. Skip unspeakable leftovers. */
function mergeShort(chunks, minLen = 8) {
  if (chunks.length <= 1) return chunks.filter((c) => hasSpeakable(c));
  const out = [];
  for (const c of chunks) {
    if (!hasSpeakable(c)) continue;
    if (out.length && c.length < minLen) {
      out[out.length - 1] += c;
    } else if (out.length && out[out.length - 1].length < minLen) {
      out[out.length - 1] += c;
    } else {
      out.push(c);
    }
  }
  return out;
}

export function splitForSpeech(text, packLimit = DEFAULT_CHUNK_CHARS) {
  const cleaned = sanitizeForSpeech(text);
  if (!cleaned) return [];
  const limit = clampChunkChars(packLimit);
  return mergeShort(splitText(cleaned, PRESET_PUNCTUATION, "pack", limit))
    .map((c) => sanitizeForSpeech(c))
    .filter((c) => c && hasSpeakable(c));
}
