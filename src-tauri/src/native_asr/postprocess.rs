//! Filler removal, katakana technical term → Latin normalization, and Japanese
//! sentence punctuation **only on finalized utterances** (Parapper
//! `delivery/common/text_format.rs`: join segments without trailing punct, then
//! `finalize_turn_text` adds `。` once).

/// Must stay in sync with `src/lib/voice/asrFiller.ts` → `ASR_FILLER_PHRASES`.
const FILLERS: &[&str] = &[
    "えーっと",
    "えっと",
    "えー",
    "ええ",
    "え",
    "あのう",
    "あのー",
    "あの",
    "まぁ",
    "まあ",
    "なんか",
    "その",
    "うーん",
    "んー",
    "んん",
];

const PUNCT_CHARS: &[char] = &['。', '！', '？', '、', '．', '.', '!', '?', '…', '‥'];

/// Per-segment cleanup before joining into a running draft (no terminal `。`).
pub fn postprocess_asr_segment_for_join(raw: &str) -> String {
    let s = remove_fillers(raw);
    normalize_tech_katakana(&s).trim().to_string()
}

/// Trim trailing punctuation that must not sit between joined Japanese segments
/// (Parapper `trim_japanese_sentence_end`).
fn trim_japanese_sentence_end_for_join(text: &str) -> &str {
    text.trim_end_matches(['。', '．', '、', '！', '？', '.', '!', '?', '…', '‥'])
}

/// Append a new ASR segment to `draft` (Parapper `join_turn_segments` for Japanese).
pub fn append_japanese_asr_segment(draft: &mut String, segment_joinable: &str) {
    let seg = segment_joinable.trim();
    if seg.is_empty() {
        return;
    }
    if draft.is_empty() {
        draft.push_str(seg);
        return;
    }
    let base = trim_japanese_sentence_end_for_join(draft.trim_end()).to_string();
    draft.clear();
    draft.push_str(&base);
    draft.push_str(seg);
}

fn trim_continuation_marker(text: &str) -> &str {
    text.trim_end_matches("...")
}

/// Live interim display: trim only, no terminal `。`.
pub fn interim_japanese_utterance_text(combined: &str) -> String {
    trim_continuation_marker(combined.trim()).to_string()
}

/// Final display string for one utterance (Parapper `finalize_turn_text` for Japanese).
pub fn finalize_japanese_utterance_text(combined: &str) -> String {
    let text = trim_continuation_marker(combined.trim());
    if text.is_empty() {
        return String::new();
    }
    if has_japanese_sentence_end(text) {
        return text.to_string();
    }
    format!("{text}。")
}

fn has_japanese_sentence_end(text: &str) -> bool {
    text.chars()
        .last()
        .is_some_and(|c| matches!(c, '。' | '！' | '？'))
}

/// True when trimmed text ends with a known filler phrase.
#[allow(dead_code)]
pub fn ends_with_filler(s: &str) -> bool {
    let t = s.trim_end();
    if t.is_empty() {
        return false;
    }
    let mut fillers: Vec<&str> = FILLERS.to_vec();
    fillers.sort_by(|a, b| b.len().cmp(&a.len()));
    fillers.iter().any(|f| t.ends_with(f))
}

/// One-shot: segment cleanup + sentence-final `。`（単体テスト用）。
#[cfg(test)]
fn postprocess_asr_text(raw: &str) -> String {
    finalize_japanese_utterance_text(&postprocess_asr_segment_for_join(raw))
}

fn remove_fillers(s: &str) -> String {
    let mut t = s.to_string();
    for _ in 0..8 {
        let before = t.clone();
        t = strip_fillers_pass(&t);
        if t == before {
            break;
        }
    }
    t.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn strip_fillers_pass(input: &str) -> String {
    let mut fillers: Vec<&str> = FILLERS.to_vec();
    fillers.sort_by(|a, b| b.len().cmp(&a.len()));

    let mut t = input.to_string();
    for f in fillers {
        let pad = format!(" {f} ");
        while t.contains(&pad) {
            t = t.replace(&pad, " ");
        }
        let start_spaced = format!("{f} ");
        if t.starts_with(&start_spaced) {
            t = t[start_spaced.len()..].to_string();
        }
        let end_spaced = format!(" {f}");
        if t.ends_with(&end_spaced) {
            let n = t.len().saturating_sub(end_spaced.len());
            t = t[..n].to_string();
        }
        while t.starts_with(f) {
            t = t[f.len()..].to_string();
        }
        while t.ends_with(f) {
            let n = t.len().saturating_sub(f.len());
            t = t[..n].to_string();
        }
        for p in PUNCT_CHARS {
            let needle = format!("{f}{p}");
            let punct = p.to_string();
            while t.contains(&needle) {
                t = t.replace(&needle, &punct);
            }
        }
        if t == f {
            t.clear();
        }
    }
    t
}

fn normalize_tech_katakana(s: &str) -> String {
    let mut out = s.to_string();
    let pairs: &[(&str, &str)] = &[
        ("タイプスクリプト", "TypeScript"),
        ("ジャバスクリプト", "JavaScript"),
        ("リアクト", "React"),
        ("タウリ", "Tauri"),
        ("ビーエスコード", "VS Code"),
        ("ブイエスコード", "VS Code"),
        ("エーピーアイ", "API"),
        ("ジーエヌユー", "GNU"),
        ("エルエルエム", "LLM"),
        ("シーエスエス", "CSS"),
        ("エイチティーエムエル", "HTML"),
        ("ジーエスピー", "GSP"),
        ("ピーエイチピー", "PHP"),
        ("エスキューエル", "SQL"),
        ("ジェイソン", "JSON"),
        ("オーエス", "OS"),
        ("ユーアイ", "UI"),
        ("ユーエックス", "UX"),
        ("ディーエヌエス", "DNS"),
        ("ティーエルエス", "TLS"),
        ("エスエスエル", "SSL"),
        ("エイチティーティーピー", "HTTP"),
        ("エイチティーティーピーエス", "HTTPS"),
        ("ジット", "Git"),
        ("ドッカー", "Docker"),
        ("クボネティス", "Kubernetes"),
        ("パイソン", "Python"),
        ("ルビー", "Ruby"),
        ("シープラスプラス", "C++"),
        ("シーシャープ", "C#"),
        ("ジェイディーケー", "JDK"),
        ("ジェイブイエム", "JVM"),
    ];
    for (katakana, latin) in pairs {
        if out.contains(katakana) {
            out = out.replace(katakana, latin);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_katakana_ts() {
        assert!(postprocess_asr_text("タイプスクリプトで書く").contains("TypeScript"));
    }

    #[test]
    fn appends_period_when_missing() {
        assert_eq!(postprocess_asr_text("今日はいい天気"), "今日はいい天気。");
    }

    #[test]
    fn keeps_existing_period() {
        assert_eq!(postprocess_asr_text("今日はいい天気。"), "今日はいい天気。");
    }

    #[test]
    fn keeps_question_mark() {
        assert_eq!(postprocess_asr_text("本当ですか？"), "本当ですか？");
    }

    #[test]
    fn join_japanese_segments_like_parapper() {
        let mut d = String::new();
        append_japanese_asr_segment(&mut d, &postprocess_asr_segment_for_join("今日は"));
        append_japanese_asr_segment(&mut d, &postprocess_asr_segment_for_join("いい天気です"));
        assert_eq!(d, "今日はいい天気です");
        assert_eq!(finalize_japanese_utterance_text(&d), "今日はいい天気です。");
    }

    #[test]
    fn strips_filler_prefix_without_spaces() {
        assert_eq!(
            postprocess_asr_segment_for_join("えーと今日は"),
            "と今日は"
        );
    }

    #[test]
    fn strips_filler_suffix_without_spaces() {
        assert_eq!(
            postprocess_asr_segment_for_join("今日はえー"),
            "今日は"
        );
    }

    #[test]
    fn strips_filler_before_punctuation() {
        assert_eq!(
            postprocess_asr_segment_for_join("今日はえー、天気"),
            "今日は、天気"
        );
    }

    #[test]
    fn ends_with_filler_detects_trailing_phrase() {
        assert!(ends_with_filler("本日はえー"));
        assert!(!ends_with_filler("本日は晴れ"));
    }

    #[test]
    fn filler_only_becomes_empty() {
        assert_eq!(postprocess_asr_segment_for_join("えー"), "");
        assert_eq!(postprocess_asr_segment_for_join(" えー んー "), "");
    }
}
