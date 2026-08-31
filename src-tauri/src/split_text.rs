//! Text splitting for HTTP TTS (pack mode). Mirrors `src/lib/splitText.ts`.

const PRESET_PUNCTUATION: &[&str] = &[
    "。」", "。", "．", "？", "?", "！", "!", "\n",
];
const SECONDARY_PUNCTUATION: &[&str] = &["、", "，", ",", "；", ";", "：", ":"];

pub const DEFAULT_HTTP_MAX_CHARS: usize = 80;
pub const MIN_HTTP_MAX_CHARS: usize = 16;
pub const MAX_HTTP_MAX_CHARS: usize = 500;

pub fn clamp_max_chars(n: usize) -> usize {
    n.clamp(MIN_HTTP_MAX_CHARS, MAX_HTTP_MAX_CHARS)
}

pub fn normalize_max_chars_from_settings(v: u32) -> usize {
    let n = v as usize;
    if n == 0 {
        DEFAULT_HTTP_MAX_CHARS
    } else {
        clamp_max_chars(n)
    }
}

/// Split on delimiters; delimiter stays on the preceding chunk.
fn split_on_delimiters(text: &str, delimiters: &[&str]) -> Vec<String> {
    let trimmed_all = text.trim_start_matches('\u{FEFF}');
    if trimmed_all.trim().is_empty() {
        return Vec::new();
    }
    if delimiters.is_empty() {
        let t = trimmed_all.trim();
        return if t.is_empty() { Vec::new() } else { vec![t.to_string()] };
    }

    let mut unique: Vec<&str> = delimiters
        .iter()
        .copied()
        .filter(|d| !d.is_empty())
        .collect();
    unique.sort_by_key(|d| std::cmp::Reverse(d.len()));
    unique.dedup();

    let mut parts: Vec<String> = Vec::new();
    let mut last = 0usize;
    let chars: Vec<char> = trimmed_all.chars().collect();
    let len = chars.len();
    let mut i = 0usize;
    while i < len {
        let mut matched: Option<usize> = None;
        for d in &unique {
            let dchars: Vec<char> = d.chars().collect();
            if i + dchars.len() <= len && chars[i..i + dchars.len()] == dchars[..] {
                matched = Some(dchars.len());
                break;
            }
        }
        if let Some(dlen) = matched {
            let end = i + dlen;
            let chunk: String = chars[last..end].iter().collect();
            let chunk = chunk.trim().to_string();
            if !chunk.is_empty() {
                parts.push(chunk);
            }
            last = end;
            i = end;
        } else {
            i += 1;
        }
    }
    let rest: String = chars[last..].iter().collect();
    let rest = rest.trim().to_string();
    if !rest.is_empty() {
        parts.push(rest);
    }
    parts
}

fn pack_parts(parts: &[String], pack_limit: usize) -> Vec<String> {
    if pack_limit == 0 {
        return parts.to_vec();
    }
    let mut packed: Vec<String> = Vec::new();
    let mut buf = String::new();
    for p in parts {
        if buf.is_empty() {
            buf = p.clone();
            continue;
        }
        if buf.chars().count() + p.chars().count() <= pack_limit {
            buf.push_str(p);
        } else {
            packed.push(buf);
            buf = p.clone();
        }
    }
    if !buf.is_empty() {
        packed.push(buf);
    }
    packed
}

fn char_count(s: &str) -> usize {
    s.chars().count()
}

/// Force-split a single chunk longer than `max_chars` at char boundaries.
fn force_split_long(chunk: &str, max_chars: usize) -> Vec<String> {
    let t = chunk.trim();
    if t.is_empty() {
        return Vec::new();
    }
    if char_count(t) <= max_chars {
        return vec![t.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    for ch in t.chars() {
        buf.push(ch);
        if char_count(&buf) >= max_chars {
            out.push(buf.trim().to_string());
            buf.clear();
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf.trim().to_string());
    }
    out
}

fn split_oversized(parts: Vec<String>, max_chars: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in parts {
        if char_count(&p) <= max_chars {
            out.push(p);
            continue;
        }
        let secondary = split_on_delimiters(&p, SECONDARY_PUNCTUATION);
        let repacked = pack_parts(&secondary, max_chars);
        for r in repacked {
            if char_count(&r) <= max_chars {
                if !r.trim().is_empty() {
                    out.push(r);
                }
            } else {
                out.extend(force_split_long(&r, max_chars));
            }
        }
    }
    out
}

/// Pack-mode split for speech synthesis (primary sentence boundaries).
pub fn split_for_speech(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = if max_chars == 0 {
        DEFAULT_HTTP_MAX_CHARS
    } else {
        max_chars
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let parts = split_on_delimiters(trimmed, PRESET_PUNCTUATION);
    if parts.is_empty() {
        return Vec::new();
    }
    let packed = pack_parts(&parts, max_chars);
    split_oversized(packed, max_chars)
        .into_iter()
        .filter(|c| has_speakable(c))
        .collect()
}

fn has_speakable(s: &str) -> bool {
    s.chars().any(|c| !c.is_whitespace())
}

/// Prepare synthesis chunks from raw text.
pub fn prepare_chunks(text: &str, split: bool, max_chars: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if split {
        split_for_speech(trimmed, max_chars)
    } else {
        vec![trimmed.to_string()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_joins_short_sentences() {
        let text = "あいう。かきく。さしす。";
        let chunks = split_for_speech(text, 80);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].contains('あ'));
    }

    #[test]
    fn splits_when_over_limit() {
        let text = "あいうえおかきくけこ";
        let chunks = split_for_speech(text, 5);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn no_split_returns_whole() {
        let chunks = prepare_chunks("こんにちは", false, 80);
        assert_eq!(chunks, vec!["こんにちは"]);
    }
}
