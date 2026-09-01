use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceEntry {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 入力時に自動置換（デフォルト OFF）
    #[serde(default)]
    pub auto_replace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingDictEntry {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    pub surface: String,
    /// Extra reading candidates, `/` or `／` separated.
    #[serde(default)]
    pub reading: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Legacy user homograph row. Migrated into `reading` (kind=heteronym) on load.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomographEntry {
    pub id: String,
    pub surface: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub readings: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Dictionaries {
    #[serde(default)]
    pub replace: Vec<ReplaceEntry>,
    #[serde(default)]
    pub reading: Vec<ReadingDictEntry>,
    /// Deprecated: merged into `reading` on load.
    #[serde(default)]
    pub homograph: Vec<HomographEntry>,
    /// Seeded version of default symbol→empty replace entries.
    #[serde(default)]
    pub replace_defaults_version: u32,
}

const REPLACE_DEFAULTS_VERSION: u32 = 1;

/// Decorative symbols TTS tends to read as words. Keep in sync with
/// `DEFAULT_SYMBOL_REPLACE_FROMS` in src/lib/dictionaries.ts.
fn default_symbol_replace_entries() -> Vec<ReplaceEntry> {
    const SYMBOLS: &[&str] = &[
        "■", "□", "▪", "▫", "●", "○", "◆", "◇", "★", "☆", "▲", "▼", "△", "▽", "※", "♪",
        "♫", "♡", "♥", "◎", "〓", "＊", "＃",
    ];
    SYMBOLS
        .iter()
        .map(|from| ReplaceEntry {
            id: format!("default-sym-{from}"),
            from: (*from).to_string(),
            to: String::new(),
            enabled: true,
            auto_replace: false,
        })
        .collect()
}

/// Add missing default symbol→empty replace rows once per version bump.
fn merge_default_symbol_replaces(d: &mut Dictionaries) -> bool {
    if d.replace_defaults_version >= REPLACE_DEFAULTS_VERSION {
        return false;
    }
    let existing: HashSet<String> = d.replace.iter().map(|e| e.from.clone()).collect();
    for e in default_symbol_replace_entries() {
        if e.from.is_empty() || existing.contains(&e.from) {
            continue;
        }
        d.replace.push(e);
    }
    d.replace_defaults_version = REPLACE_DEFAULTS_VERSION;
    true
}

pub fn split_readings(raw: &str) -> Vec<String> {
    raw.split(['/', '／'])
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn join_readings(parts: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for p in parts {
        let t = p.trim();
        if t.is_empty() || !seen.insert(t.to_string()) {
            continue;
        }
        out.push(t.to_string());
    }
    out.join("/")
}

fn upsert_reading(
    d: &mut Dictionaries,
    kind: &str,
    id: String,
    surface: String,
    extras: Vec<String>,
    enabled: bool,
) {
    if let Some(e) = d
        .reading
        .iter_mut()
        .find(|e| e.kind == kind && e.surface == surface)
    {
        let mut parts = split_readings(&e.reading);
        parts.extend(extras);
        e.reading = join_readings(&parts);
        if enabled {
            e.enabled = true;
        }
    } else {
        d.reading.push(ReadingDictEntry {
            id,
            kind: kind.to_string(),
            surface,
            reading: join_readings(&extras),
            enabled,
        });
    }
}

/// Move legacy 同形異音ユーザー辞書 into 読み辞書 (kind=heteronym).
fn migrate_homograph_into_reading(d: &mut Dictionaries) -> bool {
    if d.homograph.is_empty() {
        return false;
    }
    let homo = std::mem::take(&mut d.homograph);
    for e in homo {
        let surface = e.surface.trim().to_string();
        if surface.is_empty() {
            continue;
        }
        upsert_reading(
            d,
            "heteronym",
            e.id,
            surface,
            split_readings(&e.readings),
            e.enabled,
        );
    }
    true
}

pub fn dictionaries_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("irodori-studio")
        .join("dictionaries.json")
}

pub fn load_dictionaries() -> Dictionaries {
    let path = dictionaries_path();
    let mut d = if path.is_file() {
        if let Ok(text) = fs::read_to_string(&path) {
            serde_json::from_str::<Dictionaries>(&text).unwrap_or_default()
        } else {
            Dictionaries::default()
        }
    } else {
        Dictionaries::default()
    };
    let mut mutated = migrate_homograph_into_reading(&mut d);
    mutated = merge_default_symbol_replaces(&mut d) || mutated;
    if mutated {
        let _ = save_dictionaries(&d);
    }
    d
}

pub fn save_dictionaries(dicts: &Dictionaries) -> Result<(), String> {
    let path = dictionaries_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(dicts).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

/// Longest-match-first global replace using enabled dictionary entries (HTTP synth).
pub fn apply_replacements(text: &str, entries: &[ReplaceEntry]) -> String {
    let mut active: Vec<&ReplaceEntry> = entries
        .iter()
        .filter(|e| e.enabled && !e.from.is_empty())
        .collect();
    active.sort_by_key(|e| std::cmp::Reverse(e.from.len()));
    if active.is_empty() {
        return text.to_string();
    }

    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut out = String::new();
    let mut i = 0usize;
    while i < len {
        let suffix: String = chars[i..].iter().collect();
        let mut hit: Option<&ReplaceEntry> = None;
        for e in &active {
            if suffix.starts_with(&e.from) {
                hit = Some(e);
                break;
            }
        }
        if let Some(e) = hit {
            out.push_str(&e.to);
            i += e.from.chars().count();
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Apply all enabled replace entries from loaded dictionaries.
pub fn apply_dict_replacements(text: &str) -> String {
    let dicts = load_dictionaries();
    apply_replacements(text, &dicts.replace)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSpan {
    pub kind: String,
    pub start: usize,
    pub end: usize,
    pub surface: String,
    pub reading: String,
}

/// Unicode code-point span replacement (matches TS `buildSynthText`).
pub fn apply_readings_to_text(text: &str, readings: &[ReadingSpan]) -> String {
    if readings.is_empty() {
        return text.to_string();
    }
    let mut sorted: Vec<&ReadingSpan> = readings
        .iter()
        .filter(|r| !r.reading.trim().is_empty())
        .collect();
    sorted.sort_by_key(|r| std::cmp::Reverse(r.start));
    let mut chars: Vec<char> = text.chars().collect();
    for r in sorted {
        if r.start >= r.end || r.end > chars.len() {
            continue;
        }
        let repl: Vec<char> = r.reading.chars().collect();
        chars.splice(r.start..r.end, repl);
    }
    chars.into_iter().collect()
}

pub fn prepare_synth_text(
    settings: &crate::settings::AppSettings,
    text: &str,
    manual: &[crate::project::AppliedReading],
) -> Result<String, String> {
    let replaced = apply_dict_replacements(text);
    let dicts = load_dictionaries();
    let reading_dict: Vec<crate::asr::ReadingDictPayload> = dicts
        .reading
        .iter()
        .filter(|e| e.enabled && !e.surface.is_empty())
        .map(|e| crate::asr::ReadingDictPayload {
            kind: e.kind.clone(),
            surface: e.surface.clone(),
            reading: e.reading.clone(),
        })
        .collect();
    let manual_json: Vec<serde_json::Value> = manual
        .iter()
        .map(|r| {
            serde_json::json!({
                "start": r.start,
                "end": r.end,
                "surface": r.surface,
                "reading": r.reading,
            })
        })
        .collect();
    let payload = serde_json::json!({
        "text": replaced,
        "manualReadings": manual_json,
        "readingDict": reading_dict,
    });
    let v = crate::asr::run_python_json_script(settings, "auto_readings_apply.py", &payload)?;
    let auto = v
        .get("readings")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let mut all: Vec<ReadingSpan> = manual
        .iter()
        .map(|r| ReadingSpan {
            kind: r.kind.clone(),
            start: r.start,
            end: r.end,
            surface: r.surface.clone(),
            reading: r.reading.clone(),
        })
        .collect();
    for item in auto {
        let start = item.get("start").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
        let end = item.get("end").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
        let reading = item
            .get("reading")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if reading.is_empty() || start >= end {
            continue;
        }
        let overlaps_manual = all
            .iter()
            .any(|m| start < m.end && m.start < end);
        if overlaps_manual {
            continue;
        }
        all.push(ReadingSpan {
            kind: item
                .get("kind")
                .and_then(|x| x.as_str())
                .unwrap_or("english")
                .to_string(),
            start,
            end,
            surface: item
                .get("surface")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            reading,
        });
    }
    Ok(apply_readings_to_text(&replaced, &all))
}
