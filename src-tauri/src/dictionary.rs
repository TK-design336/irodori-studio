use serde::{Deserialize, Serialize};
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
    if migrate_homograph_into_reading(&mut d) {
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
